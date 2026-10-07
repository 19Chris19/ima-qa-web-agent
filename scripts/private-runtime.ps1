# Authorized preparation only; sourced after the native deployment gate.
function Initialize-PrivateRuntime {
    if ($script:DeploymentMode -ne 'independent' -or -not $script:AllowBootstrap) { throw 'Independent bootstrap consent required.' }
    $version = 'v22.22.3'
    $script:Node = (Get-Command node -CommandType Application -ErrorAction SilentlyContinue).Source
    if ($script:Node) {
        & $script:Node -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)'
        if ($LASTEXITCODE -ne 0) { $script:Node = $null }
    }
    if (-not $script:Node) {
        # Preserve the existing x64 runtime path, including Windows ARM emulation.
        $name = "node-$version-win-x64"
        $cache = Join-Path $env:LOCALAPPDATA 'ima-qa-maintenance'
        $script:Node = Join-Path $cache "$name\node.exe"
        if (-not (Test-Path $script:Node)) {
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
    $env:PATH = "$(Split-Path $script:Node);$env:PATH"
    Push-Location $root
    $saved = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $script:Node -e 'require("playwright-core");require("parse5")' 2>$null
        $code = $LASTEXITCODE
        $ErrorActionPreference = $saved
        if ($code -ne 0) {
            & npm.cmd ci --omit=dev | Out-Host
            if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
        }
    } finally { $ErrorActionPreference = $saved; Pop-Location }
}
