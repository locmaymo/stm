# Termux

Install Node.js in Termux, clone this repository, run `npm ci`, then start `node deploy/termux/launcher.mjs`. The manager uses `$PREFIX/var/sillytavern-manager` by default and has no native Node module dependency. Cloudflared is optional; when unavailable the tunnel card reports the missing capability while local access continues to work.
