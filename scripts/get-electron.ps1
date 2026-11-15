# Downloads the Electron runtime for the ScreenDraw desktop sharer straight from
# Electron's official GitHub releases, verifying its checksum. (npm isn't used,
# because newer npm versions block Electron's own download step by default.)
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$Dest
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Download($url, $out) {
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($curl) {
    & $curl.Source -L --fail --progress-bar -o $out $url
    if ($LASTEXITCODE -ne 0) { throw "Download failed (curl exit code $LASTEXITCODE): $url" }
  } else {
    Invoke-WebRequest $url -OutFile $out -UseBasicParsing
  }
}

try {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $file = "electron-v$Version-win32-$arch.zip"
  $base = "https://github.com/electron/electron/releases/download/v$Version"

  $tmp = Join-Path $env:TEMP "screendraw-$([guid]::NewGuid())"
  New-Item -ItemType Directory -Path $tmp | Out-Null

  Download "$base/SHASUMS256.txt" (Join-Path $tmp 'SHASUMS256.txt')
  $line = Get-Content (Join-Path $tmp 'SHASUMS256.txt') | Where-Object { $_ -match "^([0-9a-fA-F]{64}) \*?$([regex]::Escape($file))\s*$" } | Select-Object -First 1
  if (-not $line) { throw "Electron $Version has no Windows $arch download." }
  $hash = ([regex]::Match($line, '^[0-9a-fA-F]{64}')).Value

  Write-Host "  Downloading $file (about 110 MB)..."
  $zip = Join-Path $tmp $file
  Download "$base/$file" $zip
  if ((Get-FileHash $zip -Algorithm SHA256).Hash -ne $hash.ToUpper()) { throw 'Checksum mismatch - the download was corrupted. Please try again.' }

  Write-Host '  Unpacking...'
  if (Test-Path $Dest) { Remove-Item $Dest -Recurse -Force }
  New-Item -ItemType Directory -Path $Dest -Force | Out-Null
  $tar = Get-Command tar.exe -ErrorAction SilentlyContinue
  if ($tar) { & $tar.Source -xf $zip -C $Dest; if ($LASTEXITCODE -ne 0) { throw 'Unpacking failed.' } }
  else { Expand-Archive $zip -DestinationPath $Dest -Force }
  if (-not (Test-Path (Join-Path $Dest 'electron.exe'))) { throw 'Unpacked, but electron.exe is missing.' }

  Remove-Item $tmp -Recurse -Force
  Write-Host '  Sharer app ready.'
  exit 0
}
catch {
  Write-Host ''
  Write-Host "  ERROR: $($_.Exception.Message)" -ForegroundColor Red
  if ($tmp -and (Test-Path $tmp)) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
  exit 1
}
