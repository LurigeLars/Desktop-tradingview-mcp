# Exercise the exact production parser with synthetic Docker output.
# Extract only the function definition; never invoke the maintenance entrypoint.
$ErrorActionPreference = 'Stop'
$Source = Join-Path $PSScriptRoot 'refresh-cdp-guard.ps1'
$Tokens = $null
$ParseErrors = $null
$Ast = [System.Management.Automation.Language.Parser]::ParseFile($Source, [ref]$Tokens, [ref]$ParseErrors)
if ($ParseErrors.Count) { throw 'Maintenance script failed to parse.' }
$Functions = @($Ast.FindAll({
    param($Node)
    $Node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $Node.Name -eq 'Get-GuardState'
}, $true))
if ($Functions.Count -ne 1) { throw 'Expected one guard state parser.' }
. ([scriptblock]::Create($Functions[0].Extent.Text))

function Get-GuardDockerValue {
    param([string[]]$DockerArguments)
    if (($DockerArguments -join ' ') -cne 'container inspect --format {{json .}} dtv-cdp-guard') {
        throw 'Unexpected Docker command in guard parser.'
    }
    return ($script:Fixture | ConvertTo-Json -Depth 10 -Compress)
}
$ConfigId = 'sha256:' + ('a' * 64)
$ManifestId = 'sha256:' + ('b' * 64)
$script:Fixture = @{
    Id = ('c' * 64)
    Image = $ConfigId
    Config = @{ Labels = @{
        'com.docker.compose.project' = 'tradingview-mcp-public'
        'com.docker.compose.service' = 'cdp-guard'
    }}
    State = @{ Running = $true; Health = @{ Status = 'healthy' } }
    ImageManifestDescriptor = @{
        mediaType = 'application/vnd.oci.image.manifest.v1+json'
        digest = $ManifestId
        platform = @{ os = 'linux'; architecture = 'amd64' }
    }
}
$State = Get-GuardState
if ($State.Image -cne $ManifestId -or $State.Platform -cne 'linux/amd64' -or
    -not $State.Running -or $State.Health -cne 'healthy') {
    throw 'Lowercase OCI manifest without variant was not parsed correctly.'
}
$script:Fixture.ImageManifestDescriptor.platform.variant = 'v3'
if ((Get-GuardState).Platform -cne 'linux/amd64/v3') { throw 'Variant handling failed.' }
$script:Fixture.Remove('ImageManifestDescriptor')
$script:Fixture.State.Running = $false
$Legacy = Get-GuardState
if ($Legacy.Image -cne $ConfigId -or $Legacy.Platform -ne '' -or $Legacy.Running) {
    throw 'Legacy identity or stopped-container boolean was not parsed correctly.'
}
$script:Fixture.Config.Labels.'com.docker.compose.service' = 'wrong'
$Rejected = $false
try { $null = Get-GuardState } catch { $Rejected = $true }
if (-not $Rejected) { throw 'Unexpected container identity was accepted.' }
Write-Output 'CDP_GUARD_INSPECT_REGRESSION_OK'
