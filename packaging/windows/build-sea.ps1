$ErrorActionPreference = 'Stop'

if ($PSVersionTable.PSVersion.Major -lt 7) {
  throw 'PowerShell 7 or newer is required.'
}

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Push-Location $repositoryRoot
try {
  node scripts/build-windows-release.mjs
  if ($LASTEXITCODE -ne 0) { throw 'The portable Windows build failed.' }
  Write-Host 'Portable Windows bundle ready under build/release/windows-x64.'
} finally {
  Pop-Location
}
