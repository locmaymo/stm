# Windows launcher

The portable bundle starts the manager on `127.0.0.1:7860`, waits for its health endpoint, and opens the default browser. It carries its compiled server, panel assets, production dependencies, and a Node runtime inside `resources/`, so the user does not need to install Node.js.

Build it on Windows with PowerShell 7+ and Node.js 22 or newer:

```powershell
pwsh packaging/windows/build-sea.ps1
```

The result is `build/release/windows-x64/`. Zip that directory for a GitHub Release. Durable data is kept outside the bundle under `%LOCALAPPDATA%\SillyTavernManager`, so replacing the release directory does not remove profiles, backups, logs, or the manager password.

The source launcher still supports `STM_APP_ROOT` and `STM_NODE_BINARY` for local development. The portable SEA launcher uses the adjacent `resources/` directory automatically.
