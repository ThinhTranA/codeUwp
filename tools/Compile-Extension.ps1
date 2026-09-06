<#
.SYNOPSIS
    Compiles the VS Code extension. Used as the preLaunchTask for F5.

.DESCRIPTION
    A script rather than an inline task command, for two reasons that both cost time to
    discover:

      - VS Code's built-in "npm" task type resolves its `path` property in ways that are easy
        to get subtly wrong, and a mismatch shows up only as "terminated with exit code 1"
        with no indication that it ran in the wrong directory.
      - Node is installed per-user here. A VS Code instance that was started before the PATH
        entry was added keeps the environment it launched with, so `npm` is simply not found
        and the debug session is aborted before anything of ours runs.

    So this resolves Node itself, falling back to known install locations, and reports what it
    found rather than failing with a bare exit code.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$extensionDir = Join-Path (Split-Path $PSScriptRoot -Parent) "extension"
if (-not (Test-Path $extensionDir)) { throw "Extension directory not found: $extensionDir" }

function Resolve-NodeDirectory {
    $onPath = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($onPath) { return Split-Path $onPath.Source -Parent }

    # Not on this process's PATH. It may still be on the user's, if this shell predates the
    # install, so check the registry value rather than the inherited environment.
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $candidates = @()
    if ($userPath) { $candidates += $userPath -split ';' }
    $candidates += @(
        "$env:ProgramFiles\nodejs",
        "${env:ProgramFiles(x86)}\nodejs",
        "$env:LOCALAPPDATA\Programs\nodejs"
    )
    $candidates += Get-ChildItem "$env:USERPROFILE\tools" -Directory -Filter "node-*" -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty FullName

    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path (Join-Path $candidate "node.exe"))) { return $candidate }
    }
    return $null
}

$nodeDir = Resolve-NodeDirectory
if (-not $nodeDir) {
    throw "Node.js was not found. Install it, or add its directory to PATH and restart VS Code."
}

if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
    Write-Host "node not on PATH for this process; using $nodeDir" -ForegroundColor DarkYellow
    Write-Host "(restart VS Code to pick up the user PATH permanently)" -ForegroundColor DarkYellow
    $env:Path = "$nodeDir;$env:Path"
}

Push-Location $extensionDir
try {
    # tsc is invoked directly rather than through `npm run`, so the exit code is the
    # compiler's and nothing else can fail in between.
    $tsc = Join-Path $extensionDir "node_modules\typescript\bin\tsc"
    if (-not (Test-Path $tsc)) {
        Write-Host "node_modules missing; running npm install" -ForegroundColor DarkYellow
        & npm.cmd install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE." }
    }

    & node.exe $tsc -p .
    if ($LASTEXITCODE -ne 0) { throw "Compilation failed with exit code $LASTEXITCODE." }
    Write-Host "extension compiled" -ForegroundColor Green
}
finally {
    Pop-Location
}
