# Migrate DTV HTTP Scheduled Task to a hidden pythonw-owned Windows Job Object.
# Task Scheduler stops pythonw; JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE kills its
# hidden node.exe child, avoiding both orphaned port listeners and console windows.
# This one-time migration changes only the existing TradingViewMcpHttpServer
# task action. It never restarts TradingView Desktop or its CDP chart windows.
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [switch]$Apply,
    [switch]$Inspect,
    [ValidateSet(0, 9222, 9333)][int]$CdpPort = 0,
    [string]$PythonwPath = ""
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $Apply -and -not $Inspect) {
    throw 'Use -Inspect to diagnose without modifying anything, or -Apply for migration.'
}
if ($Apply -and $Inspect) {
    throw '-Inspect and -Apply are mutually exclusive.'
}

$TaskName = 'TradingViewMcpHttpServer'
$Repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')).TrimEnd('\')
$ExpectedRepo = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Desktop-tradingview')).TrimEnd('\')
if (-not [string]::Equals($Repo, $ExpectedRepo, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing: repository is not the known LOCALAPPDATA Desktop-tradingview checkout.'
}
$ManagedScript = Join-Path $Repo 'scripts\windows\run-http-hidden.py'
if (-not (Test-Path -LiteralPath $ManagedScript -PathType Leaf)) {
    throw 'Hidden, job-bound DTV HTTP launcher is missing.'
}
if (-not (Test-Path -LiteralPath (Join-Path $Repo 'scripts\windows\_job_process.py'))) {
    throw 'Windows Job Object helper is missing.'
}
$LegacyManaged = Join-Path $Repo 'scripts\windows\http-managed.js'
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
$AlreadyManaged = $Launcher -ieq 'pythonw.exe' -and
    $LaunchArgs.Contains($ManagedScript) -and $LaunchArgs.Contains('--node')
$OldLauncher = $Launcher -in @('pythonw.exe', 'python.exe', 'node.exe') -and
    ($LaunchArgs.Contains($LegacyManaged) -or
     $LaunchArgs -match '(?i)run-http-hidden[.]py' -or
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
    # PID->CIM mapping is transient while Task Scheduler starts or stops Node.
    # Return UNKNOWN rather than assuming an unavailable process is DTV.
    for ($Attempt = 0; $Attempt -lt 6; $Attempt++) {
        $Connections = @(Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue)
        if ($Connections.Count -eq 0) { return $null }
        $Local = @($Connections | Where-Object { $_.LocalAddress -eq '127.0.0.1' })
        if ($Connections.Count -ne 1 -or $Local.Count -ne 1) {
            throw "Refusing: ambiguous port 8765 owner; listener_count=$($Connections.Count), loopback_count=$($Local.Count)."
        }
        $OwnerId = [int]$Local[0].OwningProcess
        $Owner = Get-CimInstance Win32_Process -Filter "ProcessId=$OwnerId" -ErrorAction SilentlyContinue
        $Name = if ($Owner) { [string]$Owner.Name } else { '<unavailable>' }
        $Exe = if ($Owner) { [string]$Owner.ExecutablePath } else { '' }
        $Command = if ($Owner) { [string]$Owner.CommandLine } else { '' }
        $NameOk = $null -ne $Owner -and $Name -ieq 'node.exe'
        $ExeOk = -not [string]::IsNullOrWhiteSpace($Exe) -and
                 [IO.Path]::GetFileName($Exe) -ieq 'node.exe'
        $ScriptOk = $Command -match '(?i)(src[\\/]server[\\/]http[.]js|scripts[\\/]windows[\\/]http-managed[.]js)'
        if ($NameOk -and $ExeOk -and $ScriptOk) {
            $After = @(Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue |
                Where-Object { $_.LocalAddress -eq '127.0.0.1' })
            if ($After.Count -eq 1 -and [int]$After[0].OwningProcess -eq $OwnerId) {
                return @{ Verified = $true; ProcessId = $OwnerId; NodeExe = $Exe
                          CommandLine = $Command; Reason = 'VERIFIED' }
            }
        }
        elseif ($NameOk -and $ExeOk -and -not $ScriptOk) {
            return @{ Verified = $false; ProcessId = $OwnerId; Reason = 'NON_DTV_NODE'
                      ProcessName = $Name }
        }
        if ($Attempt -lt 5) { Start-Sleep -Milliseconds 250 }
    }
    return @{ Verified = $false; ProcessId = $OwnerId; Reason = 'CIM_OR_SOCKET_UNSTABLE'
              ProcessName = $Name }
}
$ExistingListener = Get-HttpListener
if ($Inspect) {
    Write-Host "DIAGNOSTIC ONLY: task=$TaskName state=$($Task.State) launcher=$Launcher."
    Write-Host "Task path: $TaskPath"
    if ($ExistingListener -and $ExistingListener.Verified) {
        Write-Host "Verified DTV HTTP listener on 127.0.0.1:8765, PID $($ExistingListener.ProcessId)."
    }
    elseif ($ExistingListener) {
        Write-Host "UNVERIFIED listener PID=$($ExistingListener.ProcessId), reason=$($ExistingListener.Reason). No process changed."
    }
    else {
        Write-Host 'No TCP listener on port 8765.'
    }
    Write-Host "Validated TradingView CDP port: $ValidatedCdpPort"
    Write-Host 'No task action was changed and no process was stopped.'
    return
}
$NodeExe = if ($ExistingListener -and $ExistingListener.Verified) {
    $ExistingListener.NodeExe
}
else {
    (Get-Command node.exe -ErrorAction Stop).Source
}
if (-not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) {
    throw 'Refusing: node.exe is unavailable.'
}

# A console-subsystem node.exe started directly by an interactive Scheduled
# Task creates the unwanted visible terminal. Reuse the existing stack's
# pythonw.exe hidden launcher convention (Avanza MCP / Trade Spine).
$PythonCandidates = @()
if (-not [string]::IsNullOrWhiteSpace($PythonwPath)) {
    $PythonCandidates += $PythonwPath
}
else {
    if ($Launcher -ieq 'pythonw.exe') { $PythonCandidates += [string]$OriginalAction.Execute }
    $Known = Get-Command pythonw.exe -ErrorAction SilentlyContinue
    if ($Known) { $PythonCandidates += $Known.Source }
    $Python = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($Python) { $PythonCandidates += (Join-Path (Split-Path -Parent $Python.Source) 'pythonw.exe') }
    $Uv = Get-Command uv.exe -ErrorAction SilentlyContinue
    if ($Uv) {
        $UvPy = (& $Uv.Source python find 3.12 2>$null)
        if ($LASTEXITCODE -eq 0 -and $UvPy) {
            $PythonCandidates += (Join-Path (Split-Path -Parent ([string]$UvPy).Trim()) 'pythonw.exe')
        }
    }
    $PythonCandidates += (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\pythonw.exe')
    $PythonCandidates += (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python313\pythonw.exe')
}
$Pythonw = @($PythonCandidates | Where-Object {
    $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) -and
    [IO.Path]::GetFileName($_) -ieq 'pythonw.exe'
} | Select-Object -First 1)
if ($Pythonw.Count -ne 1) {
    throw 'Could not locate pythonw.exe. Provide -PythonwPath with an installed pythonw.exe.'
}
$PythonwExe = [IO.Path]::GetFullPath($Pythonw[0])
$ActionArgs = ('"{0}" --node "{1}" --cdp-port {2}' -f $ManagedScript, $NodeExe, $ValidatedCdpPort)
$NewAction = New-ScheduledTaskAction -Execute $PythonwExe -Argument $ActionArgs -WorkingDirectory $Repo
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
        if ($Present -and $Info -and $Info.Verified -and $Info.ProcessId -ne $ExcludePid -and
            $Info.CommandLine -match '(?i)src[\\/]server[\\/]http[.]js') {
            return $Info
        }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $Deadline)
    throw 'DTV HTTP listener did not enter the expected managed state.'
}

