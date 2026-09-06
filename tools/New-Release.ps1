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
    # Parsed with a regex rather than by splitting and indexing. The pipeline form produced
    # "0.0.1.0" from "0.0.1": the array did not have the shape the indexing assumed, and the
    # join quietly appended instead of replacing. A match either succeeds with three named
    # numbers or fails loudly.
    if ($package.version -notmatch '^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)$') {
        throw "extension/package.json version '$($package.version)' is not major.minor.patch."
    }
    $major = [int]$Matches.major
    $minor = [int]$Matches.minor
    $patch = [int]$Matches.patch

    switch ($Bump) {
        "major" { $major++; $minor = 0; $patch = 0 }
        "minor" { $minor++; $patch = 0 }
        "patch" { $patch++ }
    }
    $newVersion = "$major.$minor.$patch"

    # A targeted replacement of the version line, not a JSON round-trip. Reading the manifest
    # and writing it back through ConvertTo-Json reformats the whole file: a one-line version
    # change became a 293-line diff, which makes every release commit unreviewable and risks
    # losing anything the round-trip does not represent faithfully.
    $text = Get-Content $packageJson -Raw
    $updated = [regex]::Replace(
        $text,
        '("version"\s*:\s*")' + [regex]::Escape($package.version) + '(")',
        "`${1}$newVersion`${2}",
        [System.Text.RegularExpressions.RegexOptions]::None,
        [TimeSpan]::FromSeconds(5)
    )
    if ($updated -eq $text) {
        throw "Could not find the version string to replace in $packageJson."
    }
    # WriteAllText with an explicit BOM-less encoding, because Windows PowerShell's
    # `-Encoding utf8` emits a BOM — and a BOM at the start of package.json breaks strict JSON
    # parsers, which is a poor thing to introduce while cutting a release.
    [System.IO.File]::WriteAllText($packageJson, $updated, (New-Object System.Text.UTF8Encoding($false)))

    $package.version = $newVersion
    Write-Host "version -> $newVersion" -ForegroundColor Cyan
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
