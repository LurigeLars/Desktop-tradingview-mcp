# Restart ONLY the verified Desktop TradingView MCP HTTP Node server.
# Does not close, launch, configure, or modify TradingView Desktop/CDP charts.
# Requires explicit -Restart and an accessible CDP listener before stopping.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [switch]$Restart,
    [ValidateRange(1024, 65535)]
    [int]$CdpPort = 9333
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')).TrimEnd('\')
$ExpectedRepo = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Desktop-tradingview')).TrimEnd('\')
if (-not [string]::Equals($Repo, $ExpectedRepo, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing: repository is not the known LOCALAPPDATA\Desktop-tradingview checkout.'
}
$HttpScript = Join-Path $Repo 'src\server\http.js'
if (-not (Test-Path -LiteralPath $HttpScript -PathType Leaf)) {
    throw 'Refusing: expected local HTTP server script is missing.'
}
$ActiveBranch = (& git.exe -C $Repo rev-parse --abbrev-ref HEAD).Trim()
$OriginUrl = (& git.exe -C $Repo remote get-url origin).Trim()
if ($LASTEXITCODE -ne 0 -or $ActiveBranch -cne 'main' -or
    $OriginUrl -cnotin @(
        'https://github.com/LurigeLars/Desktop-tradingview-mcp',
        'https://github.com/LurigeLars/Desktop-tradingview-mcp.git'
    )) {
    throw 'Refusing: checkout is not the exact allowlisted main branch and GitHub origin.'
}
$Head = (& git.exe -C $Repo rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $Head -notmatch '^[0-9a-f]{40}$') {
    throw 'Refusing: installed Git revision could not be verified.'
}
$LocalStatus = (& git.exe -C $Repo status --porcelain)
if ($LASTEXITCODE -ne 0 -or $LocalStatus) {
    throw 'Refusing: local checkout has uncommitted changes.'
}
$CdpUrl = "http://127.0.0.1:$CdpPort/json/version"
try {
    $Cdp = Invoke-RestMethod -Uri $CdpUrl -TimeoutSec 4
    if (-not $Cdp.'Protocol-Version') {
        throw 'Missing CDP version marker'
    }
}
catch {
    throw "Refusing: verified CDP endpoint unavailable on loopback port $CdpPort."
}

# The HTTP bridge binds 127.0.0.1:8765, never a LAN address.
$Listeners = @(Get-NetTCPConnection -State Listen -LocalPort 8765 -ErrorAction Stop |
    Where-Object { $_.LocalAddress -eq '127.0.0.1' })
$OtherListeners = @(Get-NetTCPConnection -State Listen -LocalPort 8765 -ErrorAction Stop |
    Where-Object { $_.LocalAddress -ne '127.0.0.1' })
if ($Listeners.Count -ne 1 -or $OtherListeners.Count -ne 0) {
    throw 'Refusing: HTTP loopback listener ownership or binding is ambiguous.'
}
$OwnerPid = [int]$Listeners[0].OwningProcess
$Process = Get-CimInstance Win32_Process -Filter "ProcessId=$OwnerPid"
if ($null -eq $Process -or $Process.Name -ine 'node.exe' -or
    $Process.CommandLine -notmatch '(?i)src[\\/]server[\\/]http[.]js' -or
    [string]::IsNullOrWhiteSpace([string]$Process.ExecutablePath)) {
    throw 'Refusing: port 8765 is not owned by the expected Node HTTP process.'
}
$NodeExe = [string]$Process.ExecutablePath
if (-not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) {
    throw 'Refusing: original Node executable is unavailable.'
}

Write-Host "Validated server PID $OwnerPid at 127.0.0.1:8765."
Write-Host "Verified CDP at 127.0.0.1:$CdpPort and checkout $($Head.Substring(0, 8))."
Write-Host 'Restarting the MCP HTTP bridge only; TradingView Desktop stays open.'

Stop-Process -Id $OwnerPid -ErrorAction Stop
$Deadline = (Get-Date).AddSeconds(12)
do {
    Start-Sleep -Milliseconds 250
    $Remaining = @(Get-NetTCPConnection -State Listen -LocalPort 8765 -ErrorAction SilentlyContinue)
    if ($Remaining.Count -eq 0) { break }
    if ((Get-Date) -gt $Deadline) {
        throw 'The previous HTTP listener did not release port 8765. No second server started.'
    }
} while ($true)

$OldCdpPort = $env:TV_CDP_PORT
$OldHttpPort = $env:TV_MCP_HTTP_PORT
$OldHttpHost = $env:TV_MCP_HTTP_HOST
try {
    $env:TV_CDP_PORT = "$CdpPort"
    $env:TV_MCP_HTTP_HOST = '127.0.0.1'
    $env:TV_MCP_HTTP_PORT = '8765'
    $Started = Start-Process -FilePath $NodeExe -ArgumentList @('src/server/http.js') `
        -WorkingDirectory $Repo -WindowStyle Hidden -PassThru -ErrorAction Stop
}
finally {
    $env:TV_CDP_PORT = $OldCdpPort
    $env:TV_MCP_HTTP_HOST = $OldHttpHost
    $env:TV_MCP_HTTP_PORT = $OldHttpPort
}
$Deadline = (Get-Date).AddSeconds(18)
do {
    Start-Sleep -Milliseconds 300
    $New = @(Get-NetTCPConnection -State Listen -LocalPort 8765 -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -eq '127.0.0.1' })
    if ($New.Count -eq 1 -and [int]$New[0].OwningProcess -eq [int]$Started.Id) {
        Write-Host "Restarted DTV HTTP MCP successfully (PID $($Started.Id))."
        Write-Host 'Reconnect the ChatGPT DTV plugin session if it retained the old transport.'
        exit 0
    }
    if ($New.Count -gt 0 -and
        ([int]$New[0].OwningProcess -ne [int]$Started.Id)) {
        throw 'A different process acquired the MCP listener; investigate the supervisor.'
    }
    if ($Started.HasExited) {
        throw "The restarted Node process exited with code $($Started.ExitCode)."
    }
    if ((Get-Date) -gt $Deadline) {
        throw 'New Node process did not bind 127.0.0.1:8765 within 18 seconds.'
    }
} while ($true)
