# SillyTavern Manager

[Tiếng Việt](README.vi.md)

SillyTavern Manager is a small cross-platform control panel for installing, running, accessing, backing up, and monitoring [SillyTavern](https://github.com/SillyTavern/SillyTavern).

The manager stays on port `7860`. SillyTavern stays on port `8000`. A Cloudflare Tunnel, when enabled, points only to SillyTavern and never exposes the manager panel.

## What it provides

- Install the latest SillyTavern release or select a release, `release`, or `staging` ref.
- Switch versions through one shared Git checkout instead of storing a complete runtime for every version.
- Keep a default data profile and optionally create more profiles.
- Support current `data/` storage and older `public/` runtimes without silently rewriting imported data.
- Start, stop, restart, and monitor SillyTavern from the browser.
- Read bounded, searchable live logs for the manager, SillyTavern, installer, backup, and tunnel.
- Create local ZIP backups, preview and restore them with replace or merge mode, and optionally sync to Cloudflare R2.
- Enable local-network access or a public tunnel through SillyTavern's account system.
- Show request, provider, model, latency, streaming, input/output, cache, and reasoning-token metrics.
- Work on Windows, Linux/VPS, Termux, Docker, and hosted platforms from the same codebase.

## Windows: download and run

Download the portable ZIP from the GitHub Releases page, extract it to a folder, and double-click `SillyTavernManager.exe`.

The bundle includes the manager server, panel assets, production dependencies, and a Node.js runtime. Node.js does not need to be installed separately. The first run opens:

```text
http://127.0.0.1:7860
```

On the first visit, create the manager password. The manager data directory is:

```text
%LOCALAPPDATA%\SillyTavernManager
```

This directory contains the manager state, profiles, backups, logs, metrics, and telemetry outbox. It is separate from the application folder, so replacing the application folder does not remove user data.

Windows releases include a `.sha256` file. Verify the ZIP before extracting it when distributing the file outside GitHub.

## Docker and VPS

Build the image from the repository:

```bash
docker build -f deploy/docker/Dockerfile -t sillytavern-manager .
```

Run it with durable storage:

```bash
docker run --rm \
  -p 7860:7860 \
  -v sillytavern-manager-data:/data \
  -e STM_ADMIN_PASSWORD='choose-a-long-password' \
  sillytavern-manager
```

Open the manager at `http://127.0.0.1:7860`. SillyTavern remains on the container's internal port `8000`; the manager can start a tunnel that targets that port.

For a hosted container platform, deploy `deploy/docker/Dockerfile`, expose port `7860`, and set `STM_ADMIN_PASSWORD` through a Studio secret. Persistent files belong under `/mnt/workspace`. Do not put the admin password in a Dockerfile or commit it to Git.

## Linux and Termux

The source launcher requires Node.js 22 or newer:

```bash
npm ci
node deploy/linux/launcher.mjs
```

For Termux:

```bash
npm ci
node deploy/termux/launcher.mjs
```

Linux data is stored under `$XDG_DATA_HOME/sillytavern-manager` or `~/.local/share/sillytavern-manager`. Termux data is stored under `$PREFIX/var/sillytavern-manager`. Cloudflared is optional; local manager and SillyTavern access continue to work when it is unavailable.

## npm for technical users

The npm package is intended for machines that already have Node.js 22 or newer:

```bash
npx sillytavern-manager
```

or:

```bash
npm install --global sillytavern-manager
sillytavern-manager
```

The manager still uses port `7860`, and the data directory follows the platform rules above. Windows users should prefer the portable ZIP because it includes Node.js and does not require a global Node installation.

## First setup

1. Open the manager panel on port `7860`.
2. Set the one manager administrator password.
3. Choose a SillyTavern version. `latest` is selected by default.
4. Press **Install** and wait until the job reaches **Ready** and SillyTavern answers on port `8000`.
5. Open the local link, or enable local-network access or a tunnel in the access card.
6. Set the SillyTavern account password before enabling a LAN address or public tunnel.

The manager administrator password and the SillyTavern account password are separate. The manager never forwards the manager panel through the public tunnel.

## Backup and restore

Local backup is always available. The archive is a streaming ZIP compatible with SillyTavern exports. The default backup excludes `secrets.json`, thumbnails, vectors, generated backups, `.git`, `node_modules`, and operating-system metadata. Including secrets is an explicit action with a warning.

Restore previews the archive before writing. Replace mode is the default and merge mode is available when needed. A safety snapshot is created before a replace or profile switch. Cloudflare R2 is optional and recommended for protection against a disk failure, a deleted hosted workspace, or a lost machine.

## Telemetry and privacy

Telemetry is part of this free project. The manager sends only an allowlisted summary such as platform, application version, provider, model, endpoint hostname, streaming flag, token usage, cache usage, reasoning-token usage, status, and duration.

It does **not** send API keys, authorization headers, prompts, chats, model responses, request bodies, response bodies, request logs, file names, file paths, IP addresses, or URL query strings. Events are written to a local outbox first and delivered asynchronously. A failed receiver never blocks SillyTavern.

## Updating

When a new manager release is published, close the old manager, extract the new Windows ZIP into a new folder, and run the new executable. The application bundle is replaceable; `%LOCALAPPDATA%\SillyTavernManager` is not touched. The old folder remains available for rollback.

Release builds are generated from version tags. GitHub Actions runs the verification suite, creates the Windows ZIP and checksum, builds the Docker image, and creates the npm tarball. An in-panel updater can be added later; it must verify the release checksum and replace only the application bundle.

## Development

Requirements: Node.js 22+, npm 11+, and PowerShell 7+ for Windows packaging.

```bash
npm ci
npm run panel:dev
npm run manager:start
```

Run the repository checks before opening a pull request:

```bash
npm run verify
```

Build release artifacts locally on Windows:

```powershell
pwsh packaging/windows/package-release.ps1
npm run release:npm
```

## License

See the repository license and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for notices covering adapted UI components.
