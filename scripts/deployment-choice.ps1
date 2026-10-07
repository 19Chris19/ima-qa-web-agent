function Write-DeploymentReport($Stage, $Missing, $Next) {
    [ordered]@{ stage=$Stage; mode=$script:DeploymentMode; platform=$script:Platform; arch=$script:Architecture;
        missing=@($Missing); next=$Next; readOnly=$true; credentialsPrinted=$false } | ConvertTo-Json -Compress
}
function Stop-Deployment($Code, $Next) { Write-DeploymentReport 'blocked' @($Code) $Next; exit 2 }
function Invoke-DeploymentGate {
    $script:DeploymentMode = ''; $script:ModeSupplied = $false; $script:AllowBootstrap = $false
    $script:Platform = 'unknown'; $script:Architecture = 'unknown'
    $action = 'choose'
    if ($args.Count -gt 0) { $action = $args[0] }
    if ($action -notin @('choose','preflight','doctor','install','resolve','check','resume','repair','uninstall','browser-install','enroll','tunnel','remote-prepare','runtime')) {
        Stop-Deployment 'invalid_arguments' 'Read docs/AGENT_DEPLOYMENT.md.'
    }
    $readOnly = $action -in @('choose','preflight','doctor')
    $legacy = @('--share-url','--target-file','--env','--project','--port','--mode','--image','--name','--server-url','--ssh','--remote-env','--remote-port','--local-port','--directory')
    for ($i=1; $i -lt $args.Count; $i++) {
        $key = $args[$i]
        if ($key -eq '--allow-bootstrap') {
            if ($script:AllowBootstrap -or $action -notin @('install','runtime')) { Stop-Deployment 'invalid_arguments' 'Bootstrap consent is accepted once, only for install or runtime.' }
            $script:AllowBootstrap = $true
            continue
        }
        if ($i+1 -ge $args.Count -or $args[$i+1].StartsWith('--')) { Stop-Deployment 'invalid_arguments' 'Missing option value.' }
        $i++
        if ($key -eq '--deployment-mode') {
            if ($script:ModeSupplied) { Stop-Deployment 'invalid_arguments' 'Supply one deployment mode.' }
            if ($args[$i] -cnotin @('online','shared','independent')) { Stop-Deployment 'invalid_mode' 'Choose online, shared or independent.' }
            $script:DeploymentMode = $args[$i]; $script:ModeSupplied = $true
        } elseif ($key -notin $legacy -or $readOnly) { Stop-Deployment 'invalid_arguments' 'Read docs/AGENT_DEPLOYMENT.md.' }
    }
    if (-not $script:ModeSupplied) {
        if ([Console]::IsInputRedirected -or [Environment]::GetCommandLineArgs() -match '^-NonI(nteractive)?$') {
            Stop-Deployment 'deployment_mode_required' 'Ask the user: 1 online, 2 shared, 3 independent; wait for their answer.'
        }
        while (-not $script:DeploymentMode) {
            [Console]::Error.WriteLine('Choose before installation (no default): 1) online website (private Explorer requires permission); 2) shared (pending invitation, no raw secrets); 3) independent generic Provider')
            try { $answer = Read-Host 'Selection' } catch { Stop-Deployment 'deployment_mode_required' 'Selection cancelled; nothing installed.' }
            switch -CaseSensitive ($answer) {
                { $_ -in @('1','online') } { $script:DeploymentMode = 'online' }
                { $_ -in @('2','shared') } { $script:DeploymentMode = 'shared' }
                { $_ -in @('3','independent') } { $script:DeploymentMode = 'independent' }
                $null { Stop-Deployment 'deployment_mode_required' 'Selection cancelled; nothing installed.' }
            }
        }
    }
    if ($script:DeploymentMode -ne 'independent') {
        if (-not $readOnly) { Stop-Deployment 'independent_mode_required' 'This operation requires independent mode and separate consent.' }
        if ($script:DeploymentMode -eq 'online') {
            Write-DeploymentReport 'online_access' @('operator_url_and_access') 'Ask the operator for a website URL and access; private Explorer is not included. No local install.'
        } else {
            Write-DeploymentReport 'pending_invitation' @('operator_invitation') 'Wait for an operator invitation; shared Explorer needs no Provider install. Gateway is candidate-only, not in v0.4.2; see candidate docs/SHARED_GATEWAY.md. Never paste raw secrets.'
        }
        exit 0
    }
    if ($action -eq 'choose') {
        Write-DeploymentReport 'mode_selected' @() 'Run preflight with --deployment-mode independent; selection is not installation consent.'; exit 0
    }
    if ($env:OS -ne 'Windows_NT') { Stop-Deployment 'unsupported_os' 'Use onboard.sh on Mac/Linux.' }
    $script:Platform = 'win32'
    $machineArch = $env:PROCESSOR_ARCHITEW6432
    if (-not $machineArch) { $machineArch = $env:PROCESSOR_ARCHITECTURE }
    switch ($machineArch) {
        'AMD64' { $script:Architecture = 'x64' }
        'ARM64' { $script:Architecture = 'arm64' }
        default { Stop-Deployment 'unsupported_arch' 'Review official Docker architecture support; do not install automatically.' }
    }
    if ($script:AllowBootstrap) { return }
    if ($readOnly) {
        if (-not (Get-Command docker -CommandType Application -ErrorAction SilentlyContinue)) {
            Stop-Deployment 'docker_cli' 'Docker CLI missing from PATH. Ask consent; see docs/DEPENDENCIES.md for official installation and license/system steps.'
        }
        # Capture diagnostics privately, including Windows PowerShell native stderr.
        $saved = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        try { $detail = (& docker info --format '{{.ServerVersion}}' 2>&1 | Out-String); $code = $LASTEXITCODE }
        finally { $ErrorActionPreference = $saved }
        if ($code -ne 0) {
            if ($detail -match '(?i)permission denied|access is denied') {
                Stop-Deployment 'docker_permission' 'Ask the system owner to review Docker access. No elevation or group changes are performed.'
            } elseif ($detail -match '(?i)cannot connect to the docker daemon|is the docker daemon running|the system cannot find the file specified') {
                Stop-Deployment 'docker_daemon_stopped_or_unreachable' 'Docker CLI exists. Ask the user to start Docker or check the selected context; do not reinstall.'
            } else { Stop-Deployment 'docker_daemon_unavailable' 'Review Docker context, connectivity and permissions; do not assume Docker is missing.' }
        }
        $ErrorActionPreference = 'Continue'
        try { $compose = (& docker compose version --short 2>$null | Out-String).Trim(); $code = $LASTEXITCODE }
        finally { $ErrorActionPreference = $saved }
        $major = 0
        $supported = $compose -match '^v?([0-9]+)(?:\.|$)' -and [int]::TryParse($Matches[1], [ref]$major) -and $major -ge 2
        if ($code -ne 0 -or -not $supported) { Stop-Deployment 'compose_v2' 'Compose plugin major 2 or newer is required; review official installation with consent.' }
    }
    $script:Node = (Get-Command node -CommandType Application -ErrorAction SilentlyContinue).Source
    $saved = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $code = 1
    try { if ($script:Node) { & $script:Node -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)' 2>$null; $code = $LASTEXITCODE } }
    finally { $ErrorActionPreference = $saved }
    if ($code -ne 0) {
        $script:Node = Join-Path $env:LOCALAPPDATA 'ima-qa-maintenance/node-v22.22.3-win-x64/node.exe'
        if (-not (Test-Path $script:Node -PathType Leaf)) { Stop-Deployment 'node_22' 'Use existing Node 22+ or separately authorize runtime --deployment-mode independent --allow-bootstrap for a private runtime. No bootstrap performed.' }
        $ErrorActionPreference = 'Continue'
        try { & $script:Node -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)' 2>$null; $code = $LASTEXITCODE }
        finally { $ErrorActionPreference = $saved }
        if ($code -ne 0) { Stop-Deployment 'node_22' 'Existing private runtime is unusable; inspect it without overwriting.' }
    }
    Push-Location $root
    try {
        $ErrorActionPreference = 'Continue'
        & $script:Node -e 'for(const name of ["dotenv","playwright-core","parse5"])require.resolve(name)' 2>$null
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $saved; Pop-Location }
    if ($code -ne 0) { Stop-Deployment 'node_dependencies' 'Separately authorize runtime --deployment-mode independent --allow-bootstrap for locked dependencies, or approved npm ci; then rerun preflight.' }
    if ($readOnly) {
        Write-DeploymentReport 'dependencies_ready' @() 'Dependencies only. Inspect existing installation, ports and pinned release before separately authorizing install. No QA verified.'; exit 0
    }
}
