# Creates a desktop / Start Menu shortcut that opens Second Brain as a standalone app window.
# Usage: double-click install-app.bat   (optional: -OutDir <folder> to create the shortcut elsewhere)
param([string]$OutDir = "")
$ErrorActionPreference = 'Stop'

$name    = 'Second Brain'
$root    = Split-Path -Parent $PSScriptRoot
$html    = Join-Path $root 'static\index.html'
$icon    = Join-Path $root 'assets\icon.ico'
$profile = Join-Path $env:LOCALAPPDATA 'SecondBrain-App'

$candidates = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)
$browser = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) { throw 'Chrome or Edge was not found.' }
if (-not (Test-Path $html)) { throw "Not found: $html" }

$url  = ([System.Uri]$html).AbsoluteUri
# Own profile folder: keeps this app's data (and API key) separate from your normal browser.
$args = "--app=`"$url`" --user-data-dir=`"$profile`" --no-first-run --no-default-browser-check"

if ($OutDir) { $targets = @($OutDir) }
else { $targets = @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs')) }

foreach ($dir in $targets) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $lnk = Join-Path $dir "$name.lnk"
  $sc = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
  $sc.TargetPath       = $browser
  $sc.Arguments        = $args
  $sc.WorkingDirectory = $root
  $sc.IconLocation     = "$icon,0"
  $sc.Description      = $name
  $sc.Save()
  Write-Host "Created: $lnk"
}
Write-Host ""
Write-Host "Done. Launch '$name' from the Desktop or the Start Menu."
Write-Host "Browser: $browser"
