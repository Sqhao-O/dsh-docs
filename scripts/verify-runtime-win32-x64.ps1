#requires -Version 7.0
<#
.SYNOPSIS
Verifies every payload hash recorded in a dsh-docling Windows runtime manifest.

.DESCRIPTION
The runtime is a separately distributed binary artifact. Run this before
configuring `runtimeDir`, after copying it between machines, or in release CI.
It performs only local reads and fails on missing, changed, or unexpected files.
#>
[CmdletBinding()]
param(
    [Parameter()]
    [string]$RuntimeDirectory = (Join-Path $PSScriptRoot '..\.dsh-runtime\runtime-win32-x64')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$runtime = [System.IO.Path]::GetFullPath($RuntimeDirectory)
$manifestPath = Join-Path $runtime 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Runtime manifest was not found: $manifestPath"
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1 -or $manifest.artifact -ne 'dsh-docling-runtime-win32-x64') {
    throw 'Unsupported runtime manifest.'
}

$expected = @{}
foreach ($entry in $manifest.files) {
    if ($entry.path -notmatch '^[A-Za-z0-9._/-]+$' -or $entry.path.Contains('..')) {
        throw "Unsafe manifest path: $($entry.path)"
    }
    $expected[$entry.path] = $entry.sha256.ToLowerInvariant()
    $path = Join-Path $runtime ($entry.path -replace '/', '\\')
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Missing runtime payload: $($entry.path)"
    }
    $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected[$entry.path]) {
        throw "Runtime payload hash mismatch: $($entry.path)"
    }
}

$prefix = $runtime.TrimEnd('\', '/') + '\'
$actualPaths = @(
    Get-ChildItem -LiteralPath $runtime -File -Recurse |
        Where-Object { $_.FullName -notin @($manifestPath, (Join-Path $runtime 'sbom.spdx.json')) } |
        ForEach-Object { $_.FullName.Substring($prefix.Length).Replace('\', '/') }
)
$unexpected = @($actualPaths | Where-Object { -not $expected.ContainsKey($_) })
if ($unexpected.Count -gt 0) {
    throw "Unexpected runtime payload(s): $($unexpected -join ', ')"
}

Write-Host "Verified runtime payload hashes: $($expected.Count) files"
