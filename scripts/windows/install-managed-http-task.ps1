# Migrate the existing DTV HTTP Scheduled Task to own its Node listener.
# The previous pythonw launcher detached node.exe: Task Scheduler stopped the
# launcher, leaving the old HTTP process on 127.0.0.1:8765.
# This one-time migration changes only the existing TradingViewMcpHttpServer
# task action. It never restarts TradingView Desktop or its CDP chart windows.
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [switch]$Apply,
    [ValidateSet(0, 9222, 9333)][int]$CdpPort = 0
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $Apply) {
    throw 'Use -Apply explicitly to migrate the existing DTV HTTP task.'
}

$TaskName = 'TradingViewMcpHttpServer'
$Repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')).TrimEnd('\')
$ExpectedRepo = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Desktop-tradingview')).TrimEnd('\')
if (-not [string]::Equals($Repo, $ExpectedRepo, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing: repository is not the known LOCALAPPDATA Desktop-tradingview checkout.'
}
$ManagedScript = Join-Path $Repo 'scripts\windows\http-managed.js'
if (-not (Test-Path -LiteralPath $ManagedScript -PathType Leaf)) {
    throw 'Managed HTTP server entrypoint is missing.'
}
$Origin = (& git.exe -C $Repo remote get-url origin).Trim()
$OriginExit = $LASTEXITCODE
$Branch = (& git.exe -C $Repo branch --show-current).Trim()
$BranchExit = $LASTEXITCODE
$Uncommitted = @(& git.exe -C $Repo status --porcelain)
$StatusExit = $LASTEXITCODE
if ($OriginExit -ne 0 -or $BranchExit -ne 0 -or $StatusExit -ne 0 -or
    $Branch -cne 'main' -or $Uncommitted.Count -gt 0 -or
    $Origin -cnotin @(
        'https://github.com/LurigeLars/Desktop-tradingview-mcp',
        'https://github.com/LurigeLars/Desktop-tradingview-mcp.git'
    )) {
    throw 'Refusing: DTV checkout is not clean allowlisted main and origin.'
}

$Tasks = @(Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop)
if ($Tasks.Count -ne 1 -or $Tasks[0].TaskName -cne $TaskName) {
    throw 'Refusing: the exact existing DTV HTTP Scheduled Task is not unique.'
}
$Task = $Tasks[0]
$TaskPath = [string]$Task.TaskPath
$Actions = @($Task.Actions)
if ($Actions.Count -ne 1) {
    throw 'Refusing: DTV task has multiple or no launcher actions.'
}
if ([string]$Task.State -eq 'Disabled') {
    throw 'Refusing: the DTV task is disabled; do not change its state.'
}
$Identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$TaskUser = [string]$Task.Principal.UserId
$ThisUser = ($Identity -split '\\')[-1]
if (-not [string]::Equals(($TaskUser -split '\\')[-1], $ThisUser,
                         [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing: task does not belong to the current interactive Windows user.'
}

$OriginalAction = $Actions[0]
$Launcher = [IO.Path]::GetFileName([string]$OriginalAction.Execute)
$LaunchArgs = [string]$OriginalAction.Arguments
$AlreadyManaged = $Launcher -ieq 'node.exe' -and
    $LaunchArgs.Contains($ManagedScript)
$OldLauncher = $Launcher -in @('pythonw.exe', 'python.exe', 'node.exe') -and
    ($LaunchArgs -match '(?i)run-http-hidden[.]py' -or
     $LaunchArgs -match '(?i)src[\\/]server[\\/]http[.]js')
if (-not $AlreadyManaged -and -not $OldLauncher) {
    throw 'Refusing: existing scheduled launcher is not an approved DTV HTTP action.'
}

function Test-CdpChart {
    param([Parameter(Mandatory)][int]$Port)
    try {
        $Version = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 3
        if (-not $Version.'Protocol-Version') { return $false }
        $Targets = @(Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 3)
        return @($Targets | Where-Object {
            $_.type -eq 'page' -and $_.url -match '^https://www[.]tradingview[.]com/chart/'
        }).Count -gt 0
    }
    catch { return $false }
}
$Ports = if ($CdpPort -gt 0) { @($CdpPort) } else { @(9222, 9333) }
$ValidatedPorts = @($Ports | Where-Object { Test-CdpChart -Port $_ })
if ($ValidatedPorts.Count -ne 1) {
    throw "Refusing: expected exactly one verified TradingView CDP endpoint; found $($ValidatedPorts.Count). Specify -CdpPort if both are active."
}
$ValidatedCdpPort = [int]$ValidatedPorts[0]

function Get-HttpListener {
    $Connections = @(Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue)
    if ($Connections.Count -eq 0) { return $null }
    $Local = @($Connections | Where-Object { $_.LocalAddress -eq '127.0.0.1' })
    if ($Connections.Count -ne 1 -or $Local.Count -ne 1) {
        throw 'Refusing: port 8765 has ambiguous or non-loopback listener ownership.'
    }
    $OwnerId = [int]$Local[0].OwningProcess
    $Owner = Get-CimInstance Win32_Process -Filter "ProcessId=$OwnerId"
    if ($null -eq $Owner -or $Owner.Name -ine 'node.exe' -or
        $Owner.CommandLine -notmatch '(?i)(src[\\/]server[\\/]http[.]js|scripts[\\/]windows[\\/]http-managed[.]js)' -or
        [string]::IsNullOrWhiteSpace([string]$Owner.ExecutablePath)) {
        throw 'Refusing: port 8765 is not owned by the verified DTV Node HTTP process.'
    }
    return @{ ProcessId = $OwnerId; NodeExe = [string]$Owner.ExecutablePath
              CommandLine = [string]$Owner.CommandLine }
}
$ExistingListener = Get-HttpListener
$NodeExe = if ($ExistingListener) {
    $ExistingListener.NodeExe
}
else {
    (Get-Command node.exe -ErrorAction Stop).Source
}
if (-not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) {
    throw 'Refusing: node.exe is unavailable.'
}

$ActionArgs = ('"{0}" --cdp-port={1}' -f $ManagedScript, $ValidatedCdpPort)
$NewAction = New-ScheduledTaskAction -Execute $NodeExe -Argument $ActionArgs -WorkingDirectory $Repo
$BackupRoot = Join-Path $env:LOCALAPPDATA 'DTV-Http-Task-Backups'
New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
$Backup = Join-Path $BackupRoot ("TradingViewMcpHttpServer-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".xml")
[IO.File]::WriteAllText($Backup,
    (Export-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath),
    [Text.UTF8Encoding]::new($false))

function Wait-HttpState {
    param([switch]$Present, [int]$ExcludePid = 0, [int]$Seconds = 15)
    $Deadline = (Get-Date).AddSeconds($Seconds)
    do {
        $Info = Get-HttpListener
        if (-not $Present -and $null -eq $Info) { return $null }
        if ($Present -and $Info -and $Info.ProcessId -ne $ExcludePid -and
            $Info.CommandLine.Contains($ManagedScript)) {
            return $Info
        }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $Deadline)
    throw 'DTV HTTP listener did not enter the expected managed state.'
}

if (-not $PSCmdlet.ShouldProcess($TaskName, 'Migrate to direct Node task action and verify stop/restart')) {
    return
}

$Changed = $false
try {
    if (-not $AlreadyManaged) {
        Set-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Action $NewAction -ErrorAction Stop | Out-Null
        $Changed = $true
    }
    if ($ExistingListener) {
        # Terminate ONLY the previously verified DTV HTTP port owner.
        Stop-Process -Id $ExistingListener.ProcessId -Force -ErrorAction Stop
        [void](Wait-HttpState)
    }

    # Task Scheduler must own the listener itself. Verify the full lifecycle.
    Start-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction Stop
    $First = Wait-HttpState -Present -ExcludePid $(if ($ExistingListener) { $ExistingListener.ProcessId } else { 0 })
    $RunningTask = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
    if ([string]$RunningTask.State -ne 'Running') {
        throw 'Managed Node bound port but Scheduled Task does not own a running process.'
    }

    Stop-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction Stop
    [void](Wait-HttpState)
    Start-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction Stop
    $Second = Wait-HttpState -Present -ExcludePid $First.ProcessId
    $CurrentTask = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
    if ([string]$CurrentTask.State -ne 'Running') {
        throw 'Managed HTTP server is not owned by the running Scheduled Task.'
    }
    Write-Host "PASS: task directly owns DTV Node PID $($Second.ProcessId) on 127.0.0.1:8765."
    Write-Host "PASS: Stop-ScheduledTask released port; Start-ScheduledTask created a different PID."
    Write-Host "TradingView Desktop and all its charts remain untouched."
    Write-Host "Task XML backup: $Backup"
}
catch {
    $Failure = $_
    if ($Changed) {
        try {
            $Now = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction Stop
            if ([string]$Now.State -eq 'Running') {
                Stop-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction Stop
            }
            Set-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Action $OriginalAction -ErrorAction Stop | Out-Null
        }
        catch {
            Write-Warning 'Could not restore original DTV task action. Use saved task XML backup.'
        }
    }
    throw "DTV managed HTTP migration failed: $($Failure.Exception.Message). Check task and port before retry."
}
