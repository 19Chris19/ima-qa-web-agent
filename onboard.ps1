$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$version = 'v22.22.3'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if ($node) { & $node -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)'; if ($LASTEXITCODE -ne 0) { $node = $null } }
if (-not $node) {
  # x64 also runs under Windows ARM64 emulation; no native ARM performance claim.
  $name = "node-$version-win-x64"
  $cache = Join-Path $env:LOCALAPPDATA 'ima-qa-maintenance'
  $node = Join-Path $cache "$name\node.exe"
  if (-not (Test-Path $node)) {
    $temporary = Join-Path $cache ([Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $temporary -Force | Out-Null
    try {
      $zip = Join-Path $temporary "$name.zip"
      Invoke-WebRequest -Uri "https://nodejs.org/dist/$version/$name.zip" -OutFile $zip
      $sums = (Invoke-WebRequest -Uri "https://nodejs.org/dist/$version/SHASUMS256.txt").Content
      $entry = ($sums -split "`n" | Where-Object { $_.Trim().EndsWith("  $name.zip") })
      if ($entry.Count -ne 1) { throw 'Runtime checksum unavailable.' }
      $expected = ($entry.Trim() -split '\s+')[0]
      if ((Get-FileHash -Algorithm SHA256 $zip).Hash.ToLowerInvariant() -ne $expected) { throw 'Runtime checksum mismatch.' }
      Expand-Archive -Path $zip -DestinationPath $temporary
      $destination = Join-Path $cache $name
      if (Test-Path $destination) { throw 'Runtime destination exists; inspect before retry.' }
      Move-Item -Path (Join-Path $temporary $name) -Destination $destination
    } finally { Remove-Item $temporary -Recurse -Force -ErrorAction SilentlyContinue }
  }
}
$env:PATH = "$(Split-Path $node);$env:PATH"
Push-Location $root
try {
  & $node -e 'require("playwright-core");require("parse5")' 2>$null
  if ($LASTEXITCODE -ne 0) { & npm.cmd ci --omit=dev; if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' } }
  & $node scripts/onboard.mjs @args
  exit $LASTEXITCODE
} finally { Pop-Location }