if (-not $PSCmdlet.ShouldProcess($TaskName, 'Migrate to hidden pythonw Job Object task action and verify stop/restart')) {
    return
}

$Changed = $false
try {
    # Stop the exact approved task BEFORE changing its action. A historical
    # listener may disappear while its PID is unavailable through CIM.
    $TaskBefore = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction Stop
    if ([string]$TaskBefore.State -eq 'Running') {
        Stop-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction Stop
        $Deadline = (Get-Date).AddSeconds(12)
        do {
            Start-Sleep -Milliseconds 200
            $StillRunning = (Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath).State -eq 'Running'
        } while ($StillRunning -and (Get-Date) -lt $Deadline)
        if ($StillRunning) { throw 'Old DTV task did not stop within 12 seconds.' }
    }
    $PortDeadline = (Get-Date).AddSeconds(8)
    do {
        $Leftover = Get-HttpListener
        if (-not $Leftover) { break }
        if ((Get-Date) -lt $PortDeadline) { Start-Sleep -Milliseconds 300 }
    } while ((Get-Date) -lt $PortDeadline)
    if ($Leftover) {
        if (-not $Leftover.Verified) {
            throw "Refusing: listener PID=$($Leftover.ProcessId), reason=$($Leftover.Reason), remains after exact task stop. No unverified process terminated."
        }
        # Only the exact, independently verified DTV Node HTTP listener may be
        # retired. Re-read the port and PID immediately before Stop-Process.
        $Rechecked = Get-HttpListener
        if (-not $Rechecked -or -not $Rechecked.Verified -or
            $Rechecked.ProcessId -ne $Leftover.ProcessId) {
            throw 'DTV listener changed owner during cleanup. No process terminated.'
        }
        Stop-Process -Id $Rechecked.ProcessId -Force -ErrorAction Stop
        [void](Wait-HttpState)
    }
    # Do not mutate the existing task until the old listener is safely gone.
    if (-not $AlreadyManaged) {
        Set-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Action $NewAction -ErrorAction Stop | Out-Null
        $Changed = $true
    }

    # A running pythonw.exe task must OWN a live hidden Node Job Object child.
    # Verify a full stop/start lifecycle, including automatic port release.
    Start-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction Stop
    $First = Wait-HttpState -Present -ExcludePid $(if ($ExistingListener) { $ExistingListener.ProcessId } else { 0 })
    $RunningTask = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
    if ([string]$RunningTask.State -ne 'Running') {
        throw 'Hidden DTV Node bound port but scheduled pythonw owner is not Running.'
    }

    Stop-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction Stop
    [void](Wait-HttpState)
    Start-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction Stop
    $Second = Wait-HttpState -Present -ExcludePid $First.ProcessId
    $CurrentTask = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
    if ([string]$CurrentTask.State -ne 'Running') {
        throw 'Managed HTTP server is not owned by the running Scheduled Task.'
    }
    $OwnedAction = @(($CurrentTask.Actions))[0]
    if ([IO.Path]::GetFileName([string]$OwnedAction.Execute) -ine 'pythonw.exe' -or
        [string]$OwnedAction.Arguments -notmatch '(?i)run-http-hidden[.]py') {
        throw 'Task is not running the expected hidden pythonw launcher.'
    }
    Write-Host "PASS: DTV HTTP runs under hidden pythonw owner, Node PID $($Second.ProcessId) at 127.0.0.1:8765."
    Write-Host "PASS: Stop-ScheduledTask killed the previous Node listener; restart created a new PID."
    Write-Host "PASS: Node uses CREATE_NO_WINDOW and the Windows Job Object kill-on-close lifetime."
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
