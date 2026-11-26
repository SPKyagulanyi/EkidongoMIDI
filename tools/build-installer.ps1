# Builds the signed Windows installer locally.
# Reads the update-signing key from %USERPROFILE%\.tauri (never from the repo).
#   powershell -ExecutionPolicy Bypass -File tools\build-installer.ps1
$ErrorActionPreference = 'Stop'
$keyDir = Join-Path $env:USERPROFILE '.tauri'
$key = Join-Path $keyDir 'ekidongomidi-updater.key'
$pass = Join-Path $keyDir 'ekidongomidi-updater.password.txt'
if (-not (Test-Path $key) -or -not (Test-Path $pass)) {
  throw "Signing key not found in $keyDir. See docs/releasing.md."
}
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $key -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content $pass -Raw).Trim()
$cargoHome = if ($env:CARGO_HOME) { $env:CARGO_HOME } else { Join-Path $env:USERPROFILE '.cargo' }
$env:PATH = "$cargoHome\bin;$env:PATH"
Push-Location (Join-Path $PSScriptRoot '..\apps\desktop')
try {
  pnpm tauri build
} finally {
  Pop-Location
  Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY, Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
}
