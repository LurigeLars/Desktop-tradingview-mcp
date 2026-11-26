# Operator-local CDP guard maintenance. No change to MCP permissions.
# Without -Apply, build and scan only; the running guard is not touched.
param([switch]$Apply)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This maintenance script requires PowerShell 7 on Windows.' }
$Repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')).TrimEnd('\')
$ExpectedRepo = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Desktop-tradingview')).TrimEnd('\')
if ($Repo -ine $ExpectedRepo) { throw 'Use the canonical local DTV checkout.' }

function Get-GuardGitValue {
    param([string[]]$GitArguments)
    $Lines = @(& git.exe -C $Repo @GitArguments 2>$null)
    if ($LASTEXITCODE -ne 0 -or $Lines.Count -ne 1) { throw 'Git checkout verification failed.' }
    return ([string]$Lines[0]).Trim()
}
function Invoke-GuardDocker {
    param([string[]]$DockerArguments)
    & docker.exe @DockerArguments
    if ($LASTEXITCODE -ne 0) { throw 'Docker guard maintenance command failed.' }
}
function Get-GuardDockerValue {
    param([string[]]$DockerArguments)
    $Lines = @(& docker.exe @DockerArguments 2>$null)
    if ($LASTEXITCODE -ne 0 -or $Lines.Count -ne 1) { throw 'Docker guard state could not be verified.' }
    return ([string]$Lines[0]).Trim()
}
function Assert-CleanGuardCheckout {
    $Status = @(& git.exe -C $Repo status --porcelain)
    if ($LASTEXITCODE -ne 0 -or $Status.Count -ne 0) { throw 'Canonical DTV checkout must be clean.' }
    if ((Get-GuardGitValue @('branch','--show-current')) -cne 'main') { throw 'Use the main branch.' }
    $Head = Get-GuardGitValue @('rev-parse','HEAD')
    if ($Head -notmatch '^[0-9a-f]{40}$' -or
        $Head -cne (Get-GuardGitValue @('rev-parse','refs/remotes/origin/main'))) {
        throw 'Synchronize the reviewed main branch before running this script.'
    }
    return $Head
}
function Get-GuardState {
    $Format = '{{.Id}}|{{.Image}}|{{.State.Running}}|{{.State.Health.Status}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}'
    $Fields = (Get-GuardDockerValue @('container','inspect','--format',$Format,'dtv-cdp-guard')) -split '\|'
    if ($Fields.Count -ne 6 -or $Fields[4] -cne 'tradingview-mcp-public' -or
        $Fields[5] -cne 'cdp-guard' -or $Fields[1] -notmatch '^sha256:[0-9a-f]{64}$') {
        throw 'Unexpected CDP guard container identity.'
    }
    return [pscustomobject]@{ Id=$Fields[0]; Image=$Fields[1]; Running=$Fields[2]; Health=$Fields[3] }
}
function Wait-GuardHealth {
    param([string]$ImageId)
    for ($Attempt = 0; $Attempt -lt 45; $Attempt++) {
        try {
            $State = Get-GuardState
            if ($State.Image -ceq $ImageId -and $State.Running -ceq 'true' -and $State.Health -ceq 'healthy') {
                return $true
            }
        } catch { }
        Start-Sleep -Seconds 2
    }
    return $false
}

$Head = Assert-CleanGuardCheckout
$Compose = Join-Path $Repo 'compose.public.yaml'
$ComposeHash = (Get-FileHash -LiteralPath $Compose -Algorithm SHA256).Hash
$ComposeArgs = @('compose','--project-directory',$Repo,'-f',$Compose)
$Guard = Get-GuardState
if ($Guard.Running -cne 'true' -or $Guard.Health -cne 'healthy') {
    throw 'Existing CDP guard is not healthy; recover it before routine maintenance.'
}
$GatewayId = Get-GuardDockerValue @('container','inspect','--format','{{.Id}}','dtv-mcp-gateway')
Invoke-GuardDocker ($ComposeArgs + @('config','--quiet'))

