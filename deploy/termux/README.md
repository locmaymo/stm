# Termux

Install Node.js in Termux, clone this repository, run `npm ci`, then start it with `npm start`. The manager automatically detects Termux and uses `$PREFIX/var/sillytavern-manager`; no launcher path is needed. It has no native Node module dependency. Cloudflared is optional; when unavailable the tunnel card reports the missing capability while local access continues to work.
