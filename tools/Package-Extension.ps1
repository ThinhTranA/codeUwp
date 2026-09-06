<#
.SYNOPSIS
    Builds a .vsix that can be installed on another machine.

.DESCRIPTION
    The extension needs two native artefacts at runtime, and both have to travel inside the
    package: uwplaunch.exe (the app-model helper, which owns all the COM) and XamlTap.dll (the
    diagnostics provider injected into the running app). At development time these are found in
    the repo's build output; in a package they must sit under extension/bin, which is the first
    place the lookup checks.

    uwplaunch is published SELF-CONTAINED. Framework-dependent would be a few hundred KB
    instead of ~36 MB, but it would make the .NET runtime a prerequisite on every machine that
    installs this, and its absence surfaces as the launcher failing to start with nothing
    pointing at the cause. A large one-time download is the better trade.

    The tap is x64 only for now. It is loaded into the target app's process, so it must match
    the TARGET's architecture; an x86 or ARM64 app needs the matching build staged beside it.

.EXAMPLE
    .\tools\Package-Extension.ps1
    code --install-extension extension\uwp-tools-0.0.1.vsix
#>
[CmdletBinding()]
param(
    [switch] $SkipNative
)

$ErrorActionPreference = "Stop"

$repo = Split-Path $PSScriptRoot -Parent
$extension = Join-Path $repo "extension"
$stage = Join-Path $extension "bin"

function Use-Node {
    if (Get-Command node.exe -ErrorAction SilentlyContinue) { return }
    $candidates = Get-ChildItem "$env:USERPROFILE\tools" -Directory -Filter "node-*" -ErrorAction SilentlyContinue
    foreach ($candidate in $candidates) {
        if (Test-Path (Join-Path $candidate.FullName "node.exe")) {
            $env:Path = "$($candidate.FullName);$env:Path"
            return
        }
    }
    throw "Node.js was not found."
}

Use-Node

Write-Host "==> compiling the extension" -ForegroundColor Cyan
Push-Location $extension
try {
    & node (Join-Path $extension "node_modules\typescript\bin\tsc") -p .
    if ($LASTEXITCODE -ne 0) { throw "TypeScript compilation failed." }
}
finally { Pop-Location }

if (-not (Test-Path $stage)) { New-Item -ItemType Directory -Path $stage | Out-Null }

if (-not $SkipNative) {
    Write-Host "==> publishing uwplaunch (self-contained)" -ForegroundColor Cyan
    $dotnet = if (Get-Command dotnet -ErrorAction SilentlyContinue) { "dotnet" } else { "$env:ProgramFiles\dotnet\dotnet.exe" }
    & $dotnet publish (Join-Path $repo "src\UwpLaunch") `
        -c Release -r win-x64 --self-contained true `
        -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=true -p:DebugType=none `
        -v q --nologo -o $stage
    if ($LASTEXITCODE -ne 0) { throw "Publishing uwplaunch failed." }
    # The single-file publish leaves nothing else useful; drop anything that is not the exe so
    # the package stays honest about what it ships.
    Get-ChildItem $stage -File | Where-Object { $_.Name -ne "uwplaunch.exe" } | Remove-Item -Force

    Write-Host "==> building the XAML tap (x64)" -ForegroundColor Cyan
    & (Join-Path $repo "native\XamlTap\build.ps1") -Platform x64 | Out-Null
    $tapDir = Join-Path $stage "x64"
    New-Item -ItemType Directory -Force -Path $tapDir | Out-Null
    Copy-Item (Join-Path $repo "native\XamlTap\bin\x64\XamlTap.dll") $tapDir -Force
}

Write-Host "==> packaging" -ForegroundColor Cyan
Push-Location $extension
try {
    & node (Join-Path $extension "node_modules\@vscode\vsce\vsce") package --no-dependencies --allow-missing-repository
    if ($LASTEXITCODE -ne 0) { throw "vsce package failed." }
}
finally { Pop-Location }

$vsix = Get-ChildItem $extension -Filter "*.vsix" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Write-Host ""
Write-Host "built $($vsix.FullName) ($([math]::Round($vsix.Length/1MB,1)) MB)" -ForegroundColor Green
Write-Host ""
Write-Host "install it with:" -ForegroundColor DarkGray
Write-Host "  code --install-extension `"$($vsix.FullName)`"" -ForegroundColor DarkGray
