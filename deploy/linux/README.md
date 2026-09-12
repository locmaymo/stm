# Linux and VPS

Run `node deploy/linux/launcher.mjs` from the repository after `npm ci`. The manager binds to `127.0.0.1:7860` by default; set `STM_HOST=0.0.0.0` only when the management port is intentionally published behind the platform's own access control. SillyTavern remains on port `8000` and durable state follows `$XDG_DATA_HOME` or `~/.local/share`.
