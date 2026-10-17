# Windows desktop application & installer

`packaging/windows/app/` is the native Windows desktop application (`SillyTavernManager.exe`).
It compiles against `.NET Framework 4.8` (`net48` `WinExe`) and hosts the console
inside Microsoft Edge WebView2 while running the manager server (`node.exe`) in
the background without a console window.

## Architecture

- **Desktop window & system tray (`MainWindow.cs`)**:
  Starts the manager on `127.0.0.1:7860` (or the next free port), waits for
  `/api/v1/health`, and loads the console inside WebView2 with `STMDesktop/<version>`
  in its user agent and `window.STMApp` injected for native backup zip imports,
  SillyTavern window management, and 1-click in-app updates. Closing the window
  (`X`) hides it to the Windows system tray so SillyTavern and the Cloudflare
  tunnel keep running; choosing **Quit** in the tray menu shuts everything down
  cleanly.
- **Process lifecycle (`ManagerProcess.cs`)**:
  Runs the bundled `resources/runtime/node.exe` with `CreateNoWindow = true` and
  prepends `resources/runtime` and `resources/git/cmd` to `PATH`. Stopping sends
  `POST /api/v1/shutdown` with `x-stm-shutdown-token` before falling back to
  `taskkill /t /f`.
- **NSIS per-user installer (`installer.nsi`)**:
  Uses `RequestExecutionLevel user` to install into
  `%LOCALAPPDATA%\Programs\SillyTavernManager` without UAC elevation, creates
  Start Menu and Desktop shortcuts, registers in Windows Installed Apps, and
  supports `/S /LAUNCH=1` for silent in-app upgrades.

## Building

Build the NSIS installer (`-setup.exe` + `.sha256`) on Windows with
PowerShell 7+, Node.js 22+, and the .NET SDK:

```powershell
pwsh packaging/windows/package-release.ps1
```

Durable user data is kept outside the application directory under
`%LOCALAPPDATA%\SillyTavernManager`, so upgrading or reinstalling never touches
profiles, backups, logs, or passwords.
