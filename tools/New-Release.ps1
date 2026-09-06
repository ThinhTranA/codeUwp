<#
.SYNOPSIS
    Tags a release, which the GitHub workflow turns into a Releases entry with the .vsix
    attached.

.DESCRIPTION
    The tag is the trigger; .github/workflows/release.yml does the building and publishing on
    GitHub, so nothing here needs a local GitHub login.

    The version in extension/package.json is the source of truth, and the tag is derived from
    it. A tag that disagreed with the package version would produce a release whose asset says
    something different from its title.

.EXAMPLE
    .\tools\New-Release.ps1            # tags the current package version
    .\tools\New-Release.ps1 -Bump patch
#>
[CmdletBinding()]
param(
    [ValidateSet("none", "patch", "minor", "major")]
    [string] $Bump = "none",
    [switch] $Push
)

$ErrorActionPreference = "Stop"

$repo = Split-Path $PSScriptRoot -Parent
$packageJson = Join-Path $repo "extension\package.json"
$package = Get-Content $packageJson -Raw | ConvertFrom-Json

if ($Bump -ne "none") {
    $parts = $package.version.Split('.') | ForEach-Object { [int]$_ }
    switch ($Bump) {
        "major" { $parts = @($parts[0] + 1, 0, 0) }
        "minor" { $parts = @($parts[0], $parts[1] + 1, 0) }
        "patch" { $parts = @($parts[0], $parts[1], $parts[2] + 1) }
    }
    $package.version = $parts -join '.'
    # Round-trips the whole file, so anything not represented here would be lost; the
    # extension manifest is plain JSON, so it is.
    $package | ConvertTo-Json -Depth 100 | Set-Content $packageJson -Encoding utf8
    Write-Host "version -> $($package.version)" -ForegroundColor Cyan
}

$tag = "v$($package.version)"

$status = git -C $repo status --porcelain
if ($status) {
    Write-Warning "The working tree is not clean. Commit before tagging, or the tag will not describe what is released."
    $status | Write-Host
    if (-not $Push) { return }
}

git -C $repo tag -a $tag -m "uwp-tools $($package.version)"
Write-Host "tagged $tag" -ForegroundColor Green

if ($Push) {
    git -C $repo push origin $tag
    Write-Host "pushed $tag; the release workflow will build and attach the .vsix" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "Not pushed. To publish:" -ForegroundColor DarkGray
    Write-Host "  git push origin $tag" -ForegroundColor DarkGray
}