# A separate tag keeps the running image and its normal local tag unchanged during the scan.
$CandidateTag = 'dtv-cdp-guard:reviewed-' + $Head.Substring(0,12)
$Override = New-TemporaryFile
try {
    [IO.File]::WriteAllText($Override.FullName, "services:`n  cdp-guard:`n    image: $CandidateTag`n")
    Invoke-GuardDocker ($ComposeArgs + @('-f',$Override.FullName,'build','--no-cache','cdp-guard'))
    $CandidateId = Get-GuardDockerValue @('image','inspect','--format','{{.Id}}',$CandidateTag)
    if ($CandidateId -notmatch '^sha256:[0-9a-f]{64}$') { throw 'Candidate image identity is invalid.' }
    # The reviewed VEX covers only the exact stable musl package already fixed by Alpine.
    # All other fixable Critical/High findings still block promotion.
    $Vex = Join-Path $Repo 'security\vex\cdp-guard.openvex.json'
    if (-not (Test-Path -LiteralPath $Vex -PathType Leaf)) { throw 'Reviewed guard VEX missing.' }
    $VexHash = (Get-FileHash -LiteralPath $Vex -Algorithm SHA256).Hash
    & docker.exe scout cves --only-severity critical,high --only-fixed --exit-code --vex-location $Vex --vex-author 'DTV maintainers' ("local://" + $CandidateId)
    if ($LASTEXITCODE -ne 0) { throw 'Guard candidate Scout gate failed; running guard untouched.' }
    if ((Get-FileHash -LiteralPath $Vex -Algorithm SHA256).Hash -cne $VexHash) {
        throw 'Reviewed VEX changed during scanning; no promotion attempted.'
    }
    if ((Get-GuardDockerValue @('image','inspect','--format','{{.Id}}',$CandidateTag)) -cne $CandidateId) {
        throw 'Candidate image changed during scanning.'
    }
    Write-Output "CDP_GUARD_CANDIDATE_SCAN_OK image=$CandidateId"
    if (-not $Apply) { return }

    if ((Assert-CleanGuardCheckout) -cne $Head -or
        (Get-FileHash -LiteralPath $Compose -Algorithm SHA256).Hash -cne $ComposeHash -or
        (Get-GuardState).Id -cne $Guard.Id -or
        (Get-GuardDockerValue @('container','inspect','--format','{{.Id}}','dtv-mcp-gateway')) -cne $GatewayId) {
        throw 'Runtime or checkout changed during staging; no promotion attempted.'
    }

    $RollbackTag = 'dtv-cdp-guard:rollback-' + $Guard.Image.Substring(7,12)
    Invoke-GuardDocker @('image','tag',$Guard.Image,$RollbackTag)
    if ((Get-GuardDockerValue @('image','inspect','--format','{{.Id}}',$RollbackTag)) -cne $Guard.Image) {
        throw 'Previous running image could not be preserved; no promotion attempted.'
    }
    $Recreate = $ComposeArgs + @('up','-d','--no-deps','--no-build','--pull','never','--force-recreate','cdp-guard')
    try {
        Invoke-GuardDocker @('image','tag',$CandidateId,'dtv-cdp-guard:local')
        Invoke-GuardDocker $Recreate
        if (-not (Wait-GuardHealth $CandidateId) -or
            (Get-GuardDockerValue @('container','inspect','--format','{{.Id}}','dtv-mcp-gateway')) -cne $GatewayId) {
            throw 'Guard health or unchanged gateway verification failed.'
        }
    } catch {
        try {
            Invoke-GuardDocker @('image','tag',$RollbackTag,'dtv-cdp-guard:local')
            Invoke-GuardDocker $Recreate
            if (-not (Wait-GuardHealth $Guard.Image)) { throw 'Rollback health failed.' }
        } catch {
            throw 'Guard promotion and rollback failed; inspect the CDP guard locally immediately.'
        }
        throw 'Guard promotion failed; previous guard image restored and healthy.'
    }
    Write-Output "CDP_GUARD_REFRESH_OK image=$CandidateId rollback=$RollbackTag gateway_unchanged=true"
} finally {
    Remove-Item -LiteralPath $Override.FullName -Force
}
