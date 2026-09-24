/**
 * Every command the documentation tells somebody to run.
 *
 * Commands are not prose and are not translated: `npm ci` is `npm ci` in both
 * languages, and a shell line that had been copied into two content files
 * would eventually be corrected in one of them. They live here once, are
 * referenced by name from either language, and so cannot disagree.
 */
export const snippets = {
  termuxInstall: {
    lang: 'bash',
    code: `pkg update -y
pkg upgrade -y
pkg install -y git nodejs-lts
git clone https://github.com/locmaymo/stm.git
cd stm
npm ci
npm start`,
  },
  termuxStart: {
    lang: 'bash',
    code: `cd "$HOME/stm"
npm start`,
  },
  termuxUpdate: {
    lang: 'bash',
    code: `cd "$HOME/stm"
git pull --ff-only
npm ci
npm start`,
  },
  macosInstall: {
    lang: 'bash',
    code: `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install git node
git clone https://github.com/locmaymo/stm.git
cd stm
npm ci
node deploy/linux/launcher.mjs`,
  },
  macosStart: {
    lang: 'bash',
    code: `cd "$HOME/stm"
node deploy/linux/launcher.mjs`,
  },
  linuxInstall: {
    lang: 'bash',
    code: `git clone https://github.com/locmaymo/stm.git
cd stm
npm ci
node deploy/linux/launcher.mjs`,
  },
  linuxService: {
    lang: 'ini',
    code: `[Unit]
Description=SillyTavern Manager
After=network-online.target

[Service]
Type=simple
User=%i
WorkingDirectory=/home/%i/stm
ExecStart=/usr/bin/node deploy/linux/launcher.mjs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target`,
  },
  linuxServiceEnable: {
    lang: 'bash',
    code: `sudo systemctl daemon-reload
sudo systemctl enable --now sillytavern-manager@$USER
systemctl status sillytavern-manager@$USER`,
  },
  dockerBuild: {
    lang: 'bash',
    code: `git clone https://github.com/locmaymo/stm.git
cd stm
docker build -f deploy/docker/Dockerfile -t sillytavern-manager .`,
  },
  dockerRun: {
    lang: 'bash',
    code: `docker run --rm \\
  -p 7860:7860 \\
  -v sillytavern-manager-data:/data \\
  -e STM_ADMIN_PASSWORD='choose-a-long-password' \\
  sillytavern-manager`,
  },
  npmRun: {
    lang: 'bash',
    code: 'npx sillytavern-manager',
  },
  npmGlobal: {
    lang: 'bash',
    code: `npm install --global sillytavern-manager
sillytavern-manager`,
  },
  sourceUpdate: {
    lang: 'bash',
    code: `git pull --ff-only
npm ci`,
  },
  telemetryOff: {
    lang: 'bash',
    code: `# .env, next to the repository or the launcher
STM_TELEMETRY_ENDPOINT=`,
  },
  portCheck: {
    lang: 'bash',
    code: `# Linux, macOS and Termux
ss -ltnp | grep -E ':(7860|8002|8001)' || lsof -i :7860`,
  },
  portCheckWindows: {
    lang: 'powershell',
    code: 'Get-NetTCPConnection -LocalPort 7860 -State Listen | Select-Object OwningProcess',
  },
};
