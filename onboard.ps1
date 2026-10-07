$ErrorActionPreference = 'Stop'
# Clear Node execution overrides before the gate's first probe or bootstrap/npm.
foreach ($name in @('NODE_OPTIONS', 'NODE_PATH', 'NODE_TLS_REJECT_UNAUTHORIZED')) {
    Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
}
$root = $PSScriptRoot
. (Join-Path $root 'scripts/deployment-choice.ps1')
Invoke-DeploymentGate @args
if ($script:AllowBootstrap) {
    . (Join-Path $root 'scripts/private-runtime.ps1')
    Initialize-PrivateRuntime
}
$args = @($args | Where-Object { $_ -cne '--allow-bootstrap' })
if (-not $script:ModeSupplied) { $args += @('--deployment-mode', $script:DeploymentMode) }
$env:PATH = "$(Split-Path $script:Node);$env:PATH"
Push-Location $root
try {
    & $script:Node scripts/onboard.mjs @args
    exit $LASTEXITCODE
} finally { Pop-Location }
