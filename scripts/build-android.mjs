/**
 * Build what the Android app carries: the programs, their libraries, npm, and
 * the manager itself.
 *
 * An Android app may start programs only from its native library directory,
 * and only files named `lib*.so` are installed there. So the programs the
 * manager starts - node, git, git's HTTPS helper and cloudflared - go in
 * `jniLibs/<abi>/` under such names, and everything they load goes
 * into `runtime.tar`, which the app unpacks into its own storage and points
 * `LD_LIBRARY_PATH` at. Loading a library from there is allowed; starting a
 * program from there is not.
 *
 * The programs are Termux's builds, which are made for Android and run outside
 * Termux once their library path is supplied. Every package is pinned in
 * `packaging/android/runtime-packages.json` by file and SHA-256, and npm by its
 * registry integrity, so a build never picks up bytes nobody chose. Termux's
 * mirror keeps only current builds, so a pin eventually stops downloading;
 * `--refresh` rewrites the pins from the mirror as it is now.
 *
 * Tar archives are read and written here rather than by a tar program: Termux's
 * packages are full of library symlinks, which Windows' tar cannot recreate,
 * and the app unpacks the result itself, symlinks and all.
 *
 * Usage:
 *   node scripts/build-android.mjs [--abi arm64-v8a|x86_64] [--skip-manager] [--apk]
 *   node scripts/build-android.mjs --refresh
 *
 * `--apk` goes on to build the APK with the Gradle wrapper, which needs a JDK
 * 17 and the Android SDK (ANDROID_HOME, or sdk.dir in local.properties).
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, posix, relative, resolve } from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const androidRoot = join(repositoryRoot, 'packaging', 'android');
const pinsPath = join(androidRoot, 'runtime-packages.json');
const cacheRoot = join(repositoryRoot, 'build', 'cache', 'android');
const mainRoot = join(androidRoot, 'app', 'src', 'main');

/** Android ABI name to Termux architecture. */
const ARCHITECTURES = { 'arm64-v8a': 'aarch64', x86_64: 'x86_64' };
/**
 * Packages the app needs; their dependencies are resolved from the index.
 * termux-licenses holds the license texts the others' copyright files link to.
 */
const ROOTS = ['nodejs-lts', 'git', 'ca-certificates', 'cloudflared', 'termux-licenses'];
/** Dependencies that only matter to an interactive shell. */
const NOT_NEEDED = new Set(['less', 'bash', 'dash', 'termux-tools', 'termux-exec', 'resolv-conf', 'ncurses', 'command-not-found', 'termux-am', 'termux-am-socket']);
const TERMUX_USR = 'data/data/com.termux/files/usr/';
/** Programs the app starts, by where Termux puts them and the name they get in jniLibs. */
const PROGRAMS = {
  'bin/node': 'libnode.so',
  'bin/git': 'libgit.so',
  'libexec/git-core/git-remote-http': 'libgit_remote_http.so',
  'bin/cloudflared': 'libcloudflared.so',
};

const argv = process.argv.slice(2);
const option = (name) => { const at = argv.indexOf(name); return at === -1 ? undefined : argv[at + 1]; };

if (argv.includes('--refresh')) await refreshPins();
else {
  const abi = option('--abi') ?? 'arm64-v8a';
  await build(abi, !argv.includes('--skip-manager'));
  if (argv.includes('--apk')) await assemble(abi);
}

// ---------------------------------------------------------------- pins

