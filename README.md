<div align="center">

<img src="apps/manager-panel/public/brand-mark.png" alt="SillyTavern Manager" width="104" height="104">

# SillyTavern Manager

**One control panel that installs, runs, shares, backs up and watches [SillyTavern](https://github.com/SillyTavern/SillyTavern) — on Windows, Android, macOS, Linux and Docker.**

[![Latest release](https://img.shields.io/github/v/release/locmaymo/stm?style=flat-square&label=release&color=2563eb)](https://github.com/locmaymo/stm/releases/latest)
[![npm](https://img.shields.io/npm/v/sillytavern-manager?style=flat-square&logo=npm&logoColor=white&color=cb3837)](https://www.npmjs.com/package/sillytavern-manager)
[![Verify](https://img.shields.io/github/actions/workflow/status/locmaymo/stm/verify.yml?branch=main&style=flat-square&label=verify)](https://github.com/locmaymo/stm/actions/workflows/verify.yml)
[![Release downloads](https://img.shields.io/github/downloads/locmaymo/stm/total?style=flat-square&label=downloads&color=16a34a)](https://github.com/locmaymo/stm/releases)
[![npm downloads](https://img.shields.io/npm/dm/sillytavern-manager?style=flat-square&label=npm%20downloads&color=16a34a)](https://www.npmjs.com/package/sillytavern-manager)
[![Node.js 22+](https://img.shields.io/badge/node-%E2%89%A5%2022-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![License AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-8b5cf6?style=flat-square)](LICENSE)

[Website](https://stm.locmaymo.top) ·
[Documentation](https://stm.locmaymo.top/docs) ·
[Download](https://github.com/locmaymo/stm/releases/latest) ·
[npm](https://www.npmjs.com/package/sillytavern-manager) ·
[Quick start](#quick-start) ·
[Screenshots](#screenshots) ·
[How it works](#how-it-works) ·
[Backups](#backup-and-restore) ·
[Tiếng Việt](README.vi.md)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/screenshots/en/overview-dark.webp">
  <img src=".github/screenshots/en/overview-light.webp" alt="The SillyTavern Manager overview page: SillyTavern running, remote access, data and backups, system usage and live logs" width="900">
</picture>

</div>

---

## What it does

SillyTavern Manager does the technical parts of SillyTavern for you — installing it, keeping it running, updating it, backing it up and opening it on your other devices — from one page in your browser. No terminal, no long commands to copy.

### Never lose a chat again

Sign in to Cloudflare once, and your chats, characters and settings are copied to free cloud storage in **your own** account every few minutes, by themselves. If your computer breaks, your phone is lost, or you delete something by mistake, sign in again on any device and everything comes back.

- Backs up on its own, every few minutes — only what changed
- Free with Cloudflare R2’s free plan (10 GB)
- One sign-in on a new device brings back your chats, the SillyTavern version and your settings

<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/screenshots/en/f-signin-dark.webp">
  <img src=".github/screenshots/en/f-signin-light.webp" alt="The first-run offer to connect your own cloud storage" width="360">
</picture>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/screenshots/en/f-cloud-dark.webp">
  <img src=".github/screenshots/en/f-cloud-light.webp" alt="The cloud backup card: backing up every 5 minutes, the last copy, and recovery points to bring back" width="440">
</picture>
</p>

### Your SillyTavern, on every device

Switch on one link and SillyTavern opens on your phone, tablet or another computer — at home or anywhere else. Scan the QR code to open it on your phone in a second. Your own PIN keeps everybody else out.

- A link that stays the same, so bookmarks keep working
- Scan a QR code instead of typing an address
- Locked with a PIN only you know; the manager itself stays behind its own password

<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/screenshots/en/f-link-dark.webp">
  <img src=".github/screenshots/en/f-link-light.webp" alt="The Open SillyTavern menu with Open with tools and a QR code to open SillyTavern on a phone">
</picture>
</p>

### Any SillyTavern version, one click

Pick the version you like from the list and press **Install**. The manager downloads it from SillyTavern’s official GitHub and sets it up for you. Want to try a newer one, or go back to the one you liked? Same list, same button — your chats are copied somewhere safe first.

- Start and stop SillyTavern with a button
- Switch versions without reinstalling anything
- Always the official release, straight from GitHub

<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/screenshots/en/f-versions-dark.webp">
  <img src=".github/screenshots/en/f-versions-light.webp" alt="The version list open on the overview">
</picture>
</p>

### New releases, the moment they are out

When SillyTavern publishes a new version, a notice appears right on your overview. Press **Install it** and you are up to date; **Not now** hides it until the next one.

- Told on the page, no need to watch GitHub
- One click to update, with your data copied to safety first

<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/screenshots/en/f-update-dark.webp">
  <img src=".github/screenshots/en/f-update-light.webp" alt="A notice on the overview saying SillyTavern 1.19.0 is out, with Install it and Not now">
</picture>
</p>

### Bring back a backup with one button

Moving from an old SillyTavern? Upload the ZIP you downloaded from it, or a backup from another SillyTavern Manager. No extra apps, no unzipping, no hunting for the right folder. The manager shows what is inside, takes a copy of what you have now, then puts it all back.

- Works with SillyTavern’s own backup ZIP
- See what is inside before anything changes
- A safety copy is taken first, so a mistake can be undone

<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/screenshots/en/f-restore-dark.webp">
  <img src=".github/screenshots/en/f-restore-light.webp" alt="The restore window for an uploaded ZIP: 1604 files, replace or merge" width="520">
</picture>
</p>

### SillyTavern, with a toolbox beside it

**Open with tools** puts a small button at the edge of SillyTavern. Back up to your computer or to the cloud without leaving your chat, read the live logs when something looks wrong, reload SillyTavern or go full screen — no terminal window needed, on a phone as well as a computer.

- Back up in the middle of a chat
- Live logs from SillyTavern and the manager
- Works through the online link too

<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/screenshots/en/f-tools-dark.webp">
  <img src=".github/screenshots/en/f-tools-light.webp" alt="SillyTavern with the tools menu open: back up, logs, reload" width="420">
</picture>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/screenshots/en/f-logs-dark.webp">
  <img src=".github/screenshots/en/f-logs-light.webp" alt="SillyTavern with the live logs panel open" width="420">
</picture>
</p>

### Little space? It still fits

On a phone or a small server that is nearly full, **Saver mode** keeps your backups in the cloud instead of on the device. When a backup is too big to bring back, it offers to leave out what SillyTavern does not need — old extension downloads, thumbnails, SillyTavern’s own backup copies — and every chat, character and setting still comes back.

- Turns itself on when space is short
- Leaves out files SillyTavern can do without
- Refuses a restore that would not fit, instead of failing halfway

<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/screenshots/en/f-saver-dark.webp">
  <img src=".github/screenshots/en/f-saver-light.webp" alt="A restore in saver mode shrinking 1.7 GB to 823 MB by leaving out what SillyTavern can do without" width="520">
</picture>
</p>

### Free forever, and your data stays yours

- **Free for life.** No subscription, no trial, no limits — open source under the AGPL-3.0.
- **The official SillyTavern.** Always downloaded from its official GitHub repository; its files are never changed.
- **Only you hold your data.** Chats and characters stay on your device and in your own Cloudflare account. This project has no server that stores them.
- **Locked with your passwords.** The manager opens with your password and SillyTavern with your PIN; too many wrong guesses and the door locks itself.

The manager sends a small, anonymous usage summary — never your chats, prompts, characters or keys. See [Telemetry](#telemetry) for every field and how to switch it off.

### And also

| | |
| --- | --- |
| **Run and watch** | Start, stop and open SillyTavern from the panel, with live logs from the manager, SillyTavern, the installer, backups and the tunnel in one searchable feed. |
| **Share safely** | SillyTavern itself stays on localhost. Other devices and Cloudflare Tunnel reach it through the manager's access gateway, which asks for a password first and never forwards the admin panel. |
| **A link that keeps working** | Sign in to Cloudflare and the manager puts `sillytavern.<you>.workers.dev` and `stm.<you>.workers.dev` in front of the tunnels. A Quick Tunnel's own hostname changes every restart; these two never do. |
| **Reach your own machine** | The console has its own link, behind the manager password, for administering the machine from somewhere else. It is a separate switch from the one you share. |
| **Stay awake** | **Keep STM online** stops a battery saver, or a host that shuts idle programs down, from putting the manager to sleep — and SillyTavern with it. |
| **Know your usage** | Requests, tokens, cache hits and latency per day, per provider and per model, measured from SillyTavern's own traffic. |
| **Keep data separate** | Named profiles for separate SillyTavern data sets, switched from the panel, each with its own backups. |
| **Speak your language** | English and Vietnamese, light and dark, desktop and phone. |

## Quick start

| Platform | Start here |
| --- | --- |
| **Windows** | [Download the portable ZIP](#windows) — nothing to install |
| **Android** | [Copy the Termux commands](#android-termux) |
| **macOS** | [Install from source](#macos) |
| **Linux / VPS** | [Run the Unix launcher](#linux-and-vps) |
| **Docker / hosted** | [Build and run the image](#docker-and-hosted-platforms) |
| **npm** | [Use the package](#npm) |

Whichever you choose, the first visit asks you to create one manager administrator password. Then pick a SillyTavern version and press **Install**.

<details id="windows">
<summary><b>Windows — download and run</b></summary>

<br>

1. Open the [latest GitHub release](https://github.com/locmaymo/stm/releases/latest).
2. Download `SillyTavernManager-windows-x64-vX.Y.Z.zip` and its `.sha256` checksum file.
3. Extract the ZIP to a normal folder, such as `Downloads\SillyTavernManager`.
4. Double-click `SillyTavernManager.exe`.
5. Open `http://127.0.0.1:7860` if the browser does not open by itself.

A console window opens and stays open. That window is the manager: it shows the address, where your data is kept, and what the manager and SillyTavern are doing. To stop everything, press <kbd>Q</kbd> or <kbd>Ctrl</kbd>+<kbd>C</kbd> in it, or close it — SillyTavern and the Cloudflare tunnel are shut down with it, so no port is left held and there is no process to hunt for in Task Manager. Press <kbd>O</kbd> to open the panel in your browser again.

If the manager fails to start, the window keeps the reason on screen and waits for <kbd>Enter</kbd> rather than closing. Starting a second copy while one is already running says so and opens the running one instead.

The portable bundle already contains Node.js, the manager server, the panel and production dependencies. Nothing needs a terminal. The application folder and the data folder stay separate, so replacing the ZIP never touches your data:

```text
%LOCALAPPDATA%\SillyTavernManager
```

</details>

<details id="android-termux">
<summary><b>Android — Termux, copy and paste</b></summary>

<br>

Install [Termux from F-Droid](https://f-droid.org/packages/com.termux/) or another trusted source. Do not use the old Play Store build. Open Termux and paste these commands one block at a time:

```bash
pkg update -y
pkg upgrade -y
pkg install -y git nodejs-lts
git clone https://github.com/locmaymo/stm.git
cd stm
npm ci
npm start
```

Leave that Termux session running while SillyTavern is in use. Open the manager on the phone at `http://127.0.0.1:7860`; SillyTavern itself is at `http://127.0.0.1:8002`. The manager can create a public tunnel when you want to reach SillyTavern from an iPhone or another network.

Later starts:

```bash
cd "$HOME/stm"
npm start
```

Updates, after stopping the running manager:

```bash
cd "$HOME/stm"
git pull --ff-only
npm ci
npm start
```

Termux data is stored outside the repository at `$PREFIX/var/sillytavern-manager`, so it survives `git pull` and application updates.

Cloudflared is optional; local access keeps working when a tunnel is not installed or is offline. Turning the tunnel on in Termux needs nothing installed by hand: Android starts position-independent executables only and Cloudflare's own builds are not, so the manager asks Termux for its build of cloudflared and, failing that, runs Cloudflare's through `proot`, installing whichever of the two it ends up needing.

</details>

<details id="macos">
<summary><b>macOS — install from source</b></summary>

<br>

macOS uses the same Node.js launcher as Linux. Install Homebrew and Node.js 22 or newer, then copy these commands into Terminal:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install git node
git clone https://github.com/locmaymo/stm.git
cd stm
npm ci
node deploy/linux/launcher.mjs
```

Open `http://127.0.0.1:7860`. SillyTavern remains at `http://127.0.0.1:8002`. Stop the process with <kbd>Ctrl</kbd>+<kbd>C</kbd>, and start it again later with:

```bash
cd "$HOME/stm"
node deploy/linux/launcher.mjs
```

Data is kept under `~/.local/share/sillytavern-manager`.

</details>

<details id="linux-and-vps">
<summary><b>Linux and VPS</b></summary>

<br>

Install Node.js 22 or newer, then run:

```bash
git clone https://github.com/locmaymo/stm.git
cd stm
npm ci
node deploy/linux/launcher.mjs
```

Data is stored under `$XDG_DATA_HOME/sillytavern-manager`, or `~/.local/share/sillytavern-manager` when that variable is unset.

Keep port `7860` behind the VPS firewall or platform access control. Expose SillyTavern through the tunnel or the access gateway instead of publishing the manager panel.

</details>

<details id="docker-and-hosted-platforms">
<summary><b>Docker and hosted platforms</b></summary>

<br>

Build the image from the repository:

```bash
git clone https://github.com/locmaymo/stm.git
cd stm
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

Open the manager at `http://127.0.0.1:7860`. SillyTavern stays on the container's internal port `8002`; a configured tunnel points only to that port.

For a hosted container platform, expose port `7860`, provide `STM_ADMIN_PASSWORD` through its secret settings and mount durable storage at `/data`. Never put the admin password in a Dockerfile or commit it to Git.

Hosted platforms often decide three things for you, and the manager now meets each of them without being configured.

**The port.** A platform that routes a single port from the outside world announces it in `PORT`; the manager listens there, so a repository imported into one works on the first run. A port the manager only *prefers* — its own `7860`, the access gateway's `8001`, SillyTavern's `8002` — steps aside to the next free one when something else on the machine already holds it, and writes down where it went. Set `STM_PORT` or `STM_ACCESS_PORT` to pin one deliberately; a pinned port is bound or the start fails, rather than moving.

**The network.** Where outbound UDP is blocked, cloudflared cannot reach Cloudflare's edge over QUIC, and a tunnel sits at *Registering tunnel* until the link times out with error 1033. The manager notices — from the error line, or from the silence — and comes back over HTTP/2, remembering the answer so the wait is paid once rather than at every restart. `STM_TUNNEL_PROTOCOL=http2` skips the discovery.

**The disk.** Some platforms give the container a filesystem that is made with the machine and thrown away with it, and stop the machine once it has been idle. The manager checks what its data directory is actually on, and says so in the log and on the data page: this machine does not keep your data, connect Cloudflare R2.

That last warning has a way out. Put the four `STM_R2_*` values in `.env` or in the platform's own environment settings, so they come back with the checkout rather than with the disk that was wiped. The manager then notices on the way up that the profile is empty and the bucket is not, and brings the newest recovery point back before SillyTavern starts. A profile that already holds something is never restored over.

</details>

<details id="npm">
<summary><b>npm (technical users)</b></summary>

<br>

The manager is published on npm as [`sillytavern-manager`](https://www.npmjs.com/package/sillytavern-manager). On a machine with Node.js 22 or newer:

```bash
npx sillytavern-manager
```

Or install it globally:

```bash
npm install --global sillytavern-manager
sillytavern-manager
```

Windows users should prefer the portable ZIP, because it already includes Node.js. The package and the source launcher use the same ports and data-directory rules.

</details>

### First setup

1. Open the manager at port `7860` and create the manager administrator password — or press **Continue with Cloudflare**, which sets the manager up and connects backups in one step, and lets that Cloudflare account open the manager again later.
2. Choose a SillyTavern version — `latest` is selected by default.
3. Press **Install** and wait for **Ready**. Ready means SillyTavern answered on port `8002`.
4. Open the local link, or set the SillyTavern PIN and then turn on local-network access or a public tunnel.

The manager password and the SillyTavern PIN are two different things. The PIN is asked for by a sign-in page the manager serves, so it works the same on every SillyTavern version, old or new; changing it signs out every device that was already in.

Until everything is in place, a **Setup checklist** on the overview lists the six steps worth taking — install SillyTavern, connect Cloudflare, set the STM password and the SillyTavern PIN, turn on R2 backups and open SillyTavern's link — and ticks each one off as it happens. A step stays ticked once done, and the list folds itself away when all six are.

### Using SillyTavern from the panel

**Use it here**, on the preview in the overview, opens SillyTavern inside the manager's own page. It is signed in already — the manager password you gave is the stronger of the two, so the PIN is not asked for — and a bar above it can **minimize** it back to the console while it stays loaded, give it the **full screen**, **back up** on this machine or to the cloud, show the **logs**, reload it or move it to a tab. **Close** unloads it and gives its memory back.

The arrow beside **Open SillyTavern** offers **Open with tools**: a new tab with the same window bar and a floating tools button. From another device, where a page cannot be put inside the console, the same buttons open SillyTavern in a tab at the best address instead.

## Screenshots

Every shot below is taken with demo data and follows your own system theme, light or dark.

<table>
<tr>
<td width="50%" valign="top">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/screenshots/en/data-dark.webp">
  <img src=".github/screenshots/en/data-light.webp" alt="Data page with profiles, local backups and Cloudflare R2">
</picture>
</td>
<td width="50%" valign="top">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/screenshots/en/metrics-dark.webp">
  <img src=".github/screenshots/en/metrics-light.webp" alt="Metrics page with requests, tokens, cache hits and latency">
</picture>
</td>
</tr>
<tr>
<td><b>Data</b> — profiles, scheduled and manual backups, Cloudflare R2 in one page.</td>
<td><b>Metrics</b> — requests, tokens, cache hits and latency, per day, provider and model.</td>
</tr>
<tr>
<td valign="top">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/screenshots/en/settings-dark.webp">
  <img src=".github/screenshots/en/settings-light.webp" alt="Settings page with security and SillyTavern configuration">
</picture>
</td>
<td valign="top">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/screenshots/en/sign-in-dark.webp">
  <img src=".github/screenshots/en/sign-in-light.webp" alt="The manager sign-in screen">
</picture>
</td>
</tr>
<tr>
<td><b>Settings</b> — passwords, and SillyTavern's own <code>config.yaml</code> as plain switches.</td>
<td><b>Sign in</b> — one password opens the manager, and only the manager.</td>
</tr>
</table>

<table>
<tr>
<td width="25%" valign="top">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/screenshots/en/overview-mobile-dark.webp">
  <img src=".github/screenshots/en/overview-mobile-light.webp" alt="The overview page on a phone">
</picture>
</td>
<td width="25%" valign="top">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/screenshots/en/data-mobile-dark.webp">
  <img src=".github/screenshots/en/data-mobile-light.webp" alt="The data page on a phone">
</picture>
</td>
<td width="25%" valign="top">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/screenshots/en/metrics-mobile-dark.webp">
  <img src=".github/screenshots/en/metrics-mobile-light.webp" alt="The metrics page on a phone">
</picture>
</td>
<td width="25%" valign="top">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/screenshots/en/settings-mobile-dark.webp">
  <img src=".github/screenshots/en/settings-mobile-light.webp" alt="The settings page on a phone">
</picture>
</td>
</tr>
<tr>
<td colspan="4" align="center"><b>On a phone</b> — the same panel, with the navigation moved to the bottom.</td>
</tr>
</table>

## How it works

Three ports, and only one of them is ever shared:

```mermaid
flowchart LR
  subgraph machine["Your machine"]
    M["Manager panel<br/>:7860"]
    G["Access gateway<br/>:8001"]
    S["SillyTavern<br/>:8002 · localhost only"]
    M --> S
    G --> S
  end
  subgraph cf["Cloudflare, when you sign in"]
    WS["sillytavern.&lt;you&gt;.workers.dev"]
    WM["stm.&lt;you&gt;.workers.dev"]
  end
  A["You, on this machine"] --> M
  B["Phone or laptop<br/>on the same Wi-Fi"] -- password --> G
  C["Anyone you send the link to"] --> WS
  D["You, from anywhere"] -- manager password --> WM
  WS -- tunnel · password --> G
  WM -- tunnel --> M
```

| Port | What listens | Who can reach it |
| --- | --- | --- |
| `7860` | The manager panel | This machine, and you from anywhere once you switch its own link on |
| `8002` | SillyTavern | This machine only |
| `8001` | The access gateway | Your local network or a Cloudflare Tunnel, after a password |

Two separate switches, because the two links are given to different people. **Cloudflare tunnel** on the overview opens the gateway, which asks for the SillyTavern password and never forwards the admin panel — that is the link you send to somebody you want to chat with. **Open this manager to the internet**, in **Settings**, opens the console itself behind the manager password; it is for reaching your own machine from another one, not for sharing.

### Addresses that do not change

A Cloudflare Quick Tunnel gets a random hostname, and a different one every time it starts — so a link saved yesterday is a dead name today, and a phone that had it bookmarked gets `DNS_PROBE_FINISHED_NXDOMAIN` rather than a page that says to try later.

Sign in to Cloudflare (the same sign-in that sets up backups) and the manager puts two small Workers on your account's own `workers.dev` subdomain: `sillytavern.<you>.workers.dev` in front of SillyTavern and `stm.<you>.workers.dev` in front of the console. They forward to whichever tunnel is running and are redeployed the moment it changes, so the address you write down, bookmark or send is yours for good. While the machine is off they answer with a short page saying so.

The manager will not deploy over a Worker of those names that it did not create, so an account that already has one keeps it — the panel says so instead. Disconnecting Cloudflare removes both.

With a sign-in each link therefore has two addresses: the **fixed link** through the Worker, and the **tunnel link** straight to cloudflared, which changes at every start. The card shows one and keeps the other behind a count beside it. **Show this link first** puts either one in front — on the card, behind **Open** and in the QR code — for somebody who finds the Worker slower or only ever opens the link on the machine in front of them; the fixed link can also be hidden altogether, and the Worker keeps following the tunnel so an address already shared goes on working. A new tunnel's address is handed out only once it answers, and while the Worker is being pointed at it the fixed link says it is on its way rather than offering one that would fail.

A free Cloudflare account answers 100,000 Worker requests a day, resetting at midnight UTC, and those two addresses share that allowance with the Worker that carries your backups. Running it out would take all three down at once, so the manager watches the figure and gives things up in order before that can happen: first the console quietly asks for updates less often, then the console's own fixed address is held back, and last SillyTavern's. In each case the tunnel's own address is offered in its place, and everything is handed out again when the allowance resets. It is written in the log when it happens, and there is nothing to press.

In ordinary personal use this never comes up — a console left open all day, SillyTavern in use and backups running costs around a tenth of the allowance. What can reach it is sharing your SillyTavern link widely: a page load costs roughly 320 requests, so the ceiling is about 300 of them a day. Note also that an address somebody already bookmarked keeps going through the Worker; holding one back protects the links handed out from that point on, not one already in somebody's browser.

Where your data lives:

| Platform | Data directory |
| --- | --- |
| Windows | `%LOCALAPPDATA%\SillyTavernManager` |
| macOS and Linux | `$XDG_DATA_HOME/sillytavern-manager`, else `~/.local/share/sillytavern-manager` |
| Termux | `$PREFIX/var/sillytavern-manager` |
| Docker | `/data` (mount it) |

The directory holds profiles, backups, logs, metrics and the telemetry outbox. It is never inside the application folder, so updating the application never touches it.

### Keeping it awake

A program nobody has asked anything of for a while can be put to sleep — by a laptop's battery saver, a phone's power management, or a host that stops idle containers — and SillyTavern goes with it. **Settings → While the manager is open → Keep STM online**, on by default, has the manager reach its own address on a clock so it is never idle: every 15 minutes, or every 5, 10, 30 or 60 if the machine goes quiet sooner or later than that.

The address it holds is the one you set in `STM_PUBLIC_ORIGIN`, otherwise the one your browser last reached the console at, otherwise this machine's own `127.0.0.1` — never the tunnel or the Worker, so it costs nothing from the Cloudflare allowance. The card says which address it is holding and when it last answered. The choice travels to the bucket with the rest of the manager's settings.

## Backup and restore

Local backup is always available. The archive is a streaming ZIP compatible with SillyTavern exports. By default it excludes `secrets.json`, thumbnails, vectors, generated backups, `.git`, `node_modules` and operating-system metadata. Including secrets is an explicit action with a warning.

Restore previews the archive before writing. Replace is the default mode; merge is available when needed. A safety snapshot is created before a replace or a profile switch.

On the **Data** page, **Back up automatically** takes an archive every 30 minutes, hour, six hours or day when the data has changed, and keeps the newest one (`STM_LOCAL_BACKUPS` keeps more). **Create a restore point** takes one on purpose, with a note of your own — "before updating extensions" — and the manager never deletes a restore point, an upload or a recovery point brought back from R2 by itself. The safety copy taken before a restore or a profile switch is kept as the undo for the last such change. Every archive carries its kind, and the list can be searched and filtered by it. **Upload a ZIP** restores an export from elsewhere.

Before a replace, the preview says what it takes away: the files in the profile that the archive does not have.

### Saver mode

For a machine with little room for files — a container that keeps everything in memory, a phone that is nearly full — archives on the machine are the thing that runs it out. A restore of a 2 GB profile used to hold it three times over: the uploaded ZIP, a safety copy of the profile it was replacing, and the files themselves.

With **Saver mode** on, no archive is kept on the machine at all and the profile is on the disk once. Your Cloudflare R2 bucket holds the recovery points instead, and it stands in for the safety copy: before a restore replaces anything, the current data is sent to R2 first. An uploaded ZIP and a recovery point brought back from R2 are written straight into the profile as they arrive, with SillyTavern stopped. The manager checks that the restore fits before it starts, offers to leave out what SillyTavern can do without — extensions' git history and `node_modules`, SillyTavern's own backups, thumbnails — when room is short, and refuses one that still will not fit rather than failing halfway.

It turns itself on when the data directory is kept in memory, or when the disk has less than 5 GiB free as the manager starts, and says which of the two it was. Otherwise it is a switch under **Settings → When the manager opens**, or `STM_SAVER=1` / `STM_SAVER=0` to settle it for good. Connect R2 before relying on it: with saver mode on and no bucket, nothing holds your data but the profile itself.

### Cloudflare R2

On the **Data** page, **Where backups go** is the one question, and **Connect Cloudflare** is the one step in answering it. Sign in to Cloudflare, pick the account, allow the permissions, and the manager finds or creates a bucket named `sillytavern-manager-backup` in that account and starts backing up to it. There are no keys to create or paste.

If the account has never enabled R2, Cloudflare refuses to make the bucket however many permissions were granted, and the panel says so with a link to the page that turns it on. R2 has to be enabled once in the Cloudflare dashboard and Cloudflare asks for a card before it will; the first 10 GB stay free and nothing is charged until you pass the free tier.

- **Allow Workers** (optional, recommended). The manager deploys a small Worker, also named `sillytavern-manager-backup`, that carries backup data to the bucket. It is fast and does not use your Cloudflare API rate limit. Without it, backups go through Cloudflare's API, which is slower, and a first backup can take a long time.
- **Allow Account Analytics** (optional). The panel then shows storage and Class A/B operations as Cloudflare counts them, for the backup bucket and for the whole account against the free tier. These are usage figures, not your bill.
- **A new machine** connects to the same account and finds the same bucket; the recovery points already in it can be brought back and restored.
- **Disconnect** removes this installation's Worker key and revokes the sign-in. The bucket and its recovery points stay in your account. You can also revoke access at any time under **Manage OAuth authorizations** in your Cloudflare profile.
- **Check** reads the bucket once and says what is in it - how many objects, how large, how many recovery points - and brings the panel's own figures back in line with it. It is the one button for "does this work": there is nothing else to press to find out.

The recovery points shown are every one in the bucket, not only this machine's. A profile is identified by a name the machine that made it chose, so a machine set up today has one the bucket has never seen; listing only its own would show an empty table over a bucket holding a year of backups. Points written by another machine are marked, and bringing one back works the same way.

Only the Cloudflare refresh token is stored, in its own file readable by your user alone. Worker keys live in memory, change every day, and each installation has its own.

**S3 keys instead.** If you would rather not sign in, open **Where backups go**, choose **R2 or S3 keys** and enter the endpoint, bucket and key pair from the R2 page of the Cloudflare dashboard, or set them in `.env` (see [`.env.example`](.env.example)). Any S3-compatible storage works this way. Both ways of reaching a bucket are in that one form; saving is choosing which one carries the backups.

### Bringing a machine back

The bucket keeps more than your chats. Whenever they change, the manager writes its own settings beside the data: the manager password and the SillyTavern PIN (as the hashes it stores, never as text), the ports, the links and whether their Quick Tunnels were on, **Keep STM online**, the backup schedules and R2 limits, and the SillyTavern release that was actually running. The usage figures are kept there too.

On a new machine — a new computer, a reinstall, a container that starts empty — sign in with the same Cloudflare account, on the first-run screen or on the **Data** page. A profile that is empty while the bucket is not gets the newest recovery point back before SillyTavern is started, and SillyTavern is installed at the release you were running. When the account holds the setup of one of your other machines, a card on every page offers **Restore everything**: the data, the SillyTavern release, the console password, the PIN, the ports, the links, the backup schedules and the usage figures, in one go. SillyTavern is stopped while it runs, and what was on this machine is kept under Backups first. Nothing is applied on its own: a machine that is already set up is offered these settings, with the name of the machine that wrote them and when, and restoring the password asks you to sign in again.

One account backs up from one machine at a time, so two machines never sweep the same bucket. Signing in on a second machine makes it the one that backs up; the first stops, throws away its own sign-in, and says which machine took over. Signing in there again takes it back.

### Starting over

**Settings → Start over** erases everything this manager keeps on the machine: SillyTavern itself, every profile with the chats and characters in it, every backup on this disk, the R2 connection, the tunnel, the PIN and the manager password. It asks twice - a short wait before the button comes alive, and the manager password typed again - because a console left signed in on a desk is not the same as somebody asking for this.

What is already in your own R2 bucket stays there; nothing on the machine does. Afterwards the manager is the one you first started: the console reloads onto the first-run screen and setting a password begins again. cloudflared is the one thing kept, because it is a program downloaded from Cloudflare rather than anything you put here.

## Configuration

Everything can be set in the panel. These environment variables, read from the process or from a `.env` file at start, are for unattended installs; anything set here is shown in the panel and cannot be changed there.

| Variable | What it does |
| --- | --- |
| `STM_ADMIN_PASSWORD` | Creates the manager administrator password at first start, for Docker and hosted platforms |
| `STM_HOST` | The address to bind: `127.0.0.1` (this machine only) or `0.0.0.0` (every network). Set a password before opening it |
| `STM_PORT` · `STM_ACCESS_PORT` | Pin the console's port (`7860`) and the access gateway's (`8001`). Unset, a port something else holds is stepped over, and a host's `PORT` is used when it announces one |
| `STM_SAVER` | `1` or `0` settles [saver mode](#saver-mode) for good; the switch in the panel then cannot change it |
| `STM_STORAGE_IN_MEMORY` | `1` or `0` says whether files written here take the machine's memory. Detected on its own from the mount table (tmpfs, ramfs) and the Knative `K_SERVICE` variable |
| `STM_PUBLIC_ORIGIN` | The address the console is reached at from outside, behind a proxy that rewrites `Host`; also the address **Keep STM online** holds |
| `STM_TUNNEL_PROTOCOL` | `http2` to skip cloudflared's QUIC attempt on a network that does not let UDP out |
| `STM_LOCAL_BACKUPS` | How many automatic archives to keep on the machine (one by default) |
| `STM_R2_ENDPOINT` | R2 or S3 endpoint, `https://<account-id>.r2.cloudflarestorage.com` |
| `STM_R2_BUCKET` | Bucket name |
| `STM_R2_ACCESS_KEY_ID` | Access key ID |
| `STM_R2_SECRET_ACCESS_KEY` | Secret access key |
| `STM_CLOUDFLARE_OAUTH_CLIENT_ID` | Use an OAuth client registered in your own Cloudflare account; empty turns signing in off and leaves S3 keys |
| `STM_CLOUDFLARE_OAUTH_REDIRECT_URI` | Redirect URI of your own relay page (see [`deploy/oauth-relay`](deploy/oauth-relay)) |
| `STM_CLOUDFLARE_OAUTH_SCOPES` | Scopes requested at sign-in |

With all four `STM_R2_*` values set, R2 backups are switched on the first time the manager starts.

## Terms, disclaimer and privacy

The project's [Terms of Use](https://stm.locmaymo.top/terms), [Disclaimer](https://stm.locmaymo.top/disclaimer), [Privacy Notice](https://stm.locmaymo.top/privacy) and [Notices](https://stm.locmaymo.top/notices) are published on the site and ship inside the application: the first-run screen opens them from the line beside the tick, and **Settings → About** opens them again afterwards. The text lives once, in [`packages/legal`](packages/legal), and everything that shows it is a view of that file.

In short: this project is not affiliated with SillyTavern; it clones the public repository onto your machine at your request. It operates no service, holds no copy of your data, and has nothing to moderate. Cloudflare resources and the charges they carry are yours, in your own account. Backups are a tool rather than a promise.

### Telemetry

Telemetry is part of this free project. The manager sends only an allowlisted summary: platform, application version, provider, model, endpoint hostname, streaming flag, max tokens, input/output/total tokens, cache usage, reasoning-token usage, status and duration.

It does **not** send API keys, authorization headers, prompts, chats, model responses, request bodies, response bodies, request logs, file names, file paths, IP addresses or URL query strings. Events are written to a local outbox first and sent asynchronously, so a receiver outage never blocks SillyTavern.

## Updating

| Platform | How |
| --- | --- |
| Windows | Stop the old manager, extract the new ZIP into a new folder, run the new executable. Keep the old folder for rollback. |
| Termux, macOS, Linux | Stop the process, then `git pull --ff-only`, `npm ci`, and start the launcher again. |
| Docker | Rebuild the image and start a new container against the same volume. |

The platform data directory is preserved either way, so profiles, backups, logs, metrics and settings remain.

Release builds are generated from version tags: GitHub Actions verifies the project, creates the Windows ZIP and checksum, builds the Docker image and creates the npm tarball.

## Development

Requirements: Node.js 22+, npm 11+, and PowerShell 7+ for Windows packaging.

```bash
npm ci
npm run panel:dev      # the panel, with hot reload
npm run manager:start  # the manager server
```

Run the repository checks before opening a pull request:

```bash
npm run verify         # encoding gate, lint, typecheck, tests
```

Build release artifacts locally on Windows:

```powershell
pwsh packaging/windows/package-release.ps1
npm run release:npm
```

### Repository layout

| Path | What lives there |
| --- | --- |
| `apps/manager-server` | HTTP API, sessions, access gateway, job runner |
| `apps/manager-panel` | The React panel served at port `7860` |
| `packages/sillytavern-runtime` | Installing, updating and running SillyTavern |
| `packages/backup` · `packages/r2` | ZIP archives and restores · R2 and S3 transfers |
| `packages/cloudflare` · `packages/tunnel` | Cloudflare sign-in, Workers and usage · cloudflared |
| `packages/profiles` · `packages/config` | Data profiles · `config.yaml` the panel can edit |
| `packages/instrumentation` · `packages/telemetry` | Usage capture · the outbox that sends summaries |
| `packages/platform` · `packages/contracts` · `packages/ui` | Per-OS paths · shared types · components and locales |
| `deploy/` · `packaging/` | Docker, Linux, Termux, OAuth relay · Windows release |

Contributions are welcome. Please read [`AGENTS.md`](AGENTS.md) first: repository text is UTF-8 without BOM and NFC-normalized, English is the canonical locale, Vietnamese translations are additive only, and `npm run verify` has to pass.

## License

Copyright (C) 2026 locmaymo

SillyTavern Manager is free software: you can redistribute it and/or modify it under the terms of the [GNU Affero General Public License version 3](LICENSE) (AGPL-3.0-only) as published by the Free Software Foundation.

This license applies to every version of the project, including all commits and releases published before the `LICENSE` file was added, such as v0.1.0.

Third-party code keeps its own license; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The SillyTavern Vietnam (STVN) logo and the third-party logos described there are not covered by the AGPL-3.0.
