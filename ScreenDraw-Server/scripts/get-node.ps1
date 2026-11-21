# Downloads a private copy of Node.js (LTS) for ScreenDraw, verifying its checksum.
param([Parameter(Mandatory = $true)][string]$Dest)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # makes Invoke-WebRequest much faster
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$base = 'https://nodejs.org/dist/latest-v24.x'

try {
  $sums = (Invoke-WebRequest "$base/SHASUMS256.txt" -UseBasicParsing).Content
  if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
  $line = ($sums -split "`n") | Where-Object { $_ -match "\s(node-v[\d.]+-win-$arch\.zip)\s*$" } | Select-Object -First 1
  if (-not $line) { throw "No Windows $arch build listed." }
  $hash, $file = $line.Trim() -split '\s+'
  $name = $file -replace '\.zip$', ''

  $tmp = Join-Path $env:TEMP "screendraw-$([guid]::NewGuid())"
  New-Item -ItemType Directory -Path $tmp | Out-Null
  $zip = Join-Path $tmp $file
  Write-Host "  Downloading $file ..."
  Invoke-WebRequest "$base/$file" -OutFile $zip -UseBasicParsing

  if ((Get-FileHash $zip -Algorithm SHA256).Hash -ne $hash.ToUpper()) { throw 'Checksum mismatch - download was corrupted.' }

  Write-Host '  Unpacking ...'
  Expand-Archive $zip -DestinationPath $tmp -Force
  $parent = Split-Path $Dest -Parent
  if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
  if (Test-Path $Dest) { Remove-Item $Dest -Recurse -Force }
  Move-Item (Join-Path $tmp $name) $Dest
  Remove-Item $tmp -Recurse -Force
  Write-Host '  Node.js ready.'
  exit 0
}
catch {
  Write-Host "  Error: $($_.Exception.Message)"
  exit 1
}
