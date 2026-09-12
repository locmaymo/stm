$ErrorActionPreference = 'Stop'

if ($PSVersionTable.PSVersion.Major -lt 7) {
  throw 'PowerShell 7 or newer is required.'
}

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Push-Location $repositoryRoot
try {
  npm run release:windows
  if ($LASTEXITCODE -ne 0) { throw 'The portable Windows build failed.' }
  $packageJson = Get-Content -LiteralPath (Join-Path $repositoryRoot 'package.json') -Raw | ConvertFrom-Json
  $version = $packageJson.version
  $releaseDirectory = Join-Path $repositoryRoot 'build\release\windows-x64'
  $archive = Join-Path $repositoryRoot "build\SillyTavernManager-windows-x64-v$version.zip"
  if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
  Compress-Archive -Path (Join-Path $releaseDirectory '*') -DestinationPath $archive -CompressionLevel Optimal
  $hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  Set-Content -LiteralPath "$archive.sha256" -Value "$hash  $([System.IO.Path]::GetFileName($archive))" -Encoding utf8NoBOM
  Write-Host "Release archive ready: $archive"
} finally {
  Pop-Location
}
