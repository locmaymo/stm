import { ISSUES, RELEASES, REPOSITORY, UPSTREAM } from './strings.mjs';

/**
 * The documentation, in both languages.
 *
 * Written as blocks rather than as markup so the two languages cannot drift
 * into different shapes: the build compares them before it renders, and a
 * section that gained a step in English and not in Vietnamese fails the build
 * rather than quietly shipping a shorter page.
 *
 * Commands are referenced by name from `snippets.mjs` and never written here.
 * A shell line is the same in every language, and one copied into two content
 * files is one that will eventually be fixed in only one of them.
 *
 * Block types: `p`, `list`, `steps`, `code`, `note`, `table`, `shot`, `keys`.
 */

const p = (...items) => items.map((body) => ({ type: 'p', body }));
const code = (snippet, caption) => ({ type: 'code', snippet, ...(caption ? { caption } : {}) });
const note = (tone, body) => ({ type: 'note', tone, body });

export const docs = {
  en: {
    title: 'Documentation',
    description: 'Install, run, share, back up and troubleshoot SillyTavern Manager on Windows, Android, macOS, Linux, Docker and npm.',
    heading: 'Documentation',
    lede: 'Everything from a first install to a restore on a new machine. Pick a platform, follow it to Ready, and come back for the rest when you need it.',
    tocLabel: 'On this page',
    sections: [
      {
        id: 'start',
        icon: 'info',
        title: 'Before you begin',
        blocks: [
          ...p(
            `SillyTavern Manager installs and runs [SillyTavern](${UPSTREAM}) for you. It is not SillyTavern, and it is not made by the people who make SillyTavern — it clones their public repository onto your machine, at your request, and manages what it finds there.`,
            'You will need: a machine you control, about 2 GB of free disk for SillyTavern and its dependencies, and an internet connection for the first install. Everything after that can run offline except the model providers SillyTavern talks to.',
          ),
          {
            type: 'table',
            columns: ['Platform', 'What you need', 'Where to start'],
            rows: [
              ['Windows 10 or 11', 'Nothing. Node.js is inside the download.', '[Windows](#windows)'],
              ['Android 7+', 'Termux from F-Droid', '[Termux](#android)'],
              ['macOS 13+', 'Homebrew and Node.js 22+', '[macOS](#macos)'],
              ['Linux or a VPS', 'Node.js 22+ and git', '[Linux](#linux)'],
              ['Any Docker host', 'Docker, and a volume for `/data`', '[Docker](#docker)'],
              ['Anything with Node 22+', 'npm 11+', '[npm](#npm)'],
            ],
          },
          note('info', 'The manager and SillyTavern use three ports: `7860` for the panel, `8002` for SillyTavern and `8001` for the access gateway. If something else on the machine already holds one of them, see [Troubleshooting](#trouble).'),
        ],
      },
      {
        id: 'install',
        icon: 'download',
        title: 'Installing',
        blocks: p('Six ways in, all ending at the same place: a panel on port `7860` asking you to choose an administrator password.'),
        subsections: [
          {
            id: 'windows',
            title: 'Windows — download and run',
            blocks: [
              {
                type: 'steps',
                items: [
                  `Open the [latest release](${RELEASES}).`,
                  'Download `SillyTavernManager-windows-x64-vX.Y.Z.zip` and the `.sha256` file beside it.',
                  'Extract the ZIP into a normal folder, such as `Downloads\\SillyTavernManager`. Do not run it from inside the ZIP.',
                  'Double-click `SillyTavernManager.exe`.',
                  'The browser should open by itself. If it does not, go to `http://127.0.0.1:7860`.',
                ],
              },
              ...p(
                'A console window opens and stays open. That window **is** the manager: it prints the address, where your data is kept, and what the manager and SillyTavern are doing. Closing it stops everything cleanly — SillyTavern and the Cloudflare tunnel go down with it, so no port is left held and there is nothing to hunt for in Task Manager.',
                'Press **Q** or **Ctrl+C** in that window to stop, and **O** to open the panel in your browser again.',
              ),
              note('good', 'The application folder and the data folder are separate. Your data lives in `%LOCALAPPDATA%\\SillyTavernManager`, so replacing the ZIP with a newer one never touches profiles, backups or settings.'),
              note('warn', 'If SmartScreen warns about an unsigned application, that is expected: release builds are not code-signed. Check the `.sha256` file against the ZIP if you want to be certain the download is the one the release published.'),
            ],
          },
          {
            id: 'android',
            title: 'Android — Termux',
            blocks: [
              ...p(
                'Install [Termux from F-Droid](https://f-droid.org/packages/com.termux/) or another trusted source. **Do not use the old Play Store build** — it is years out of date and its package manager no longer works.',
                'Open Termux and paste these commands. Give the first two a minute each; they update Termux itself.',
              ),
              code('termuxInstall'),
              ...p(
                'Leave that Termux session running while SillyTavern is in use. On the phone, the manager is at `http://127.0.0.1:7860` and SillyTavern at `http://127.0.0.1:8002`.',
                'Starting it again later:',
              ),
              code('termuxStart'),
              ...p('Updating the manager, after stopping it with **Ctrl+C**:'),
              code('termuxUpdate'),
              note('good', 'Termux keeps your data at `$PREFIX/var/sillytavern-manager`, outside the repository, so `git pull` never touches it.'),
              note('info', 'Turning the tunnel on needs nothing installed by hand. Android only starts position-independent executables and Cloudflare’s own builds are not, so the manager asks Termux for its build of `cloudflared` first and falls back to running Cloudflare’s under `proot`, installing whichever it needs.'),
            ],
          },
          {
            id: 'macos',
            title: 'macOS — from source',
            blocks: [
              ...p('macOS uses the same launcher as Linux. Paste this into Terminal; the first line installs Homebrew and can be skipped if you already have it.'),
              code('macosInstall'),
              ...p('Open `http://127.0.0.1:7860`. Stop with **Ctrl+C**, and start it again later with:'),
              code('macosStart'),
              note('info', 'Data is kept under `~/.local/share/sillytavern-manager`. Apple Silicon and Intel are both fine; nothing here needs Rosetta.'),
            ],
          },
          {
            id: 'linux',
            title: 'Linux and VPS',
            blocks: [
              ...p('With Node.js 22 or newer and git installed:'),
              code('linuxInstall'),
              ...p(
                'Data goes to `$XDG_DATA_HOME/sillytavern-manager`, or `~/.local/share/sillytavern-manager` when that variable is unset.',
                'To have it come back after a reboot, save this as `/etc/systemd/system/sillytavern-manager@.service`:',
              ),
              code('linuxService'),
              code('linuxServiceEnable'),
              note('warn', 'Keep port `7860` behind the firewall. The manager panel is the thing that can install, restore and delete; publish the access gateway or a tunnel instead, never the panel. Set `STM_HOST=0.0.0.0` only when something else in front of it is doing the access control.'),
            ],
          },
          {
            id: 'docker',
            title: 'Docker and hosted platforms',
            blocks: [
              ...p('Build the image from the repository:'),
              code('dockerBuild'),
              ...p('Then run it with durable storage:'),
              code('dockerRun'),
              ...p(
                'The manager is at `http://127.0.0.1:7860`. SillyTavern stays on the container’s internal port `8002`, and a tunnel points only at the access gateway on `8001`.',
                'On a hosted container platform: expose `7860`, mount durable storage at `/data`, and supply `STM_ADMIN_PASSWORD` through the platform’s secret settings.',
              ),
              note('warn', 'Never put the administrator password in a Dockerfile or commit it to git. `STM_ADMIN_PASSWORD` is read once, at the first start, to create the password without a browser.'),
            ],
          },
          {
            id: 'npm',
            title: 'npm',
            blocks: [
              ...p('On any machine with Node.js 22 or newer:'),
              code('npmRun'),
              ...p('Or install it once and keep it:'),
              code('npmGlobal'),
              note('info', 'On Windows prefer the portable ZIP — it already contains Node.js. The npm package and a source checkout use the same ports and the same data directory.'),
            ],
          },
        ],
      },
      {
        id: 'first-run',
        icon: 'lock',
        title: 'The first run',
        blocks: [
          {
            type: 'steps',
            items: [
              'Open `http://127.0.0.1:7860`. The first screen asks you to create the **manager administrator password**. Choose something long; this password is what opens the panel that can install, restore and delete.',
              'Read the terms — the line beside the tick opens them — then accept and finish setup.',
              'Choose a SillyTavern version. `latest` is selected by default and is the right answer unless you have a reason to pin one.',
              'Press **Install** and wait for **Ready**. It clones the repository, installs dependencies and then health-checks the result; **Ready** means SillyTavern actually answered on port `8002`, not that the files finished copying.',
              'Open the local link, or set a SillyTavern passcode first and then turn on local-network access or a tunnel.',
            ],
          },
          { type: 'shot', name: 'sign-in', alt: 'The first-run screen: manager password, confirmation, and the line that opens the terms' },
          note('warn', 'The manager password and the SillyTavern passcode are two different things. The manager password opens the admin panel. The passcode opens SillyTavern to other devices, and changing it signs out every device already in.'),
          ...p(
            'Beside the password, **Continue with Cloudflare** sets the manager up and connects backups to an R2 bucket in your own account in one step; afterwards that Cloudflare account opens the manager as well as the password does. If the account already holds the backups and settings of one of your machines, they come back here — see [Bringing a machine back](#machine).',
            'Until everything is in place, a **Setup checklist** on the overview lists the six steps worth taking — install SillyTavern, connect Cloudflare, set the STM password and the SillyTavern PIN, turn on R2 backups and open SillyTavern’s link — and ticks each one off as it happens. It folds itself away once all six are done.',
          ),
          ...p('A first install downloads a few hundred megabytes of dependencies and takes a few minutes on a laptop, longer on a phone. The live log says what it is doing; nothing is stuck just because it is quiet for thirty seconds during `npm ci`.'),
        ],
      },
      {
        id: 'daily',
        icon: 'terminal',
        title: 'Running it day to day',
        blocks: [
          ...p(
            'The overview page is the whole of normal use: **Start**, **Stop**, and a link that opens SillyTavern. It also shows the installed version, whether a newer release exists, how much space your data takes and what the machine is doing.',
            '**Use it here**, on the preview, opens SillyTavern inside the manager’s own page, already signed in — the manager password is the stronger of the two, so the PIN is not asked for. The bar above it can minimize it back to the console while it stays loaded, give it the full screen, back up on this machine or to the cloud, show the logs, reload it or move it to a tab; **Close** unloads it and gives its memory back. The arrow beside **Open SillyTavern** offers **Open with tools**: a new tab with the same bar and a floating tools button. From another device, where a page cannot be put inside the console, the same buttons open SillyTavern in a tab instead.',
          ),
          { type: 'shot', name: 'overview', alt: 'The overview page: SillyTavern running, remote access, data and backups, system usage and live logs' },
          ...p('The log feed carries five sources in one searchable list — the manager, SillyTavern, the installer, backups and the tunnel. When something fails, the reason is in there, and the panel translates the manager’s own lines into your language while leaving SillyTavern’s, npm’s and git’s output exactly as those programs wrote it.'),
          note('info', 'Closing the browser does not stop anything. The manager keeps running until you stop it in its own window, or stop the service.'),
        ],
      },
      {
        id: 'share',
        icon: 'shield',
        title: 'Reaching it from another device',
        blocks: [
          ...p(
            'SillyTavern itself never leaves `127.0.0.1`. Everything from outside arrives at the **access gateway** on port `8001`, which asks for a six-digit passcode and then forwards to SillyTavern — and never to the manager panel.',
            'There are two ways to open the gateway, and both are switches on the overview page:',
          ),
          {
            type: 'list',
            items: [
              '**Local network.** Other devices on the same Wi-Fi reach it at your machine’s LAN address. Nothing leaves your network.',
              '**Cloudflare Tunnel.** A `trycloudflare.com` address that works from anywhere, with no port forwarding and no router configuration. The address changes each time the tunnel starts; signed in to Cloudflare, a fixed `workers.dev` address stands in front of it and never does.',
            ],
          },
          {
            type: 'steps',
            items: [
              'Set the SillyTavern passcode first. The switches will not do anything useful until there is one.',
              'Turn on **Local network** or **Cloudflare tunnel**.',
              'Copy the address, or scan the QR code the panel draws for it.',
              'On the other device, enter the passcode once.',
            ],
          },
          ...p('With a Cloudflare sign-in each link has two addresses: the fixed one through a Worker, and the tunnel’s own. The card shows one and keeps the other behind a count beside it. **Show this link first** decides which goes in front — on the card, behind **Open** and in the QR code — and the fixed one can be hidden altogether while the Worker goes on following the tunnel. A new tunnel’s address is handed out only once it answers.'),
          note('warn', 'Six digits are not a password. The gateway locks globally after five consecutive wrong tries, which is what makes a short code workable — but do not leave a tunnel running when nobody is using it, and do not expose an installation holding data you could not bear to lose or to reveal.'),
          note('good', 'Whoever has the address and the passcode gets SillyTavern and only SillyTavern. They cannot install, restore, delete, read your logs or reach the settings.'),
        ],
      },
      {
        id: 'backups',
        icon: 'archive',
        title: 'Backups and restores',
        blocks: [
          ...p('The **Data** page holds profiles, local archives and, if you connect it, off-site recovery points in your own Cloudflare account.'),
          { type: 'shot', name: 'data', alt: 'The data page: profiles, local backups and Cloudflare R2 recovery points' },
        ],
        subsections: [
          {
            id: 'local-backups',
            title: 'Local archives',
            blocks: [
              ...p('**Back up now** writes a ZIP that SillyTavern’s own import understands. By default it leaves out `secrets.json`, thumbnails, vectors, generated backups, `.git`, `node_modules` and operating-system clutter, which is why an archive is far smaller than the data folder. Including secrets is a separate, deliberate choice with a warning attached.'),
              ...p('The schedule takes one every 30 minutes, hour, six hours or day when the data has changed, and keeps the newest (`STM_LOCAL_BACKUPS` keeps more). **Create a restore point** takes one on purpose, with a note of your own, and the manager never deletes a restore point, an upload or a recovery point brought back from R2 by itself; the safety copy taken before a restore or a profile switch is kept as the undo for the last one. Archives are ordinary files: copy them anywhere.'),
            ],
          },
          {
            id: 'restore',
            title: 'Restoring',
            blocks: [
              {
                type: 'steps',
                items: [
                  'Pick an archive — one the manager made, one from Cloudflare R2, or a ZIP you upload.',
                  'Read the preview. It lists what is in the archive before anything is written, and for a replace, which files in the profile the archive does not have.',
                  'Choose **Replace** (the default: the profile becomes the archive) or **Merge** (files in the archive overwrite their counterparts, everything else is left).',
                  'Confirm. A safety snapshot of the current state is taken first, automatically.',
                ],
              },
              note('warn', 'Restoring replaces data. The safety snapshot means a mistake is recoverable, but choosing the right archive is still yours to get right.'),
            ],
          },
          {
            id: 'cloudflare',
            title: 'Cloudflare R2',
            blocks: [
              ...p(
                'On the Data page, **Connect Cloudflare** is the whole of the setup. Sign in, choose the account, allow the permissions, and the manager finds or creates a bucket named `sillytavern-manager-backup` **in your account** and starts keeping recovery points in it. There are no keys to create or paste.',
                'Two of the permissions are optional and worth allowing:',
              ),
              {
                type: 'list',
                items: [
                  '**Workers.** The manager deploys a small Worker, also called `sillytavern-manager-backup`, that carries backup data to the bucket. It is much faster and does not spend your Cloudflare API rate limit. Without it, backups go through Cloudflare’s API and a first one can take a long time.',
                  '**Account Analytics.** The panel can then show storage and Class A/B operations as Cloudflare counts them, for the bucket and for the account against the free tier. These are usage figures, not your bill.',
                ],
              },
              ...p(
                'A new machine that signs in to the same account finds the same bucket, so the recovery points already in it can be restored onto it.',
                '**Disconnect** removes this installation’s Worker key and revokes the sign-in. The bucket and everything in it stay yours. You can also revoke access yourself in your Cloudflare profile, under **Manage OAuth authorizations**.',
              ),
              note('info', 'Only the refresh token is stored, in a file readable by your user alone. Access tokens and Worker keys are short-lived and live in memory. Backups go from your machine to your bucket; no server of this project is on that path.'),
              note('warn', 'R2 has a free tier, and beyond it Cloudflare bills you. Large or frequent backups cost storage and operations. Set your own limits and alerts in the Cloudflare dashboard — the charge is yours, whatever caused it.'),
              ...p('Prefer not to sign in? Choose **R2/S3 keys (manual)** and enter the endpoint, bucket and key pair from the R2 page of the Cloudflare dashboard. Any S3-compatible storage works the same way.'),
            ],
          },
          {
            id: 'saver',
            title: 'Saver mode',
            blocks: [
              ...p(
                'For a machine with little room for files — a container that keeps everything in memory, a phone that is nearly full — the archives on the machine are what runs it out. With **Saver mode** on, no archive is kept on the machine and the profile is on the disk once. Your R2 bucket holds the recovery points and stands in for the safety copy: the current data is sent to R2 before a restore replaces it.',
                'An uploaded ZIP and a recovery point from R2 are written straight into the profile as they arrive, with SillyTavern stopped. The restore is checked against the room there is before it starts; when room is short, the manager offers to leave out what SillyTavern can do without — extensions’ git history and `node_modules`, SillyTavern’s own backups, thumbnails — and refuses one that still will not fit rather than failing halfway.',
                'It turns itself on when the data directory is kept in memory, or when the disk has less than 5 GiB free as the manager starts, and says which. Otherwise it is a switch under **Settings → When the manager opens**, or `STM_SAVER=1` / `STM_SAVER=0` in the environment to settle it for good.',
              ),
              note('warn', 'Connect R2 before relying on saver mode. With it on and no bucket, nothing holds your data but the profile itself.'),
            ],
          },
          {
            id: 'machine',
            title: 'Bringing a machine back',
            blocks: [
              ...p(
                'The bucket also keeps how the manager was set up, beside the data: the manager password and the SillyTavern PIN as the hashes it stores, the ports, the links, **Keep STM online**, the backup schedules and R2 limits, and the SillyTavern release that was running. The usage figures go there too.',
                'On a new machine, sign in with the same Cloudflare account — on the first-run screen or on the Data page. A profile that is empty while the bucket is not gets the newest recovery point back before SillyTavern starts, and SillyTavern is installed at the release you were running. When the account holds the setup of another of your machines, a card on every page offers **Restore everything** in one go; SillyTavern is stopped while it runs, and what was on this machine is kept under Backups first.',
                'One account backs up from one machine at a time. Signing in on a second machine makes it the one that backs up; the first stops, gives up its own sign-in and says which machine took over. Signing in there again takes it back.',
              ),
              note('info', 'Nothing is applied behind your back. A machine that is already set up is only offered the settings, with the name of the machine that wrote them and when, and restoring a password asks you to sign in again.'),
            ],
          },
        ],
      },
      {
        id: 'profiles',
        icon: 'layers',
        title: 'Data profiles',
        blocks: [
          ...p(
            'A profile is a complete, separate SillyTavern data set: its own characters, chats, settings and backups. Switching profiles swaps what SillyTavern sees.',
            'They are useful for keeping work and play apart, for trying an extension without risking a real data set, and for a second person on the same machine. Creating one is instant; switching takes a safety snapshot first.',
          ),
        ],
      },
      {
        id: 'usage',
        icon: 'chart',
        title: 'Usage figures',
        blocks: [
          ...p('The **Usage** page counts requests, tokens, cache hits and latency, broken down by day, provider and model. The numbers come from SillyTavern’s own traffic as it passes through the manager, so they cover every provider without any of them being configured here.'),
          { type: 'shot', name: 'metrics', alt: 'The usage page: requests, tokens, cache hits and latency per day, provider and model' },
          note('good', 'These figures never leave the machine. They are read from a local file; what the project receives is the far smaller summary described in the [Privacy Notice](/privacy).'),
        ],
      },
      {
        id: 'settings',
        icon: 'scale',
        title: 'Settings',
        blocks: [
          ...p('The **Settings** page edits SillyTavern’s own `config.yaml` through switches, and can also open the file directly for anything the switches do not cover. Saving stops SillyTavern, writes the file and starts it again.'),
          { type: 'shot', name: 'settings', alt: 'The settings page: security, performance, extensions, API keys and chat backups' },
          {
            type: 'table',
            columns: ['Setting', 'What it changes'],
            rows: [
              ['Lazy-load characters', 'A large character list loads on demand rather than all at once'],
              ['Disk cache and memory cache', 'How much SillyTavern keeps ready; the memory figure is a ceiling, not a reservation'],
              ['Request compression', 'Smaller responses over a tunnel or a slow link'],
              ['Extensions and auto-update', 'Whether extensions load, and whether they update themselves'],
              ['Allow key exposure', 'Whether SillyTavern will show stored API keys in its own interface. Off unless you need it'],
              ['Chat backups', 'SillyTavern’s own per-chat backups, and how many to keep'],
            ],
          },
          note('warn', 'Editing the file by hand is a different act from flipping a switch. An invalid file stops SillyTavern from starting; the panel checks the YAML parses before it writes, but it cannot know whether a value makes sense.'),
          ...p('Above SillyTavern’s settings are the manager’s own: the STM password and the SillyTavern PIN, the console’s own link to the internet, **Start SillyTavern automatically**, [Saver mode](#saver), the ports, and **Keep STM online**. That last one has the manager reach its own address every 15 minutes — or 5, 10, 30 or 60 — so a battery saver, or a host that stops idle programs, does not put it to sleep and SillyTavern with it. It holds the address in `STM_PUBLIC_ORIGIN`, otherwise the one your browser last reached the console at, otherwise `127.0.0.1`; never the tunnel or the Worker, so it costs nothing from the Cloudflare allowance.'),
        ],
      },
      {
        id: 'update',
        icon: 'download',
        title: 'Updating',
        blocks: [
          {
            type: 'table',
            columns: ['Platform', 'How to update the manager'],
            rows: [
              ['Windows', 'Stop the manager, extract the new ZIP into a **new** folder, run the new executable. Keep the old folder until you are sure.'],
              ['Termux, macOS, Linux', 'Stop the process, then `git pull --ff-only`, `npm ci`, and start the launcher again.'],
              ['Docker', 'Rebuild the image and start a new container against the same volume.'],
              ['npm', '`npm install --global sillytavern-manager@latest`, or just run `npx sillytavern-manager` again.'],
            ],
          },
          code('sourceUpdate', 'From a source checkout, with the manager stopped'),
          ...p('SillyTavern itself updates from the panel: pick a newer version and press Install. Your data is copied to safety before the version is switched, and the manager tells you when a release newer than the installed one exists.'),
          note('good', 'The data directory is never inside the application directory, on any platform. Replacing the application leaves profiles, backups, logs, metrics and settings exactly where they were.'),
        ],
      },
      {
        id: 'env',
        icon: 'server',
        title: 'Environment variables',
        blocks: [
          ...p('Everything can be set in the panel. These are for unattended installs and hosted platforms; they are read at start from the process environment or a `.env` file, and anything set here is shown in the panel and cannot be changed there.'),
          {
            type: 'table',
            columns: ['Variable', 'What it does'],
            rows: [
              ['`STM_ADMIN_PASSWORD`', 'Creates the administrator password at the first start, so a headless install needs no browser'],
              ['`STM_HOST`', 'What the manager binds to. Defaults to loopback; set `0.0.0.0` only behind other access control'],
              ['`STM_DATA_DIR`', 'Where profiles, backups, logs and metrics are kept, instead of the platform default'],
              ['`STM_PORT`', 'The console’s port, instead of `7860`. Unset, a port something else holds is stepped over, and a host’s `PORT` is used when it announces one'],
              ['`STM_ACCESS_PORT`', 'The access gateway’s port, instead of `8001`'],
              ['`STM_SAVER`', '`1` or `0` settles [saver mode](#saver) for good; the switch in the panel then cannot change it'],
              ['`STM_STORAGE_IN_MEMORY`', '`1` or `0` says whether files written here take the machine’s memory. Detected on its own from the mount table and the Knative `K_SERVICE` variable'],
              ['`STM_PUBLIC_ORIGIN`', 'The address the console is reached at from outside, behind a proxy that rewrites `Host`; also the address **Keep STM online** holds'],
              ['`STM_TUNNEL_PROTOCOL`', '`http2` skips cloudflared’s QUIC attempt on a network that does not let UDP out'],
              ['`STM_OPEN_BROWSER`', '`0` stops the manager opening a browser at start'],
              ['`STM_LOCAL_BACKUPS`', 'How many automatic archives to keep (one by default)'],
              ['`STM_CLOUDFLARED_PATH`', 'A `cloudflared` binary to use instead of the one the manager would find'],
              ['`STM_R2_ENDPOINT` · `STM_R2_BUCKET`', 'R2 or S3 endpoint and bucket, for keys supplied rather than signed in'],
              ['`STM_R2_ACCESS_KEY_ID` · `STM_R2_SECRET_ACCESS_KEY`', 'The key pair. With all four set, R2 backups start switched on'],
              ['`STM_CLOUDFLARE_OAUTH_CLIENT_ID`', 'An OAuth client registered in your own Cloudflare account; empty turns signing in off'],
              ['`STM_TELEMETRY_ENDPOINT`', 'Where usage summaries go. **Set it empty to send nothing at all**'],
            ],
          },
          code('telemetryOff', 'Turning usage reporting off completely'),
        ],
      },
      {
        id: 'trouble',
        icon: 'warn',
        title: 'When something goes wrong',
        blocks: [
          ...p('The live log is the first place to look, and usually the last. It carries the manager, SillyTavern, the installer, backups and the tunnel; the reason is nearly always written there in the program’s own words.'),
          {
            type: 'table',
            columns: ['What you see', 'What it usually is'],
            rows: [
              ['The panel does not open at all', 'Something else holds port `7860`, or the manager stopped. Check the console window, then the port.'],
              ['Install fails during `npm ci`', 'No internet, a proxy in the way, or a full disk. The log carries npm’s own error.'],
              ['**Ready** never arrives', 'SillyTavern started but did not answer on `8002`. Read the SillyTavern lines in the log; a bad `config.yaml` is the usual cause.'],
              ['The tunnel will not start', '`cloudflared` is missing or Cloudflare is unreachable. Local access keeps working regardless.'],
              ['Another device cannot connect', 'The gateway is off, no passcode is set, or the two devices are not on the same network.'],
              ['A passcode stopped working', 'Five wrong tries lock the gateway. Wait, or change the passcode from the panel.'],
              ['SillyTavern will not start after an edit', 'Restore defaults on the Settings page, or fix the YAML in the editor there.'],
            ],
          },
          code('portCheck', 'Finding what holds a port'),
          code('portCheckWindows', 'The same on Windows'),
          ...p(`If none of that helps, open an issue at [${ISSUES.replace('https://', '')}](${ISSUES}) with the platform, the version from the About panel in Settings, and the relevant log lines. Do not paste API keys or tunnel addresses.`),
        ],
      },
      {
        id: 'privacy-brief',
        icon: 'lock',
        title: 'Privacy, briefly',
        blocks: [
          ...p(
            'There is no account and no cloud. Chats, characters, prompts, settings, backups and API keys stay on machines you control, and the project holds no copy of any of it.',
            'The manager sends one thing: a small allowlisted usage summary — platform, version, and per request the provider, model, endpoint hostname, token counts, status and duration. Never prompts, chats, responses, keys, file names, paths, IP addresses or query strings.',
            'The full list, and the one line that switches it off, are in the [Privacy Notice](/privacy). The [Terms of Use](/terms) and the [Disclaimer](/disclaimer) say what the project does and does not take responsibility for.',
          ),
          ...p(`The source is at [${REPOSITORY.replace('https://', '')}](${REPOSITORY}), under the AGPL-3.0. You can read every line of it, including the part that decides what is sent.`),
        ],
      },
    ],
  },
  vi: {
    title: 'Tài liệu hướng dẫn',
    description: 'Cài đặt, chạy, chia sẻ, sao lưu và xử lý sự cố SillyTavern Manager trên Windows, Android, macOS, Linux, Docker và npm.',
    heading: 'Tài liệu hướng dẫn',
    lede: 'Từ lần cài đầu tiên cho tới lúc phục hồi trên một máy mới. Chọn nền tảng của bạn, làm theo tới khi hiện Sẵn sàng, phần còn lại đọc khi cần.',
    tocLabel: 'Trong trang này',
    sections: [
      {
        id: 'start',
        icon: 'info',
        title: 'Trước khi bắt đầu',
        blocks: [
          ...p(
            `SillyTavern Manager cài và chạy [SillyTavern](${UPSTREAM}) giúp bạn. Nó không phải SillyTavern, và cũng không do những người làm SillyTavern tạo ra — nó clone kho mã công khai của họ về máy bạn, theo yêu cầu của bạn, rồi quản lý những gì tải về.`,
            'Bạn cần: một máy do bạn kiểm soát, khoảng 2 GB trống cho SillyTavern và các gói phụ thuộc, và kết nối internet cho lần cài đầu tiên. Sau đó mọi thứ chạy được ngoại tuyến, trừ các nhà cung cấp mô hình mà SillyTavern gọi tới.',
          ),
          {
            type: 'table',
            columns: ['Nền tảng', 'Cần những gì', 'Bắt đầu ở đâu'],
            rows: [
              ['Windows 10 hoặc 11', 'Không cần gì. Node.js nằm sẵn trong bản tải.', '[Windows](#windows)'],
              ['Android 7 trở lên', 'Termux từ F-Droid', '[Termux](#android)'],
              ['macOS 13 trở lên', 'Homebrew và Node.js 22+', '[macOS](#macos)'],
              ['Linux hoặc VPS', 'Node.js 22+ và git', '[Linux](#linux)'],
              ['Máy chủ Docker bất kỳ', 'Docker, và một volume cho `/data`', '[Docker](#docker)'],
              ['Máy nào có Node 22+', 'npm 11+', '[npm](#npm)'],
            ],
          },
          note('info', 'Trình quản lý và SillyTavern dùng ba cổng: `7860` cho bảng điều khiển, `8002` cho SillyTavern và `8001` cho cổng truy cập. Nếu trên máy đã có thứ khác chiếm một trong số đó, xem mục [Xử lý sự cố](#trouble).'),
        ],
      },
      {
        id: 'install',
        icon: 'download',
        title: 'Cài đặt',
        blocks: p('Cài bằng cách nào thì cuối cùng cũng tới cùng một chỗ: một bảng điều khiển ở cổng `7860` hỏi bạn chọn mật khẩu quản trị.'),
        subsections: [
          {
            id: 'windows',
            title: 'Windows — tải về và chạy',
            blocks: [
              {
                type: 'steps',
                items: [
                  `Mở [bản phát hành mới nhất](${RELEASES}).`,
                  'Tải `SillyTavernManager-windows-x64-vX.Y.Z.zip` và tệp `.sha256` nằm cạnh nó.',
                  'Giải nén tệp ZIP vào một thư mục bình thường, ví dụ `Downloads\\SillyTavernManager`. Đừng chạy thẳng từ trong tệp ZIP.',
                  'Bấm đúp vào `SillyTavernManager.exe`.',
                  'Trình duyệt sẽ tự mở. Nếu không, hãy vào `http://127.0.0.1:7860`.',
                ],
              },
              ...p(
                'Một cửa sổ dòng lệnh mở ra và ở đó. Cửa sổ đó **chính là** trình quản lý: nó in ra địa chỉ, nơi dữ liệu được lưu, và trình quản lý cùng SillyTavern đang làm gì. Đóng nó lại là dừng sạch mọi thứ — SillyTavern và tunnel Cloudflare tắt theo, không cổng nào bị giữ lại và không có tiến trình nào phải đi tìm trong Task Manager.',
                'Bấm **Q** hoặc **Ctrl+C** trong cửa sổ đó để dừng, và bấm **O** để mở lại bảng điều khiển trong trình duyệt.',
              ),
              note('good', 'Thư mục ứng dụng và thư mục dữ liệu tách rời nhau. Dữ liệu của bạn nằm ở `%LOCALAPPDATA%\\SillyTavernManager`, nên thay tệp ZIP bằng bản mới không bao giờ đụng tới hồ sơ, bản sao lưu hay thiết lập.'),
              note('warn', 'Nếu SmartScreen cảnh báo về ứng dụng chưa ký, đó là chuyện bình thường: bản phát hành không được ký mã. Muốn chắc chắn bản tải đúng là bản đã công bố, hãy đối chiếu tệp `.sha256` với tệp ZIP.'),
            ],
          },
          {
            id: 'android',
            title: 'Android — Termux',
            blocks: [
              ...p(
                'Cài [Termux từ F-Droid](https://f-droid.org/packages/com.termux/) hoặc một nguồn đáng tin khác. **Đừng dùng bản Play Store cũ** — bản đó lạc hậu nhiều năm và trình quản lý gói của nó không còn hoạt động.',
                'Mở Termux và dán các lệnh sau. Hai lệnh đầu cần khoảng một phút mỗi lệnh; chúng cập nhật chính Termux.',
              ),
              code('termuxInstall'),
              ...p(
                'Cứ để phiên Termux đó chạy trong lúc bạn dùng SillyTavern. Trên điện thoại, trình quản lý ở `http://127.0.0.1:7860` còn SillyTavern ở `http://127.0.0.1:8002`.',
                'Lần sau muốn chạy lại:',
              ),
              code('termuxStart'),
              ...p('Cập nhật trình quản lý, sau khi đã dừng bằng **Ctrl+C**:'),
              code('termuxUpdate'),
              note('good', 'Termux giữ dữ liệu của bạn tại `$PREFIX/var/sillytavern-manager`, nằm ngoài kho mã, nên `git pull` không bao giờ đụng tới nó.'),
              note('info', 'Bật tunnel không cần cài gì bằng tay. Android chỉ khởi chạy tệp thực thi độc lập vị trí, còn bản dựng của Cloudflare thì không, nên trình quản lý hỏi Termux lấy bản `cloudflared` của Termux trước, và nếu không có thì chạy bản của Cloudflare dưới `proot`, tự cài thứ nào nó cần.'),
            ],
          },
          {
            id: 'macos',
            title: 'macOS — cài từ mã nguồn',
            blocks: [
              ...p('macOS dùng chung launcher với Linux. Dán đoạn này vào Terminal; dòng đầu cài Homebrew, bỏ qua được nếu bạn đã có.'),
              code('macosInstall'),
              ...p('Mở `http://127.0.0.1:7860`. Dừng bằng **Ctrl+C**, và lần sau chạy lại bằng:'),
              code('macosStart'),
              note('info', 'Dữ liệu nằm dưới `~/.local/share/sillytavern-manager`. Apple Silicon và Intel đều chạy tốt; không phần nào cần Rosetta.'),
            ],
          },
          {
            id: 'linux',
            title: 'Linux và VPS',
            blocks: [
              ...p('Với Node.js 22 trở lên và git đã cài:'),
              code('linuxInstall'),
              ...p(
                'Dữ liệu vào `$XDG_DATA_HOME/sillytavern-manager`, hoặc `~/.local/share/sillytavern-manager` khi biến đó chưa đặt.',
                'Muốn nó tự chạy lại sau khi khởi động máy, lưu đoạn sau thành `/etc/systemd/system/sillytavern-manager@.service`:',
              ),
              code('linuxService'),
              code('linuxServiceEnable'),
              note('warn', 'Hãy giữ cổng `7860` sau tường lửa. Bảng quản trị là thứ có thể cài, phục hồi và xoá; hãy mở cổng truy cập hoặc tunnel ra ngoài, đừng bao giờ mở bảng quản trị. Chỉ đặt `STM_HOST=0.0.0.0` khi đã có thứ khác đứng trước làm kiểm soát truy cập.'),
            ],
          },
          {
            id: 'docker',
            title: 'Docker và nền tảng lưu trữ',
            blocks: [
              ...p('Dựng image từ kho mã:'),
              code('dockerBuild'),
              ...p('Rồi chạy kèm lưu trữ bền:'),
              code('dockerRun'),
              ...p(
                'Trình quản lý ở `http://127.0.0.1:7860`. SillyTavern vẫn nằm trên cổng nội bộ `8002` của container, và tunnel chỉ trỏ tới cổng truy cập `8001`.',
                'Trên nền tảng container thuê ngoài: mở cổng `7860`, gắn lưu trữ bền vào `/data`, và đưa `STM_ADMIN_PASSWORD` qua phần secret của nền tảng.',
              ),
              note('warn', 'Đừng bao giờ đặt mật khẩu quản trị trong Dockerfile hay commit nó vào git. `STM_ADMIN_PASSWORD` chỉ được đọc một lần, ở lần khởi động đầu tiên, để tạo mật khẩu mà không cần trình duyệt.'),
            ],
          },
          {
            id: 'npm',
            title: 'npm',
            blocks: [
              ...p('Trên bất kỳ máy nào có Node.js 22 trở lên:'),
              code('npmRun'),
              ...p('Hoặc cài một lần rồi giữ lại:'),
              code('npmGlobal'),
              note('info', 'Trên Windows nên dùng bản ZIP chạy trực tiếp — nó đã có sẵn Node.js. Gói npm và bản clone mã nguồn dùng chung cổng và chung thư mục dữ liệu.'),
            ],
          },
        ],
      },
      {
        id: 'first-run',
        icon: 'lock',
        title: 'Lần chạy đầu tiên',
        blocks: [
          {
            type: 'steps',
            items: [
              'Mở `http://127.0.0.1:7860`. Màn hình đầu tiên yêu cầu bạn tạo **mật khẩu quản trị**. Hãy chọn mật khẩu dài; đây là thứ mở ra bảng điều khiển có quyền cài, phục hồi và xoá.',
              'Đọc điều khoản — bấm vào dòng chữ cạnh ô tick là mở ra — rồi đồng ý và hoàn tất thiết lập.',
              'Chọn phiên bản SillyTavern. `latest` được chọn sẵn và là đáp án đúng, trừ khi bạn có lý do phải ghim một bản cụ thể.',
              'Bấm **Cài đặt** rồi chờ tới khi hiện **Sẵn sàng**. Nó clone kho mã, cài phụ thuộc rồi kiểm tra sức khoẻ; **Sẵn sàng** nghĩa là SillyTavern đã thực sự trả lời trên cổng `8002`, không phải chỉ là chép xong tệp.',
              'Mở liên kết nội bộ, hoặc đặt mã truy cập cho SillyTavern trước rồi mới bật mạng nội bộ hay tunnel.',
            ],
          },
          { type: 'shot', name: 'sign-in', alt: 'Màn hình thiết lập lần đầu: mật khẩu quản trị, xác nhận, và dòng chữ mở điều khoản' },
          note('warn', 'Mật khẩu quản trị và mã truy cập SillyTavern là hai thứ khác nhau. Mật khẩu quản trị mở bảng quản trị. Mã truy cập mở SillyTavern cho thiết bị khác, và đổi mã sẽ đăng xuất mọi thiết bị đang vào.'),
          ...p(
            'Bên cạnh mật khẩu, **Tiếp tục với Cloudflare** thiết lập trình quản lý và kết nối sao lưu vào một bucket R2 trong chính tài khoản của bạn trong một bước; sau đó tài khoản Cloudflare ấy mở được trình quản lý, cũng như mật khẩu. Nếu tài khoản đã giữ bản sao lưu và thiết lập của một máy khác của bạn, chúng sẽ quay về đây — xem [Dựng lại cả máy](#machine).',
            'Cho tới khi mọi thứ xong xuôi, mục **Việc cần làm** ở trang tổng quan liệt kê sáu bước nên làm — cài SillyTavern, kết nối Cloudflare, đặt mật khẩu STM và mã PIN SillyTavern, bật sao lưu R2 và mở link SillyTavern — và tự đánh dấu từng bước khi nó xong. Đủ cả sáu thì danh sách tự thu gọn.',
          ),
          ...p('Lần cài đầu tiên tải vài trăm megabyte phụ thuộc, mất vài phút trên laptop và lâu hơn trên điện thoại. Nhật ký trực tiếp cho biết nó đang làm gì; im lặng ba mươi giây trong lúc `npm ci` chạy không có nghĩa là bị treo.'),
        ],
      },
      {
        id: 'daily',
        icon: 'terminal',
        title: 'Dùng hằng ngày',
        blocks: [
          ...p(
            'Trang tổng quan là toàn bộ việc dùng thường ngày: **Chạy**, **Dừng**, và một liên kết mở SillyTavern. Trang này cũng cho biết phiên bản đang cài, có bản mới hơn hay không, dữ liệu chiếm bao nhiêu và máy đang làm gì.',
            '**Dùng ngay tại đây**, trên khung xem trước, mở SillyTavern ngay bên trong trang của trình quản lý và đã đăng nhập sẵn — mật khẩu quản trị mạnh hơn nên không hỏi mã PIN. Thanh phía trên cho phép thu nhỏ về bảng điều khiển mà SillyTavern vẫn giữ nguyên, phóng toàn màn hình, sao lưu trên máy hoặc lên cloud, xem nhật ký, tải lại hoặc chuyển sang tab mới; **Đóng** thì gỡ nó ra và trả lại bộ nhớ. Mũi tên cạnh **Mở SillyTavern** có **Mở kèm tiện ích**: một tab mới có cùng thanh đó và một nút tiện ích nổi. Từ thiết bị khác, nơi không thể nhúng trang vào bảng điều khiển, các nút đó mở SillyTavern trong tab mới.',
          ),
          { type: 'shot', name: 'overview', alt: 'Trang tổng quan: SillyTavern đang chạy, truy cập từ xa, dữ liệu và sao lưu, tài nguyên hệ thống và nhật ký trực tiếp' },
          ...p('Luồng nhật ký gộp năm nguồn vào một danh sách tìm kiếm được — trình quản lý, SillyTavern, trình cài đặt, sao lưu và tunnel. Khi có gì hỏng, lý do nằm trong đó, và bảng điều khiển dịch những dòng của chính trình quản lý sang ngôn ngữ của bạn, còn output của SillyTavern, npm và git thì để nguyên như các chương trình đó viết ra.'),
          note('info', 'Đóng trình duyệt không dừng bất cứ thứ gì. Trình quản lý vẫn chạy cho tới khi bạn dừng nó trong cửa sổ của chính nó, hoặc dừng dịch vụ.'),
        ],
      },
      {
        id: 'share',
        icon: 'shield',
        title: 'Truy cập từ thiết bị khác',
        blocks: [
          ...p(
            'Bản thân SillyTavern không bao giờ rời khỏi `127.0.0.1`. Mọi thứ từ bên ngoài đều đi vào **cổng truy cập** ở cổng `8001`, nơi hỏi mã sáu chữ số rồi mới chuyển tiếp tới SillyTavern — và không bao giờ chuyển tiếp tới bảng quản trị.',
            'Có hai cách mở cổng truy cập, cả hai đều là công tắc trên trang tổng quan:',
          ),
          {
            type: 'list',
            items: [
              '**Mạng nội bộ.** Thiết bị khác cùng Wi-Fi truy cập qua địa chỉ LAN của máy bạn. Không gì rời khỏi mạng của bạn.',
              '**Cloudflare Tunnel.** Một địa chỉ `trycloudflare.com` dùng được từ mọi nơi, không cần mở cổng router hay cấu hình gì. Địa chỉ thay đổi mỗi lần bật tunnel; khi đã đăng nhập Cloudflare, một địa chỉ `workers.dev` cố định đứng trước nó và không bao giờ đổi.',
            ],
          },
          {
            type: 'steps',
            items: [
              'Đặt mã truy cập SillyTavern trước. Chưa có mã thì hai công tắc kia chưa làm được gì hữu ích.',
              'Bật **Mạng nội bộ** hoặc **Cloudflare tunnel**.',
              'Sao chép địa chỉ, hoặc quét mã QR mà bảng điều khiển vẽ ra cho nó.',
              'Trên thiết bị kia, nhập mã một lần.',
            ],
          },
          ...p('Khi đã đăng nhập Cloudflare, mỗi link có hai địa chỉ: địa chỉ cố định đi qua một Worker, và địa chỉ riêng của tunnel. Thẻ chỉ hiện một, cái còn lại nằm sau con số đếm bên cạnh. **Ưu tiên hiện link này** quyết định cái nào đứng trước — trên thẻ, sau nút **Mở** và trong mã QR — và link cố định cũng có thể ẩn hẳn trong khi Worker vẫn đi theo tunnel. Địa chỉ của tunnel mới chỉ được đưa ra khi nó đã trả lời.'),
          note('warn', 'Sáu chữ số không phải mật khẩu. Cổng truy cập tự khoá trên toàn hệ thống sau năm lần nhập sai liên tiếp, đó là điều khiến một mã ngắn vẫn dùng được — nhưng đừng để tunnel chạy khi không ai dùng, và đừng mở ra ngoài một bản cài đang giữ dữ liệu mà bạn không chịu nổi việc mất hay bị lộ.'),
          note('good', 'Người có địa chỉ và mã truy cập chỉ vào được SillyTavern và chỉ SillyTavern. Họ không cài, không phục hồi, không xoá, không đọc nhật ký và không chạm tới thiết lập được.'),
        ],
      },
      {
        id: 'backups',
        icon: 'archive',
        title: 'Sao lưu và phục hồi',
        blocks: [
          ...p('Trang **Dữ liệu** chứa hồ sơ dữ liệu, các bản lưu cục bộ, và nếu bạn kết nối thì cả các điểm phục hồi ngoài máy trong chính tài khoản Cloudflare của bạn.'),
          { type: 'shot', name: 'data', alt: 'Trang dữ liệu: hồ sơ, bản sao lưu cục bộ và điểm phục hồi trên Cloudflare R2' },
        ],
        subsections: [
          {
            id: 'local-backups',
            title: 'Bản lưu cục bộ',
            blocks: [
              ...p('**Sao lưu ngay** tạo một tệp ZIP mà chức năng nhập của chính SillyTavern đọc được. Mặc định nó bỏ qua `secrets.json`, ảnh thu nhỏ, vector, các bản sao lưu tự sinh, `.git`, `node_modules` và rác của hệ điều hành, vì vậy tệp lưu nhỏ hơn thư mục dữ liệu rất nhiều. Muốn kèm secret thì phải chọn riêng, có cảnh báo đi kèm.'),
              ...p('Lịch tự động tạo một bản mỗi 30 phút, mỗi giờ, mỗi 6 giờ hoặc mỗi ngày khi dữ liệu có thay đổi, và giữ bản mới nhất (`STM_LOCAL_BACKUPS` để giữ nhiều hơn). **Tạo điểm khôi phục** là chủ động tạo một bản kèm ghi chú của bạn, và trình quản lý không bao giờ tự xoá điểm khôi phục, tệp đã tải lên hay điểm phục hồi lấy về từ R2; bản an toàn tạo trước khi phục hồi hoặc chuyển hồ sơ được giữ làm nút hoàn tác cho lần gần nhất. Tệp lưu là tệp bình thường: chép đi đâu cũng được.'),
            ],
          },
          {
            id: 'restore',
            title: 'Phục hồi',
            blocks: [
              {
                type: 'steps',
                items: [
                  'Chọn một tệp lưu — do trình quản lý tạo, lấy từ Cloudflare R2, hoặc một tệp ZIP bạn tải lên.',
                  'Đọc phần xem trước. Nó liệt kê những gì có trong tệp lưu trước khi bất cứ gì được ghi, và với Thay thế, cả những tệp trong hồ sơ mà tệp lưu không có.',
                  'Chọn **Thay thế** (mặc định: hồ sơ trở thành đúng nội dung tệp lưu) hoặc **Gộp** (tệp trong bản lưu ghi đè lên bản tương ứng, phần còn lại giữ nguyên).',
                  'Xác nhận. Một bản chụp an toàn của trạng thái hiện tại được tạo trước, tự động.',
                ],
              },
              note('warn', 'Phục hồi là ghi đè dữ liệu. Bản chụp an toàn giúp sai lầm vẫn cứu được, nhưng chọn đúng tệp lưu vẫn là việc của bạn.'),
            ],
          },
          {
            id: 'cloudflare',
            title: 'Cloudflare R2',
            blocks: [
              ...p(
                'Trên trang Dữ liệu, **Kết nối Cloudflare** là toàn bộ phần thiết lập. Đăng nhập, chọn tài khoản, cho phép các quyền, rồi trình quản lý tìm hoặc tạo một bucket tên `sillytavern-manager-backup` **trong tài khoản của bạn** và bắt đầu giữ điểm phục hồi ở đó. Không phải tạo hay dán khoá nào.',
                'Hai trong số các quyền là tuỳ chọn và nên cho phép:',
              ),
              {
                type: 'list',
                items: [
                  '**Workers.** Trình quản lý triển khai một Worker nhỏ, cũng tên `sillytavern-manager-backup`, để chuyển dữ liệu sao lưu tới bucket. Cách này nhanh hơn nhiều và không tiêu tốn hạn mức API Cloudflare của bạn. Không có nó, bản sao lưu đi qua API của Cloudflare và lần đầu có thể rất lâu.',
                  '**Account Analytics.** Khi đó bảng điều khiển hiển thị được dung lượng và số thao tác Class A/B theo cách Cloudflare đếm, cho riêng bucket và cho cả tài khoản so với hạn mức miễn phí. Đây là số liệu sử dụng, không phải hoá đơn.',
                ],
              },
              ...p(
                'Một máy mới đăng nhập vào cùng tài khoản sẽ tìm thấy đúng bucket đó, nên các điểm phục hồi sẵn có đều khôi phục được sang máy mới.',
                '**Ngắt kết nối** xoá khoá Worker của bản cài này và thu hồi phiên đăng nhập. Bucket và mọi thứ bên trong vẫn là của bạn. Bạn cũng có thể tự thu hồi trong hồ sơ Cloudflare, tại mục **Manage OAuth authorizations**.',
              ),
              note('info', 'Chỉ refresh token được lưu, trong một tệp chỉ người dùng của bạn đọc được. Access token và khoá Worker đều ngắn hạn và nằm trong bộ nhớ. Bản sao lưu đi thẳng từ máy bạn tới bucket của bạn; không máy chủ nào của dự án nằm trên đường đó.'),
              note('warn', 'R2 có hạn mức miễn phí, vượt quá thì Cloudflare tính tiền bạn. Sao lưu lớn hoặc dày tốn dung lượng và số thao tác. Hãy tự đặt hạn mức và cảnh báo trong bảng điều khiển Cloudflare — khoản phí là của bạn, bất kể nguyên nhân là gì.'),
              ...p('Không muốn đăng nhập? Chọn **Khoá R2/S3 (thủ công)** rồi nhập endpoint, bucket và cặp khoá lấy từ trang R2 trong bảng điều khiển Cloudflare. Mọi kho lưu trữ tương thích S3 đều dùng được theo cách này.'),
            ],
          },
          {
            id: 'saver',
            title: 'Chế độ tiết kiệm',
            blocks: [
              ...p(
                'Với một máy ít chỗ chứa tệp — một container giữ mọi thứ trong bộ nhớ, một chiếc điện thoại gần đầy — chính các tệp lưu trên máy là thứ làm cạn chỗ. Khi bật **Chế độ tiết kiệm**, trên máy không giữ tệp lưu nào và hồ sơ chỉ nằm trên đĩa một lần. Bucket R2 của bạn giữ các điểm phục hồi và đóng vai bản an toàn: dữ liệu hiện tại được gửi lên R2 trước khi một lần phục hồi ghi đè lên nó.',
                'Tệp ZIP tải lên và điểm phục hồi lấy từ R2 được ghi thẳng vào hồ sơ khi dữ liệu tới, trong lúc SillyTavern dừng. Lần phục hồi được so với chỗ trống trước khi bắt đầu; nếu thiếu chỗ, trình quản lý đề nghị bỏ bớt những thứ SillyTavern không cần — lịch sử git và `node_modules` của tiện ích, bản sao lưu riêng của SillyTavern, ảnh thu nhỏ — và từ chối nếu vẫn không vừa, thay vì hỏng giữa chừng.',
                'Nó tự bật khi thư mục dữ liệu nằm trong bộ nhớ, hoặc khi ổ đĩa còn dưới 5 GiB lúc trình quản lý khởi động, và nói rõ vì lý do nào. Ngoài ra đây là một công tắc trong **Thiết lập → Khi mở trình quản lý**, hoặc đặt `STM_SAVER=1` / `STM_SAVER=0` trong môi trường để chốt hẳn.',
              ),
              note('warn', 'Hãy kết nối R2 trước khi dựa vào chế độ tiết kiệm. Bật nó mà không có bucket thì ngoài chính hồ sơ ra, không còn gì giữ dữ liệu của bạn.'),
            ],
          },
          {
            id: 'machine',
            title: 'Dựng lại cả máy',
            blocks: [
              ...p(
                'Bucket còn giữ cả cách trình quản lý được thiết lập, cạnh dữ liệu: mật khẩu quản trị và mã PIN SillyTavern dưới dạng hash nó đang lưu, các cổng, các link, **Giữ STM online**, lịch sao lưu và giới hạn R2, và bản SillyTavern đang chạy. Số liệu sử dụng cũng được giữ ở đó.',
                'Trên máy mới, đăng nhập cùng tài khoản Cloudflare — ở màn hình lần đầu hoặc trên trang Dữ liệu. Hồ sơ đang trống trong khi bucket có dữ liệu thì điểm phục hồi mới nhất được lấy về trước khi SillyTavern khởi động, và SillyTavern được cài đúng bản bạn đang dùng. Khi tài khoản đang giữ thiết lập của một máy khác của bạn, một thẻ trên mọi trang đề nghị **Khôi phục tất cả** trong một lần; SillyTavern dừng trong lúc chạy, và những gì đang có trên máy này được giữ trong mục Sao lưu trước.',
                'Mỗi tài khoản chỉ sao lưu từ một máy tại một thời điểm. Đăng nhập trên máy thứ hai khiến máy đó thành máy sao lưu; máy thứ nhất dừng lại, bỏ quyền đăng nhập của chính nó và báo máy nào đã tiếp quản. Đăng nhập lại ở đó là lấy lại quyền.',
              ),
              note('info', 'Không có gì tự áp dụng sau lưng bạn. Máy đã thiết lập xong chỉ được đề nghị các thiết lập này, kèm tên máy đã ghi chúng và thời điểm, và khôi phục mật khẩu sẽ yêu cầu bạn đăng nhập lại.'),
            ],
          },
        ],
      },
      {
        id: 'profiles',
        icon: 'layers',
        title: 'Hồ sơ dữ liệu',
        blocks: [
          ...p(
            'Một hồ sơ là một bộ dữ liệu SillyTavern hoàn chỉnh và tách biệt: nhân vật, đoạn chat, thiết lập và bản sao lưu riêng. Chuyển hồ sơ là đổi luôn thứ mà SillyTavern nhìn thấy.',
            'Nó hữu ích khi bạn muốn tách việc với giải trí, muốn thử một tiện ích mở rộng mà không đụng tới bộ dữ liệu thật, hoặc khi có người thứ hai dùng chung máy. Tạo hồ sơ là tức thì; chuyển hồ sơ sẽ chụp một bản an toàn trước.',
          ),
        ],
      },
      {
        id: 'usage',
        icon: 'chart',
        title: 'Số liệu sử dụng',
        blocks: [
          ...p('Trang **Số liệu** đếm lượt gọi, token, tỷ lệ trúng bộ nhớ đệm và độ trễ, chia theo ngày, theo nhà cung cấp và theo mô hình. Con số lấy từ chính lưu lượng của SillyTavern khi đi qua trình quản lý, nên bao phủ mọi nhà cung cấp mà không phải cấu hình nhà cung cấp nào ở đây.'),
          { type: 'shot', name: 'metrics', alt: 'Trang số liệu: lượt gọi, token, tỷ lệ trúng bộ nhớ đệm và độ trễ theo ngày, nhà cung cấp và mô hình' },
          note('good', 'Những số liệu này không bao giờ rời khỏi máy. Chúng được đọc từ một tệp cục bộ; thứ mà dự án nhận được là bản tóm tắt nhỏ hơn nhiều, mô tả trong [Thông báo quyền riêng tư](/privacy).'),
        ],
      },
      {
        id: 'settings',
        icon: 'scale',
        title: 'Thiết lập',
        blocks: [
          ...p('Trang **Thiết lập** sửa tệp `config.yaml` của chính SillyTavern thông qua các công tắc, và cũng mở thẳng được tệp đó cho những gì công tắc không bao phủ. Lưu lại sẽ dừng SillyTavern, ghi tệp rồi khởi động lại.'),
          { type: 'shot', name: 'settings', alt: 'Trang thiết lập: bảo mật, hiệu năng, tiện ích mở rộng, API key và sao lưu chat' },
          {
            type: 'table',
            columns: ['Thiết lập', 'Thay đổi điều gì'],
            rows: [
              ['Tải nhân vật khi cần', 'Danh sách nhân vật lớn được tải dần thay vì tải hết một lúc'],
              ['Bộ nhớ đệm đĩa và bộ nhớ', 'SillyTavern giữ sẵn bao nhiêu; con số bộ nhớ là mức trần, không phải phần được giữ chỗ'],
              ['Nén yêu cầu', 'Phản hồi nhẹ hơn khi đi qua tunnel hoặc đường truyền chậm'],
              ['Tiện ích mở rộng và tự cập nhật', 'Có nạp tiện ích hay không, và chúng có tự cập nhật hay không'],
              ['Cho phép lộ API key', 'SillyTavern có hiển thị API key đã lưu trong giao diện của nó hay không. Nên tắt trừ khi bạn cần'],
              ['Sao lưu chat', 'Bản sao lưu từng đoạn chat của chính SillyTavern, và giữ lại bao nhiêu bản'],
            ],
          },
          note('warn', 'Sửa tệp bằng tay là một việc khác hẳn với gạt một công tắc. Tệp sai khiến SillyTavern không khởi động được; bảng điều khiển kiểm tra YAML có phân tích được không trước khi ghi, nhưng nó không thể biết một giá trị có hợp lý hay không.'),
          ...p('Phía trên thiết lập của SillyTavern là thiết lập của chính trình quản lý: mật khẩu STM và mã PIN SillyTavern, link riêng của bảng điều khiển ra internet, **Tự chạy SillyTavern**, [Chế độ tiết kiệm](#saver), các cổng, và **Giữ STM online**. Cái cuối cùng cho trình quản lý tự gọi tới địa chỉ của chính nó mỗi 15 phút — hoặc 5, 10, 30, 60 phút — để trình tiết kiệm pin, hay một host tự dừng chương trình đang rảnh, không cho nó ngủ, kéo theo cả SillyTavern. Địa chỉ được giữ là cái trong `STM_PUBLIC_ORIGIN`, nếu không thì là địa chỉ trình duyệt mở bảng điều khiển gần nhất, nếu không nữa thì `127.0.0.1`; không bao giờ là tunnel hay Worker, nên không tốn chút hạn mức Cloudflare nào.'),
        ],
      },
      {
        id: 'update',
        icon: 'download',
        title: 'Cập nhật',
        blocks: [
          {
            type: 'table',
            columns: ['Nền tảng', 'Cập nhật trình quản lý thế nào'],
            rows: [
              ['Windows', 'Dừng trình quản lý, giải nén bản ZIP mới vào một thư mục **mới**, chạy tệp thực thi mới. Giữ thư mục cũ cho tới khi bạn yên tâm.'],
              ['Termux, macOS, Linux', 'Dừng tiến trình, rồi `git pull --ff-only`, `npm ci`, và chạy lại launcher.'],
              ['Docker', 'Dựng lại image và chạy container mới trên cùng volume.'],
              ['npm', '`npm install --global sillytavern-manager@latest`, hoặc chỉ cần chạy lại `npx sillytavern-manager`.'],
            ],
          },
          code('sourceUpdate', 'Từ bản clone mã nguồn, khi trình quản lý đã dừng'),
          ...p('Bản thân SillyTavern cập nhật ngay trong bảng điều khiển: chọn phiên bản mới hơn rồi bấm Cài đặt. Dữ liệu của bạn được chép sang chỗ an toàn trước khi đổi phiên bản, và trình quản lý sẽ báo khi có bản phát hành mới hơn bản đang cài.'),
          note('good', 'Thư mục dữ liệu không bao giờ nằm trong thư mục ứng dụng, trên mọi nền tảng. Thay ứng dụng vẫn để nguyên hồ sơ, bản sao lưu, nhật ký, số liệu và thiết lập ở đúng chỗ.'),
        ],
      },
      {
        id: 'env',
        icon: 'server',
        title: 'Biến môi trường',
        blocks: [
          ...p('Mọi thứ đều đặt được trong bảng điều khiển. Các biến này dành cho cài đặt không giám sát và nền tảng lưu trữ; chúng được đọc lúc khởi động từ môi trường tiến trình hoặc tệp `.env`, và những gì đặt ở đây sẽ hiển thị trong bảng điều khiển nhưng không sửa được tại đó.'),
          {
            type: 'table',
            columns: ['Biến', 'Tác dụng'],
            rows: [
              ['`STM_ADMIN_PASSWORD`', 'Tạo mật khẩu quản trị ngay lần khởi động đầu tiên, để cài không cần trình duyệt'],
              ['`STM_HOST`', 'Trình quản lý lắng nghe ở đâu. Mặc định là loopback; chỉ đặt `0.0.0.0` khi đã có kiểm soát truy cập khác'],
              ['`STM_DATA_DIR`', 'Nơi giữ hồ sơ, bản sao lưu, nhật ký và số liệu, thay cho mặc định của nền tảng'],
              ['`STM_PORT`', 'Cổng của bảng điều khiển, thay cho `7860`. Không đặt thì cổng đã bị chiếm sẽ được bỏ qua, và dùng `PORT` khi host có công bố'],
              ['`STM_ACCESS_PORT`', 'Cổng của cổng truy cập, thay cho `8001`'],
              ['`STM_SAVER`', '`1` hoặc `0` để chốt hẳn [chế độ tiết kiệm](#saver); công tắc trong bảng điều khiển không đổi được nữa'],
              ['`STM_STORAGE_IN_MEMORY`', '`1` hoặc `0` cho biết tệp ghi ở đây có chiếm bộ nhớ của máy hay không. Tự nhận biết qua bảng mount và biến `K_SERVICE` của Knative'],
              ['`STM_PUBLIC_ORIGIN`', 'Địa chỉ bảng điều khiển được truy cập từ bên ngoài, khi đứng sau proxy đổi `Host`; cũng là địa chỉ **Giữ STM online** sẽ giữ'],
              ['`STM_TUNNEL_PROTOCOL`', '`http2` để bỏ qua bước thử QUIC của cloudflared trên mạng không cho UDP ra ngoài'],
              ['`STM_OPEN_BROWSER`', '`0` để trình quản lý không tự mở trình duyệt khi khởi động'],
              ['`STM_LOCAL_BACKUPS`', 'Giữ lại bao nhiêu bản lưu tự động (mặc định là một)'],
              ['`STM_CLOUDFLARED_PATH`', 'Chỉ định tệp `cloudflared` để dùng, thay vì bản trình quản lý tự tìm'],
              ['`STM_R2_ENDPOINT` · `STM_R2_BUCKET`', 'Endpoint và bucket R2 hoặc S3, cho trường hợp dùng khoá thay vì đăng nhập'],
              ['`STM_R2_ACCESS_KEY_ID` · `STM_R2_SECRET_ACCESS_KEY`', 'Cặp khoá. Đặt đủ cả bốn thì sao lưu R2 bật sẵn ngay lần đầu'],
              ['`STM_CLOUDFLARE_OAUTH_CLIENT_ID`', 'OAuth client đăng ký trong chính tài khoản Cloudflare của bạn; để trống là tắt đăng nhập'],
              ['`STM_TELEMETRY_ENDPOINT`', 'Nơi nhận bản tóm tắt sử dụng. **Để trống là không gửi gì cả**'],
            ],
          },
          code('telemetryOff', 'Tắt hẳn việc gửi số liệu sử dụng'),
        ],
      },
      {
        id: 'trouble',
        icon: 'warn',
        title: 'Khi có gì đó trục trặc',
        blocks: [
          ...p('Nhật ký trực tiếp là nơi nên xem đầu tiên, và thường là nơi cuối cùng. Nó gộp trình quản lý, SillyTavern, trình cài đặt, sao lưu và tunnel; lý do gần như luôn được ghi ở đó bằng chính lời của chương trình.'),
          {
            type: 'table',
            columns: ['Bạn thấy gì', 'Thường là do đâu'],
            rows: [
              ['Bảng điều khiển không mở được', 'Thứ khác đang giữ cổng `7860`, hoặc trình quản lý đã dừng. Xem cửa sổ dòng lệnh trước, rồi tới cổng.'],
              ['Cài đặt hỏng lúc chạy `npm ci`', 'Không có internet, có proxy chặn, hoặc đầy ổ đĩa. Nhật ký mang nguyên lỗi của npm.'],
              ['Mãi không thấy **Sẵn sàng**', 'SillyTavern đã chạy nhưng không trả lời trên `8002`. Hãy đọc các dòng SillyTavern trong nhật ký; `config.yaml` sai là nguyên nhân thường gặp.'],
              ['Tunnel không lên được', '`cloudflared` thiếu hoặc không với tới Cloudflare. Truy cập nội bộ vẫn hoạt động bình thường.'],
              ['Thiết bị khác không kết nối được', 'Cổng truy cập đang tắt, chưa đặt mã, hoặc hai thiết bị không cùng mạng.'],
              ['Mã truy cập đột nhiên không dùng được', 'Năm lần sai sẽ khoá cổng truy cập. Hãy đợi, hoặc đổi mã trong bảng điều khiển.'],
              ['SillyTavern không chạy sau khi sửa cấu hình', 'Khôi phục mặc định ở trang Thiết lập, hoặc sửa lại YAML ngay trong trình soạn ở đó.'],
            ],
          },
          code('portCheck', 'Tìm xem thứ gì đang giữ một cổng'),
          code('portCheckWindows', 'Cách tương đương trên Windows'),
          ...p(`Nếu vẫn không được, hãy mở một issue tại [${ISSUES.replace('https://', '')}](${ISSUES}) kèm nền tảng, phiên bản lấy từ panel Về trình quản lý trong Thiết lập, và các dòng nhật ký liên quan. Đừng dán API key hay địa chỉ tunnel vào đó.`),
        ],
      },
      {
        id: 'privacy-brief',
        icon: 'lock',
        title: 'Quyền riêng tư, nói ngắn',
        blocks: [
          ...p(
            'Không có tài khoản và không có đám mây. Đoạn chat, nhân vật, prompt, thiết lập, bản sao lưu và API key đều nằm trên máy do bạn kiểm soát, và dự án không giữ bản sao nào của chúng.',
            'Trình quản lý gửi đi đúng một thứ: một bản tóm tắt sử dụng nhỏ nằm trong danh sách cho phép — nền tảng, phiên bản, và với mỗi lượt gọi là nhà cung cấp, tên mô hình, tên máy chủ điểm cuối, số token, mã trạng thái và thời lượng. Không bao giờ có prompt, đoạn chat, câu trả lời, khoá, tên tệp, đường dẫn, địa chỉ IP hay chuỗi truy vấn.',
            'Danh sách đầy đủ, và một dòng duy nhất để tắt nó, nằm trong [Thông báo quyền riêng tư](/privacy). [Điều khoản sử dụng](/terms) và [Tuyên bố miễn trừ trách nhiệm](/disclaimer) nói rõ dự án chịu và không chịu trách nhiệm những gì.',
          ),
          ...p(`Mã nguồn ở [${REPOSITORY.replace('https://', '')}](${REPOSITORY}), theo giấy phép AGPL-3.0. Bạn đọc được từng dòng, kể cả đoạn quyết định những gì được gửi đi.`),
        ],
      },
    ],
  },
};
