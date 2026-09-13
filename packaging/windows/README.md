# Windows launcher

`launcher.cjs` is the entry point of the single-file executable. It must stay
CommonJS: Node runs a SEA entry as CommonJS, so an ES module entry dies on its
first `import` with a SyntaxError before anything else happens.

The launcher starts the manager on `127.0.0.1:7860`, waits for its health
endpoint, opens the browser, and then keeps its console window as the place the
operator reads status and stops from. It carries the compiled server, panel
assets, production dependencies, and a Node runtime inside `resources/`, so
nothing has to be installed first.

Stopping is the part that needs care. Windows has no SIGTERM, so killing the
manager would leave SillyTavern and cloudflared running with nothing owning
them. The launcher asks the manager over HTTP first, using a per-run secret it
passes as `STM_SHUTDOWN_TOKEN`; `taskkill /t /f` is only the fallback for a
manager that is already wedged.

Build it on Windows with PowerShell 7+ and Node.js 22 or newer:

```powershell
pwsh packaging/windows/build-sea.ps1
```

The result is `build/release/windows-x64/`. Zip that directory for a GitHub
Release. Durable data is kept outside the bundle under
`%LOCALAPPDATA%\SillyTavernManager`, so replacing the release directory does not
remove profiles, backups, logs, or the manager password.

`packaging/windows/FIRST-RUN.txt` ships in the bundle as `Read me first.txt`.

The source launcher still supports `STM_APP_ROOT` and `STM_NODE_BINARY` for
local development, and can be run directly with
`node packaging/windows/launcher.cjs`. The portable SEA launcher uses the
adjacent `resources/` directory automatically.
