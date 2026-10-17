$ErrorActionPreference = 'Stop'

if ($PSVersionTable.PSVersion.Major -lt 7) {
  throw 'PowerShell 7 or newer is required.'
}

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Push-Location $repositoryRoot
try {
  npm run release:windows
  if ($LASTEXITCODE -ne 0) { throw 'The Windows release build failed.' }
  $packageJson = Get-Content -LiteralPath (Join-Path $repositoryRoot 'package.json') -Raw | ConvertFrom-Json
  $version = $packageJson.version
  $installer = Join-Path $repositoryRoot "build\SillyTavernManager-windows-x64-v$version-setup.exe"
  if (-not (Test-Path -LiteralPath $installer)) {
    throw "Installer was not created: $installer"
  }
  $hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
  Set-Content -LiteralPath "$installer.sha256" -Value "$hash  $([System.IO.Path]::GetFileName($installer))" -Encoding utf8NoBOM
  Write-Host "Release installer ready: $installer"
} finally {
  Pop-Location
}
