# SillyTavern Manager

[Read this guide in Vietnamese](README.vi.md)

SillyTavern Manager is a cross-platform control panel for installing, running, accessing, backing up, and monitoring [SillyTavern](https://github.com/SillyTavern/SillyTavern). It keeps the manager on port <code>7860</code> and SillyTavern on port <code>8000</code>, where only this machine can reach it. Another device on the network, or a Cloudflare Tunnel, reaches SillyTavern through the manager's access gateway on port <code>8001</code>, which asks for one password first. The tunnel never exposes the manager panel.

## Choose your platform

| Platform | Start here |
| --- | --- | --- |
| Windows | [Download the portable ZIP](#windows-download-and-run) |
| Android / Termux | [Copy the Termux commands](#android-termux-copy-and-paste-setup) |
| macOS | [Install from source](#macos-source-install) |
| Linux / VPS | [Run the Unix launcher](#linux-and-vps) |
| Docker / hosted studio | [Deploy the Docker image](#docker-and-vps) |

The first visit opens a setup screen where you create the one manager administrator password. After that, choose a SillyTavern version and press **Install**. The manager reports **Ready** only after SillyTavern is listening on port <code>8000</code>.

## Windows: download and run

This is the easiest option for most Windows users.

1. Open the [latest GitHub Release](https://github.com/locmaymo/stm/releases/latest).
2. Download <code>SillyTavernManager-windows-x64-vX.Y.Z.zip</code> and its <code>.sha256</code> checksum file.
3. Extract the ZIP to a normal folder, such as <code>Downloads\SillyTavernManager</code>.
4. Double-click <code>SillyTavernManager.exe</code>.
5. Open <code>http://127.0.0.1:7860</code> if the browser does not open automatically.

A console window opens and stays open. That window is the manager: it shows the address, where your data is kept, and what the manager and SillyTavern are doing. To stop everything, press <kbd>Q</kbd> or <kbd>Ctrl</kbd>+<kbd>C</kbd> in it, or close it. SillyTavern and the Cloudflare tunnel are shut down with it, so no port is left held and there is no process to hunt for in Task Manager. Press <kbd>O</kbd> to open the console in your browser again.

If the manager fails to start, the window keeps the reason on screen and waits for <kbd>Enter</kbd> rather than closing. Starting a second copy while one is already running says so and opens the running one instead.

The portable bundle already contains Node.js, the manager server, the panel, and production dependencies. Nothing needs to be installed with a terminal. Keep the application folder separate from the data folder:

~~~text
%LOCALAPPDATA%\SillyTavernManager
~~~

The data folder contains profiles, backups, logs, metrics, and the telemetry outbox. Replacing the application ZIP does not remove it. Windows releases include a checksum so you can verify the download before extracting it.

## Android: Termux copy-and-paste setup

Install [Termux from F-Droid](https://f-droid.org/packages/com.termux/) or another trusted source. Do not use the old Play Store build. Open Termux and paste these commands one block at a time:

~~~bash
pkg update -y
pkg upgrade -y
pkg install -y git nodejs-lts
git clone https://github.com/locmaymo/stm.git
cd stm
npm ci
npm start
~~~

Leave that Termux session running while SillyTavern is in use. Open the manager on the phone at <code>http://127.0.0.1:7860</code>; SillyTavern itself is at <code>http://127.0.0.1:8000</code>. The manager can create a public tunnel when you need to open SillyTavern from an iPhone or another network.

For a later start, use:

~~~bash
cd stm
npm start
~~~

For an update, stop the running manager first, then run:

~~~bash
cd stm
git pull --ff-only
npm ci
npm start
~~~

Termux data is stored outside the repository at:

~~~text
$PREFIX/var/sillytavern-manager
~~~

That directory survives <code>git pull</code> and application updates. Cloudflared is optional; local access continues to work when a tunnel is not installed or is offline. Turning the tunnel on in Termux needs nothing installed by hand: Android starts position-independent executables only and Cloudflare's own builds are not, so the manager asks Termux for its build of cloudflared and, failing that, runs Cloudflare's through `proot`, installing whichever of the two it ends up needing.

## macOS: source install

The current macOS path uses the same Node.js launcher as Linux. Install Homebrew and Node.js 22 or newer, then copy these commands into Terminal:

~~~bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install git node
git clone https://github.com/locmaymo/stm.git
cd stm
npm ci
node deploy/linux/launcher.mjs
~~~

Open <code>http://127.0.0.1:7860</code>. SillyTavern remains at <code>http://127.0.0.1:8000</code>. Stop the process with <code>Ctrl+C</code>. To start it again later:

~~~bash
cd stm
node deploy/linux/launcher.mjs
~~~

The current macOS source launcher stores data under <code>~/.local/share/sillytavern-manager</code>. The repository is the same codebase used by the Windows, Termux, Linux, Docker, and hosted builds.

## Linux and VPS

Install Node.js 22 or newer, then run:

~~~bash
git clone https://github.com/locmaymo/stm.git
cd stm
npm ci
node deploy/linux/launcher.mjs
~~~

Linux data is stored under <code>$XDG_DATA_HOME/sillytavern-manager</code> or <code>~/.local/share/sillytavern-manager</code>. Keep port <code>7860</code> behind the VPS firewall or platform access control; expose SillyTavern through its configured tunnel instead of publishing the manager panel.

## Docker and VPS

Build the image from the repository:

~~~bash
git clone https://github.com/locmaymo/stm.git
cd stm
docker build -f deploy/docker/Dockerfile -t sillytavern-manager .
~~~

Run it with durable storage:

~~~bash
docker run --rm \
  -p 7860:7860 \
  -v sillytavern-manager-data:/data \
  -e STM_ADMIN_PASSWORD='choose-a-long-password' \
  sillytavern-manager
~~~

Open the manager at <code>http://127.0.0.1:7860</code>. SillyTavern stays on the container's internal port <code>8000</code>; a configured tunnel points only to that port.

For a hosted container platform, expose port <code>7860</code>, provide <code>STM_ADMIN_PASSWORD</code> through its secret settings, and mount durable storage at <code>/data</code>. Never put the admin password in a Dockerfile or commit it to Git.

### Hosts that publish one port, and hosts that do not keep your data

Some platforms route a single port from the outside world and announce it in <code>PORT</code>. The manager listens there without being asked, so a repository imported into such a platform works on the first run with nothing to configure. A port the manager only prefers &mdash; its own <code>7860</code>, the access gateway's <code>8001</code>, SillyTavern's <code>8000</code> &mdash; steps aside to the next free one when something else on the machine already holds it, and writes down where it went. Set <code>STM_PORT</code> or <code>STM_ACCESS_PORT</code> to pin one deliberately.

Some platforms also give the container a filesystem that is made with the machine and thrown away with it, and stop the machine once it has been idle for a while. The manager checks what its data directory is actually on and says so in the log and on the data page: this machine does not keep your data, connect Cloudflare R2.

That warning has a way out. Put the four <code>STM_R2_*</code> values in <code>.env</code> or in the platform's own environment settings, so they come back with the checkout rather than with the disk that was wiped. The manager then notices on the way up that the profile is empty and the bucket is not, and brings the newest recovery point back before SillyTavern starts. A profile that already holds something is never restored over.

Where a network does not let UDP out, cloudflared cannot reach Cloudflare's edge over QUIC and a tunnel sits at &ldquo;Registering tunnel&rdquo; until the link times out. The manager notices &mdash; from the error, or from the silence &mdash; and comes back over HTTP/2, remembering the answer so the wait is paid once. <code>STM_TUNNEL_PROTOCOL=http2</code> skips the discovery.

## npm (technical users)

On a machine with Node.js 22 or newer, use the published package when it is available:

~~~bash
npx sillytavern-manager
~~~

Or install it globally:

~~~bash
npm install --global sillytavern-manager
sillytavern-manager
~~~

Windows users should prefer the portable ZIP because it includes Node.js. The package and the source launcher use the same ports and data-directory rules.

## First setup

1. Open the manager at port <code>7860</code>.
2. Create the manager administrator password.
3. Choose a SillyTavern version; <code>latest</code> is selected by default.
4. Press **Install** and wait for **Ready**. Ready means SillyTavern answered on port <code>8000</code>.
5. Open the local link, or enable local-network access or a public tunnel in the access card.
6. Set the SillyTavern password before enabling LAN or a public tunnel.

The manager password and the SillyTavern password are separate. The SillyTavern password is asked for by a sign-in page the manager serves, so it works the same on every SillyTavern version, old or new; changing it signs out every device that was already in. The public tunnel never forwards the manager panel.

## Backup and restore

Local backup is always available. The archive is a streaming ZIP compatible with SillyTavern exports. By default it excludes <code>secrets.json</code>, thumbnails, vectors, generated backups, <code>.git</code>, <code>node_modules</code>, and operating-system metadata. Including secrets is an explicit action with a warning.

Restore previews the archive before writing. Replace is the default mode; merge is available when needed. A safety snapshot is created before a replace or profile switch. Cloudflare R2 is optional and recommended for protection against a failed disk, a deleted hosted workspace, or a lost machine.

### Cloudflare R2

On the **Data** page, **Connect Cloudflare** is the one step. Sign in to Cloudflare, pick the account, allow the permissions, and the manager finds or creates a bucket named <code>sillytavern-manager-backup</code> in that account and starts backing up to it. There are no keys to create or paste.

- **Allow Workers** (optional, recommended). The manager deploys a small Worker, also named <code>sillytavern-manager-backup</code>, that carries backup data to the bucket. It is fast and does not use your Cloudflare API rate limit. Without it, backups go through Cloudflare's API, which is slower, and a first backup can take a long time.
- **Allow Account Analytics** (optional). The panel then shows storage and Class A/B operations as Cloudflare counts them, for the backup bucket and for the whole account against the free tier. These are usage figures, not your bill.
- **A new machine** connects to the same account and finds the same bucket; the recovery points already in it can be brought back and restored.
- **Disconnect** removes this installation's Worker key and revokes the sign-in. The bucket and its recovery points stay in your account. You can also revoke access at any time under **Manage OAuth authorizations** in your Cloudflare profile.

Only the Cloudflare refresh token is stored, in its own file readable by your user alone. Worker keys live in memory, change every day, and each installation has its own.

**S3 keys instead.** If you would rather not sign in, choose **S3 keys (manual)** and enter the endpoint, bucket and key pair from the R2 page of the Cloudflare dashboard, or set them in <code>.env</code> (see <code>.env.example</code>). Any S3-compatible storage works this way.

## Telemetry and privacy

Telemetry is part of this free project. The manager sends only an allowlisted summary such as platform, application version, provider, model, endpoint hostname, streaming flag, max tokens, input/output/total tokens, cache usage, reasoning-token usage, status, and duration.

It does **not** send API keys, authorization headers, prompts, chats, model responses, request bodies, response bodies, request logs, file names, file paths, IP addresses, or URL query strings. Events are written to a local outbox first and sent asynchronously; a receiver outage does not block SillyTavern.

## Updating

When a new manager release is published, stop the old manager, extract the new Windows ZIP into a new folder, and run the new executable. On Termux, macOS, or Linux, stop the process, run <code>git pull --ff-only</code>, run <code>npm ci</code>, and start the launcher again. The platform data directory is preserved, so profiles, backups, logs, metrics, and settings remain available. Keep the old Windows folder for rollback.

Release builds are generated from version tags. GitHub Actions verifies the project, creates the Windows ZIP and checksum, builds the Docker image, and creates the npm tarball.

## Development

Requirements: Node.js 22+, npm 11+, and PowerShell 7+ for Windows packaging.

~~~bash
npm ci
npm run panel:dev
npm run manager:start
~~~

Run the repository checks before opening a pull request:

~~~bash
npm run verify
~~~

Build release artifacts locally on Windows:

~~~powershell
pwsh packaging/windows/package-release.ps1
npm run release:npm
~~~

## License

Copyright (C) 2026 Phạm Quang Lộc

SillyTavern Manager is free software: you can redistribute it and/or modify it under the terms of the [GNU Affero General Public License version 3](LICENSE) (AGPL-3.0-only) as published by the Free Software Foundation.

This license applies to every version of the project, including all commits and releases published before the `LICENSE` file was added, such as v0.1.0.

Third-party code keeps its own license; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The SillyTavern Vietnam (STVN) logo and the third-party logos described there are not covered by the AGPL-3.0.