async function refreshPins() {
  const existing = existsSync(pinsPath) ? JSON.parse(await readFile(pinsPath, 'utf8')) : {};
  const mirror = existing.mirror ?? 'https://packages-cf.termux.dev/apt/termux-main';
  const architectures = {};
  for (const arch of Object.values(ARCHITECTURES)) {
    const index = parseIndex(await download(`${mirror}/dists/stable/main/binary-${arch}/Packages`));
    const wanted = new Map();
    const visit = (name) => {
      if (wanted.has(name) || NOT_NEEDED.has(name)) return;
      const entry = index.get(name);
      if (!entry) throw new Error(`${arch}: the index has no package ${name}`);
      wanted.set(name, entry);
      for (const dependency of (entry.Depends ?? '').split(',').map((part) => part.trim().split(/[\s(|]/u)[0]).filter(Boolean)) visit(dependency);
    };
    ROOTS.forEach(visit);
    architectures[arch] = Object.fromEntries([...wanted].sort(([a], [b]) => a.localeCompare(b)).map(([name, entry]) => [name, { version: entry.Version, filename: entry.Filename, sha256: entry.SHA256 }]));
  }
  // npm is not in Termux's Node package; the release that ships with this Node major is.
  const nodeMajor = Number(architectures.aarch64['nodejs-lts'].version.split('.')[0]);
  const npmMajor = nodeMajor >= 24 ? 11 : 10;
  const npmVersions = JSON.parse((await download(`https://registry.npmjs.org/npm`)).toString('utf8'));
  const npmVersion = Object.keys(npmVersions.versions).filter((version) => /^\d+\.\d+\.\d+$/u.test(version) && Number(version.split('.')[0]) === npmMajor)
    .sort((a, b) => compareVersions(b, a))[0];
  const npm = { version: npmVersion, tarball: npmVersions.versions[npmVersion].dist.tarball, integrity: npmVersions.versions[npmVersion].dist.integrity };
  const pins = { mirror, roots: ROOTS, npm, architectures };
  await writeFile(pinsPath, `${JSON.stringify(pins, null, 2)}\n`, 'utf8');
  console.log(`[android] pinned ${Object.keys(architectures.aarch64).length} packages per architecture and npm ${npm.version}`);
}

function parseIndex(bytes) {
  const index = new Map();
  for (const block of bytes.toString('utf8').split(/\n\n+/u)) {
    const fields = {};
    for (const line of block.split('\n')) {
      const match = /^([A-Za-z0-9-]+): (.*)$/u.exec(line);
      if (match) fields[match[1]] = match[2];
    }
    if (fields.Package) index.set(fields.Package, fields);
  }
  return index;
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

// ---------------------------------------------------------------- build

async function build(abi, withManager) {
  const arch = ARCHITECTURES[abi];
  if (!arch) throw new Error(`Unknown ABI ${abi}; expected one of ${Object.keys(ARCHITECTURES).join(', ')}`);
  const pins = JSON.parse(await readFile(pinsPath, 'utf8'));
  const packages = pins.architectures[arch];
  const jniRoot = join(mainRoot, 'jniLibs');
  const assetsRoot = join(mainRoot, 'assets');
  await rm(jniRoot, { recursive: true, force: true });
  await mkdir(join(jniRoot, abi), { recursive: true });
  await mkdir(assetsRoot, { recursive: true });

  const runtime = [];
  const programs = new Map();
  for (const [name, pin] of Object.entries(packages)) {
    const deb = await cached(`${pins.mirror}/${pin.filename}`, pin.filename.split('/').pop(), 'sha256', pin.sha256);
    for (const entry of readTar(debData(deb))) {
      const path = entry.name.replace(/^\.\//u, '');
      if (!path.startsWith(TERMUX_USR)) continue;
      const inside = path.slice(TERMUX_USR.length);
      if (PROGRAMS[inside]) {
        if (entry.type !== 'file') throw new Error(`${name}: ${inside} is not a regular file`);
        programs.set(PROGRAMS[inside], entry.data);
      } else if (/^lib\/[^/]+\.so(\.[0-9.]+)?$/u.test(inside) || inside === 'etc/tls/cert.pem'
        // Each package's copyright and the license texts they point at travel
        // with the programs they cover.
        || /^share\/doc\/[^/]+\/(copyright|LICEN[CS]E[^/]*)$/u.test(inside) || /^share\/LICENSES\/[^/]+$/u.test(inside)) {
        runtime.push({ ...entry, name: inside });
      }
    }
  }
  for (const [inside, library] of Object.entries(PROGRAMS)) {
    if (!programs.has(library)) throw new Error(`No package provided ${inside}`);
    await writeFile(join(jniRoot, abi, library), programs.get(library));
  }

  const npmArchive = await cached(pins.npm.tarball, `npm-${pins.npm.version}.tgz`, 'sha512', Buffer.from(pins.npm.integrity.replace(/^sha512-/u, ''), 'base64').toString('hex'));
  for (const entry of readTar(gunzipSync(npmArchive))) {
    if (!entry.name.startsWith('package/') || entry.type === 'other') continue;
    runtime.push({ ...entry, name: `npm/${entry.name.slice('package/'.length)}` });
  }
  const runtimeTar = writeTar(runtime);
  await writeFile(join(assetsRoot, 'runtime.tar'), runtimeTar);

  let managerHash = null;
  if (withManager) {
    run(process.execPath, [join(repositoryRoot, 'scripts', 'build-npm-package.mjs')]);
    const packageRoot = join(repositoryRoot, 'build', 'npm', 'package');
    const managerTar = writeTar(await filesUnder(packageRoot));
    await writeFile(join(assetsRoot, 'manager.tar'), managerTar);
    managerHash = sha('sha256', managerTar);
  } else if (existsSync(join(assetsRoot, 'manager.tar'))) {
    managerHash = sha('sha256', await readFile(join(assetsRoot, 'manager.tar')));
  } else {
    throw new Error('--skip-manager needs a manager.tar from an earlier build');
  }

  // The app unpacks an archive again only when its hash changes, so an update
  // that did not touch the runtime does not spend a minute rewriting it.
  const bundle = {
    abi,
    runtime: sha('sha256', runtimeTar),
    manager: managerHash,
    node: packages['nodejs-lts'].version,
    git: packages.git.version,
    cloudflared: packages.cloudflared.version,
    npm: pins.npm.version,
  };
  await writeFile(join(assetsRoot, 'bundle.json'), `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
  console.log(`[android] ${abi}: runtime ${(runtimeTar.length / 1048576).toFixed(1)} MB, node ${bundle.node}, git ${bundle.git}, cloudflared ${bundle.cloudflared}, npm ${bundle.npm}`);
}

/**
 * Build the release APK with the Gradle wrapper and put it beside the other
 * release files. Signed with the release key when STM_ANDROID_KEYSTORE is set,
 * and with the debug key otherwise.
 */
async function assemble(abi) {
  const windows = process.platform === 'win32';
  const wrapper = join(androidRoot, windows ? 'gradlew.bat' : 'gradlew');
  const result = spawnSync(wrapper, ['assembleRelease', '--console=plain'], { cwd: androidRoot, stdio: 'inherit', shell: windows });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Gradle failed with exit code ${result.status ?? 'unknown'}`);
  const version = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8')).version;
  const target = join(repositoryRoot, 'build', `SillyTavernManager-android-${abi}-v${version}.apk`);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, await readFile(join(androidRoot, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')));
  console.log(`[android] ${relative(repositoryRoot, target)}`);
}

async function cached(url, name, algorithm, expected) {
  const path = join(cacheRoot, name);
  if (existsSync(path)) {
    const bytes = await readFile(path);
    if (sha(algorithm, bytes) === expected) return bytes;
  }
  const bytes = await download(url);
  const actual = sha(algorithm, bytes);
  if (actual !== expected) throw new Error(`${name}: ${algorithm} mismatch, expected ${expected}, got ${actual}`);
  await mkdir(cacheRoot, { recursive: true });
  await writeFile(path, bytes);
  return bytes;
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}${response.status === 404 ? ' (the mirror no longer has this build; run with --refresh)' : ''}`);
  return Buffer.from(await response.arrayBuffer());
}

function sha(algorithm, bytes) {
  return createHash(algorithm).update(bytes).digest('hex');
}

/** The data archive inside a .deb, decompressed. A .deb is an `ar` archive. */
function debData(deb) {
  if (deb.subarray(0, 8).toString('latin1') !== '!<arch>\n') throw new Error('not a .deb');
  for (let offset = 8; offset < deb.length;) {
    const header = deb.subarray(offset, offset + 60).toString('latin1');
    const name = header.slice(0, 16).trim().replace(/\/$/u, '');
    const size = Number(header.slice(48, 58).trim());
    const body = deb.subarray(offset + 60, offset + 60 + size);
    if (name === 'data.tar.xz') return unxz(body);
    if (name === 'data.tar.gz') return gunzipSync(body);
    if (name === 'data.tar') return body;
    offset += 60 + size + (size % 2);
  }
  throw new Error('.deb without a data archive');
}

function unxz(bytes) {
  // Node has no xz decoder. Linux has xz; on Windows, Git for Windows carries one.
  const candidates = [process.env.XZ, 'xz', 'C:\\Program Files\\Git\\mingw64\\bin\\xz.exe', 'C:\\Program Files\\Git\\usr\\bin\\xz.exe'].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['-dc'], { input: bytes, maxBuffer: 1 << 30 });
    if (!result.error && result.status === 0) return result.stdout;
  }
  throw new Error('xz is needed to unpack Termux packages; install it or set XZ to its path');
}

// ---------------------------------------------------------------- tar

function readTar(buffer) {
  const entries = [];
  let pax = {};
  let longName = null;
  let longLink = null;
  for (let offset = 0; offset + 512 <= buffer.length;) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/su, '');
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const data = buffer.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') { pax = parsePax(data); continue; }
    if (type === 'g') continue;
    if (type === 'L') { longName = data.toString('utf8').replace(/\0.*$/su, ''); continue; }
    if (type === 'K') { longLink = data.toString('utf8').replace(/\0.*$/su, ''); continue; }
    const prefix = field(345, 155);
    const name = pax.path ?? longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    const linkname = pax.linkpath ?? longLink ?? field(157, 100);
    const mode = parseInt(field(100, 8).trim() || '644', 8);
    pax = {}; longName = null; longLink = null;
    if (type === '0' || type === '\0' || type === '7') entries.push({ name, type: 'file', mode, data: Buffer.from(data) });
    else if (type === '2') entries.push({ name, type: 'symlink', mode, linkname });
    else if (type === '5') entries.push({ name, type: 'directory', mode });
    else entries.push({ name, type: 'other' });
  }
  return entries;
}

function parsePax(data) {
  const records = {};
  let text = data.toString('utf8');
  while (text.length > 0) {
    const space = text.indexOf(' ');
    const length = Number(text.slice(0, space));
    if (!length) break;
    const record = text.slice(space + 1, length - 1);
    const equals = record.indexOf('=');
    records[record.slice(0, equals)] = record.slice(equals + 1);
    text = text.slice(length);
  }
  return records;
}

/** A POSIX tar of regular files and symlinks, with directories implied by their paths. */
function writeTar(entries) {
  const blocks = [];
  const seen = new Set();
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.type !== 'file' && entry.type !== 'symlink') continue;
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    const data = entry.type === 'file' ? entry.data : Buffer.alloc(0);
    const executable = entry.type === 'file' && (entry.mode & 0o111) !== 0;
    const split = splitName(entry.name);
    if (!split || Buffer.byteLength(entry.linkname ?? '') > 100) {
      const records = [`path=${entry.name}`, ...(entry.linkname ? [`linkpath=${entry.linkname}`] : [])].map(paxRecord).join('');
      const body = Buffer.from(records, 'utf8');
      blocks.push(header({ name: 'PaxHeader', size: body.length, type: 'x', mode: 0o644 }), pad(body));
    }
    blocks.push(header({
      name: split?.name ?? entry.name.slice(-100),
      prefix: split?.prefix ?? '',
      size: data.length,
      type: entry.type === 'file' ? '0' : '2',
      mode: entry.type === 'symlink' ? 0o777 : executable ? 0o755 : 0o644,
      linkname: entry.linkname && Buffer.byteLength(entry.linkname) <= 100 ? entry.linkname : '',
    }));
    if (data.length) blocks.push(pad(data));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function splitName(name) {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: '' };
  for (let at = name.indexOf('/'); at !== -1; at = name.indexOf('/', at + 1)) {
    const prefix = name.slice(0, at);
    const rest = name.slice(at + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100) return { name: rest, prefix };
  }
  return null;
}

function paxRecord(record) {
  const body = ` ${record}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) length = String(length).length + Buffer.byteLength(body);
  return `${length}${body}`;
}

function header({ name, prefix = '', size, type, mode, linkname = '' }) {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'utf8');
  block.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8, 'latin1');
  block.write('0000000\0', 108, 8, 'latin1');
  block.write('0000000\0', 116, 8, 'latin1');
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'latin1');
  block.write('00000000000\0', 136, 12, 'latin1');
  block.write('        ', 148, 8, 'latin1');
  block.write(type, 156, 1, 'latin1');
  block.write(linkname, 157, 100, 'utf8');
  block.write('ustar\0', 257, 6, 'latin1');
  block.write('00', 263, 2, 'latin1');
  block.write(prefix, 345, 155, 'utf8');
  let checksum = 0;
  for (const byte of block) checksum += byte;
  block.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
  return block;
}

function pad(data) {
  const remainder = data.length % 512;
  return remainder === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - remainder)]);
}

async function filesUnder(root) {
  const entries = [];
  const visit = async (directory) => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      const name = relative(root, path).split('\\').join(posix.sep);
      if (item.isDirectory()) {
        // Command shims npm writes for its own use; nothing here runs them.
        if (item.name === '.bin') continue;
        await visit(path);
      } else if (item.isFile()) {
        entries.push({ name, type: 'file', mode: (await stat(path)).mode, data: await readFile(path) });
      }
    }
  };
  await visit(root);
  return entries;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repositoryRoot, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}`);
}
