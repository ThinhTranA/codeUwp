<#
.SYNOPSIS
    Compiles the extension and opens a VS Code Extension Development Host running it.

.DESCRIPTION
    Three things this does that are easy to forget, and that each cost time when missed:

      - Compiles FIRST. A host that is already running will pick up half-written files from
        out/ if you rebuild underneath it, and crash.
      - Scrubs ELECTRON_RUN_AS_NODE and VSCODE_* from the environment. Launching from a
        terminal inside VS Code inherits them, and the child VS Code then starts as plain Node
        and dies trying to require the workspace path.
      - Clears leftover uwplaunch and app processes, and truncates the log, so the next run's
        log is unambiguous.

.EXAMPLE
    .\tools\Start-DevHost.ps1
#>
[CmdletBinding()]
param(
    [string] $Workspace = (Split-Path $PSScriptRoot -Parent),
    [switch] $NoCompile
)

$ErrorActionPreference = "Stop"

$repo = Split-Path $PSScriptRoot -Parent
$extension = Join-Path $repo "extension"

if (-not $NoCompile) {
    Write-Host "compiling..." -ForegroundColor Cyan
    & (Join-Path $PSScriptRoot "Compile-Extension.ps1")
}

Get-Process -Name "uwplaunch", "ClassicUwpWinUI2" -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue

$log = Join-Path $env:LOCALAPPDATA "Temp\uwp-tools\extension.log"
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
Set-Content -Path $log -Value "" -Encoding utf8

foreach ($name in @("ELECTRON_RUN_AS_NODE")) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
Get-ChildItem Env: | Where-Object { $_.Name -like 'VSCODE_*' } |
    ForEach-Object { Remove-Item "Env:$($_.Name)" -ErrorAction SilentlyContinue }

$code = Join-Path $env:LOCALAPPDATA "Programs\Microsoft VS Code\Code.exe"
if (-not (Test-Path $code)) { throw "VS Code not found at $code" }

$sample = Join-Path $repo "samples\ClassicUwpWinUI2\MainPage.xaml"
Start-Process -FilePath $code -ArgumentList @(
    "--extensionDevelopmentPath=$extension",
    "--new-window",
    $Workspace,
    $sample
)

Write-Host "Extension Development Host launched on $Workspace" -ForegroundColor Green
Write-Host "log: $log" -ForegroundColor DarkGray
Write-Host ""
Write-Host 'In that window: Ctrl+Shift+P -> "UWP: Build, Deploy and Run", wait for the flame' -ForegroundColor DarkGray
Write-Host 'in the status bar, then edit a .xaml and save.' -ForegroundColor DarkGray
