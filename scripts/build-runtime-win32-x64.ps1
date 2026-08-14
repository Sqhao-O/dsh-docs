#requires -Version 7.0
<#
.SYNOPSIS
Builds the audited, offline-by-default Windows x64 CPython/Xberg runtime.

.DESCRIPTION
The resulting directory intentionally lives under .dsh-runtime/ (gitignored).
It contains no installer logic and never updates a user's global Python. Every
downloaded executable/model asset is pinned by SHA-256 before it is unpacked.

The script refuses an existing output directory rather than replacing it.
#>
[CmdletBinding()]
param(
    [Parameter()]
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\.dsh-runtime\runtime-win32-x64')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$PythonVersion = '3.11.9'
$PythonArchiveName = "python-$PythonVersion-embed-amd64.zip"
$PythonArchiveUri = "https://www.python.org/ftp/python/$PythonVersion/$PythonArchiveName"
$PythonArchiveSha256 = '009d6bf7e3b2ddca3d784fa09f90fe54336d5b60f0e0f305c37f400bf83cfd3b'

# Pin a commit as well as each model hash. Updating a language pack requires a
# source/quality/license review and a deliberate source change here.
$TessdataCommit = '87416418657359cb625c412a48b6e1d6d41c29bd'
$TessdataBaseUri = "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/$TessdataCommit"
$TessdataAssets = @(
    [ordered]@{
        Name = 'eng'
        File = 'eng.traineddata'
        Uri = "$TessdataBaseUri/eng.traineddata"
        Sha256 = '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2'
        License = 'Apache-2.0'
    },
    [ordered]@{
        Name = 'chi_sim'
        File = 'chi_sim.traineddata'
        Uri = "$TessdataBaseUri/chi_sim.traineddata"
        Sha256 = 'a5fcb6f0db1e1d6d8522f39db4e848f05984669172e584e8d76b6b3141e1f730'
        License = 'Apache-2.0'
    }
)
$TessdataLicense = [ordered]@{
    File = 'tessdata_fast-Apache-2.0.txt'
    Uri = "$TessdataBaseUri/LICENSE"
    Sha256 = 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'
}

function Get-Sha256 {
    param([Parameter(Mandatory)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-PinnedFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$ExpectedSha256
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Missing downloaded asset: $Path"
    }
    $actual = Get-Sha256 -Path $Path
    if ($actual -ne $ExpectedSha256.ToLowerInvariant()) {
        throw "SHA-256 mismatch for '$Path'. Expected $ExpectedSha256, received $actual."
    }
}

function Get-PinnedFile {
    param(
        [Parameter(Mandatory)][string]$Uri,
        [Parameter(Mandatory)][string]$Destination,
        [Parameter(Mandatory)][string]$ExpectedSha256
    )

    if (Test-Path -LiteralPath $Destination -PathType Leaf) {
        Assert-PinnedFile -Path $Destination -ExpectedSha256 $ExpectedSha256
        return
    }

    $directory = Split-Path -Parent $Destination
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $partial = "$Destination.$([guid]::NewGuid().ToString('N')).part"
    try {
        Invoke-WebRequest -Uri $Uri -OutFile $partial
        Assert-PinnedFile -Path $partial -ExpectedSha256 $ExpectedSha256
        Move-Item -LiteralPath $partial -Destination $Destination
    } finally {
        if (Test-Path -LiteralPath $partial -PathType Leaf) {
            Remove-Item -LiteralPath $partial -Force
        }
    }
}

function Get-XbergLock {
    param([Parameter(Mandatory)][string]$RequirementsPath)

    $contents = Get-Content -LiteralPath $RequirementsPath -Raw
    # Collapse pip's continuation slash into a normal whitespace separator.
    $normalized = $contents -replace '\\\s*', ' '
    $match = [regex]::Match(
        $normalized,
        'xberg==(?<version>[0-9]+\.[0-9]+\.[0-9]+)\s+--hash=sha256:(?<sha>[a-fA-F0-9]{64})',
        [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
    )
    if (-not $match.Success) {
        throw "Could not locate a hash-pinned xberg requirement in '$RequirementsPath'."
    }
    return [ordered]@{
        Version = $match.Groups['version'].Value
        Sha256 = $match.Groups['sha'].Value.ToLowerInvariant()
    }
}

function Get-PinnedXbergWheel {
    param(
        [Parameter(Mandatory)]$Lock,
        [Parameter(Mandatory)][string]$DownloadDirectory
    )

    $wheelName = "xberg-$($Lock.Version)-cp310-abi3-win_amd64.whl"
    $metadata = Invoke-RestMethod -Uri "https://pypi.org/pypi/xberg/$($Lock.Version)/json"
    $candidate = @(
        $metadata.urls | Where-Object {
            $_.filename -eq $wheelName -and $_.packagetype -eq 'bdist_wheel'
        }
    ) | Select-Object -First 1
    if ($null -eq $candidate) {
        throw "PyPI did not publish expected Windows x64 wheel '$wheelName'."
    }
    if ($candidate.digests.sha256.ToLowerInvariant() -ne $Lock.Sha256) {
        throw "PyPI metadata SHA-256 for '$wheelName' does not match python/requirements/win32-x64.txt."
    }

    $destination = Join-Path $DownloadDirectory $wheelName
    Get-PinnedFile -Uri $candidate.url -Destination $destination -ExpectedSha256 $Lock.Sha256
    return $destination
}

function Write-Utf8 {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Content
    )
    $parent = Split-Path -Parent $Path
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    [System.IO.File]::WriteAllText(
        $Path,
        $Content,
        [System.Text.UTF8Encoding]::new($false)
    )
}

function Get-RelativeRuntimeFiles {
    param([Parameter(Mandatory)][string]$RuntimeDirectory)

    $prefix = $RuntimeDirectory.TrimEnd('\', '/') + '\'
    return @(
        Get-ChildItem -LiteralPath $RuntimeDirectory -File -Recurse |
            Where-Object {
                $_.FullName -notin @(
                    (Join-Path $RuntimeDirectory 'manifest.json'),
                    (Join-Path $RuntimeDirectory 'sbom.spdx.json')
                )
            } |
            Sort-Object FullName |
            ForEach-Object {
                [ordered]@{
                    path = $_.FullName.Substring($prefix.Length).Replace('\', '/')
                    size = [int64]$_.Length
                    sha256 = Get-Sha256 -Path $_.FullName
                }
            }
    )
}

function Invoke-EmbeddedSmoke {
    param(
        [Parameter(Mandatory)][string]$PythonExe,
        [Parameter(Mandatory)][string]$RuntimeDirectory
    )

    $smokePath = Join-Path $RuntimeDirectory '.build-smoke.py'
    $smoke = @'
import asyncio
import base64
import os
from pathlib import Path

import xberg

TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFUlEQVR4nGP8//8/AzbAhFV00EoAAFbUAw037MyjAAAAAElFTkSuQmCC"


async def main():
    tessdata = Path(os.environ["DSH_DOCLING_TESSDATA_PATH"])
    eng = tessdata / "eng.traineddata"
    result = await xberg.extract(
        xberg.ExtractInput(
            kind="bytes",
            bytes=base64.b64decode(TINY_PNG),
            filename="runtime-smoke.png",
        ),
        {
            "use_cache": False,
            "force_ocr": True,
            "output_format": "markdown",
            "ocr": xberg.OcrConfig(
                backend="tesseract",
                language=["eng"],
                tessdata_path=str(tessdata),
                tessdata_bytes={"eng": eng.read_bytes()},
            ),
        },
    )
    if result.summary.errors != 0 or len(result.results) != 1:
        raise RuntimeError(f"Xberg smoke extraction failed: {result.errors!r}")
    print(f"xberg={xberg.__version__}; ocr_used={result.results[0].metadata.ocr_used}")


asyncio.run(main())
'@
    Write-Utf8 -Path $smokePath -Content $smoke

    $names = @(
        'DSH_DOCLING_TESSDATA_PATH',
        'XBERG_CACHE_DIR',
        'HF_HUB_OFFLINE',
        'HUGGINGFACE_HUB_OFFLINE',
        'HF_HOME',
        'HF_HUB_CACHE'
    )
    $previous = @{}
    foreach ($name in $names) {
        $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    }

    try {
        $cacheRoot = Join-Path $RuntimeDirectory 'cache'
        New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null
        $env:DSH_DOCLING_TESSDATA_PATH = Join-Path $RuntimeDirectory 'ocr\tessdata'
        $env:XBERG_CACHE_DIR = $cacheRoot
        $env:HF_HUB_OFFLINE = '1'
        $env:HUGGINGFACE_HUB_OFFLINE = '1'
        $env:HF_HOME = Join-Path $cacheRoot 'huggingface'
        $env:HF_HUB_CACHE = Join-Path $env:HF_HOME 'hub'

        & $PythonExe $smokePath
        if ($LASTEXITCODE -ne 0) {
            throw "Embedded Python/Xberg smoke test exited with code $LASTEXITCODE."
        }
    } finally {
        foreach ($name in $names) {
            if ($null -eq $previous[$name]) {
                Remove-Item "Env:$name" -ErrorAction SilentlyContinue
            } else {
                Set-Item "Env:$name" $previous[$name]
            }
        }
        if (Test-Path -LiteralPath $smokePath -PathType Leaf) {
            Remove-Item -LiteralPath $smokePath -Force
        }
    }
}

if ($env:OS -ne 'Windows_NT') {
    throw 'This runtime builder only supports Windows x64.'
}

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$artifactRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot '.dsh-runtime'))
$output = [System.IO.Path]::GetFullPath($OutputDirectory)
$artifactPrefix = $artifactRoot.TrimEnd('\', '/') + '\'
if (-not $output.StartsWith($artifactPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputDirectory must remain below the gitignored '$artifactRoot' directory."
}
if (Test-Path -LiteralPath $output) {
    throw "Refusing to overwrite existing runtime output '$output'. Choose a new path or remove it explicitly."
}

$requirementsPath = Join-Path $repoRoot 'python\requirements\win32-x64.txt'
$workerSource = Join-Path $repoRoot 'python\worker.py'
if (-not (Test-Path -LiteralPath $requirementsPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $workerSource -PathType Leaf)) {
    throw 'Expected runtime source files are missing.'
}

$lock = Get-XbergLock -RequirementsPath $requirementsPath
if ($lock.Version -ne '1.0.14') {
    throw "This builder is reviewed for Xberg 1.0.14, received lock version $($lock.Version)."
}

New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null
$downloadDirectory = Join-Path $artifactRoot 'downloads'
$pythonArchive = Join-Path $downloadDirectory $PythonArchiveName
Get-PinnedFile -Uri $PythonArchiveUri -Destination $pythonArchive -ExpectedSha256 $PythonArchiveSha256
$wheel = Get-PinnedXbergWheel -Lock $lock -DownloadDirectory $downloadDirectory

foreach ($asset in $TessdataAssets) {
    Get-PinnedFile -Uri $asset.Uri -Destination (Join-Path $downloadDirectory $asset.File) -ExpectedSha256 $asset.Sha256
}
Get-PinnedFile -Uri $TessdataLicense.Uri -Destination (Join-Path $downloadDirectory $TessdataLicense.File) -ExpectedSha256 $TessdataLicense.Sha256

$stage = Join-Path $artifactRoot ".build-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Force -Path $stage | Out-Null

try {
    $pythonRoot = Join-Path $stage 'python'
    Expand-Archive -LiteralPath $pythonArchive -DestinationPath $pythonRoot -Force
    $pythonExe = Join-Path $pythonRoot 'python.exe'
    if (-not (Test-Path -LiteralPath $pythonExe -PathType Leaf)) {
        throw 'The CPython embeddable archive did not contain python.exe.'
    }

    $pth = @(Get-ChildItem -LiteralPath $pythonRoot -Filter 'python*._pth' -File)
    if ($pth.Count -ne 1) {
        throw 'Expected exactly one CPython embedded ._pth file.'
    }
    Write-Utf8 -Path $pth[0].FullName -Content @"
$($pth[0].BaseName -replace '_', '').zip
.
Lib\site-packages
import site
"@

    $sitePackages = Join-Path $pythonRoot 'Lib\site-packages'
    New-Item -ItemType Directory -Force -Path $sitePackages | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($wheel, $sitePackages)

    $xbergMetadata = Join-Path $sitePackages "xberg-$($lock.Version).dist-info\METADATA"
    if (-not (Test-Path -LiteralPath $xbergMetadata -PathType Leaf)) {
        throw 'Xberg wheel metadata was not found after extraction.'
    }
    if ((Get-Content -LiteralPath $xbergMetadata -Raw) -match '(?m)^Requires-Dist:') {
        throw 'The pinned Xberg wheel unexpectedly has third-party Python dependencies.'
    }

    Copy-Item -LiteralPath $workerSource -Destination (Join-Path $pythonRoot 'worker.py')
    Copy-Item -LiteralPath $requirementsPath -Destination (Join-Path $pythonRoot 'requirements-win32-x64.txt')

    $tessdataDirectory = Join-Path $stage 'ocr\tessdata'
    New-Item -ItemType Directory -Force -Path $tessdataDirectory | Out-Null
    foreach ($asset in $TessdataAssets) {
        Copy-Item -LiteralPath (Join-Path $downloadDirectory $asset.File) -Destination (Join-Path $tessdataDirectory $asset.File)
    }

    $licenseDirectory = Join-Path $stage 'licenses'
    New-Item -ItemType Directory -Force -Path $licenseDirectory | Out-Null
    Copy-Item -LiteralPath (Join-Path $pythonRoot 'LICENSE.txt') -Destination (Join-Path $licenseDirectory 'Python-PSF-2.0.txt')
    Copy-Item -LiteralPath (Join-Path $sitePackages "xberg-$($lock.Version).dist-info\licenses\LICENSE") -Destination (Join-Path $licenseDirectory 'xberg-MIT.txt')
    Copy-Item -LiteralPath (Join-Path $downloadDirectory $TessdataLicense.File) -Destination (Join-Path $licenseDirectory $TessdataLicense.File)

    # The wheel carries a much more detailed native/Rust component inventory
    # than Python's Requires-Dist metadata can express. Keep that upstream
    # CycloneDX document beside our top-level SPDX/file inventory for release
    # review instead of incorrectly presenting the latter as a full dependency
    # graph.
    $xbergCycloneDx = Join-Path $sitePackages "xberg-$($lock.Version).dist-info\sboms\xberg-py.cyclonedx.json"
    if (-not (Test-Path -LiteralPath $xbergCycloneDx -PathType Leaf)) {
        throw 'The pinned Xberg wheel did not contain its CycloneDX component inventory.'
    }
    $vendorSbomDirectory = Join-Path $stage 'sbom'
    New-Item -ItemType Directory -Force -Path $vendorSbomDirectory | Out-Null
    Copy-Item -LiteralPath $xbergCycloneDx -Destination (Join-Path $vendorSbomDirectory 'xberg-py.cyclonedx.json')

    $launcher = @'
@echo off
setlocal EnableExtensions
set "RUNTIME_ROOT=%~dp0"
set "DSH_DOCLING_TESSDATA_PATH=%RUNTIME_ROOT%ocr\tessdata"
set "XBERG_CACHE_DIR=%RUNTIME_ROOT%cache"
set "HF_HUB_OFFLINE=1"
set "HUGGINGFACE_HUB_OFFLINE=1"
set "HF_HOME=%XBERG_CACHE_DIR%\huggingface"
set "HF_HUB_CACHE=%HF_HOME%\hub"
if not exist "%XBERG_CACHE_DIR%" mkdir "%XBERG_CACHE_DIR%"
"%RUNTIME_ROOT%python\python.exe" "%RUNTIME_ROOT%python\worker.py" %*
exit /b %ERRORLEVEL%
'@
    Write-Utf8 -Path (Join-Path $stage 'run-worker.cmd') -Content $launcher

    Invoke-EmbeddedSmoke -PythonExe $pythonExe -RuntimeDirectory $stage
    $smokeCache = Join-Path $stage 'cache'
    if (Test-Path -LiteralPath $smokeCache -PathType Container) {
        Remove-Item -LiteralPath $smokeCache -Recurse -Force
    }

    $noticeLines = @(
        'DSH document runtime third-party notices',
        '=========================================',
        '',
        "CPython $PythonVersion (PSF-2.0)",
        "  Source: $PythonArchiveUri",
        "  SHA-256: $PythonArchiveSha256",
        '  Full text: licenses/Python-PSF-2.0.txt',
        '',
        "Xberg $($lock.Version) (MIT)",
        "  Source: PyPI wheel $([System.IO.Path]::GetFileName($wheel))",
        "  SHA-256: $($lock.Sha256)",
        '  Full text: licenses/xberg-MIT.txt',
        '  Component inventory: sbom/xberg-py.cyclonedx.json',
        '',
        "tessdata_fast language data at commit $TessdataCommit (Apache-2.0)",
        "  Source: $TessdataBaseUri",
        "  Full text: licenses/$($TessdataLicense.File)"
    )
    $noticeLines += @($TessdataAssets | ForEach-Object { "  $($_.File): $($_.Sha256)" })
    $noticeLines += @(
        '',
        'This artifact is offline by default. Do not enable model downloads or replace',
        'these assets without updating their version, source URI, SHA-256, license',
        'records, and validation evidence.'
    )
    Write-Utf8 -Path (Join-Path $stage 'NOTICE') -Content ($noticeLines -join [Environment]::NewLine)

    $files = Get-RelativeRuntimeFiles -RuntimeDirectory $stage
    $created = [DateTime]::UtcNow.ToString('o')
    $components = @(
        [ordered]@{
            name = 'CPython embeddable package'
            version = $PythonVersion
            license = 'PSF-2.0'
            downloadLocation = $PythonArchiveUri
            sha256 = $PythonArchiveSha256
        },
        [ordered]@{
            name = 'xberg'
            version = $lock.Version
            license = 'MIT'
            downloadLocation = "https://pypi.org/project/xberg/$($lock.Version)/"
            sha256 = $lock.Sha256
        }
    ) + @(
        $TessdataAssets | ForEach-Object {
            [ordered]@{
                name = $_.File
                version = $TessdataCommit
                license = $_.License
                downloadLocation = $_.Uri
                sha256 = $_.Sha256
            }
        }
    )

    $manifest = [ordered]@{
        schemaVersion = 1
        artifact = 'dsh-docling-runtime-win32-x64'
        platform = 'win32-x64'
        createdUtc = $created
        offlineDefaults = [ordered]@{
            DSH_DOCLING_TESSDATA_PATH = 'ocr/tessdata'
            XBERG_CACHE_DIR = 'cache'
            HF_HUB_OFFLINE = '1'
            HUGGINGFACE_HUB_OFFLINE = '1'
        }
        components = $components
        thirdPartyComponentInventory = 'sbom/xberg-py.cyclonedx.json'
        files = $files
    }
    Write-Utf8 -Path (Join-Path $stage 'manifest.json') -Content ($manifest | ConvertTo-Json -Depth 12)

    $spdx = [ordered]@{
        SPDXID = 'SPDXRef-DOCUMENT'
        spdxVersion = 'SPDX-2.3'
        name = 'dsh-docling-runtime-win32-x64'
        dataLicense = 'CC0-1.0'
        documentComment = 'This SPDX document inventories the runtime artifact files and top-level source components. The Xberg wheel vendor component inventory is copied separately at sbom/xberg-py.cyclonedx.json and must be reviewed with this document.'
        creationInfo = [ordered]@{
            created = $created
            creators = @('Tool: scripts/build-runtime-win32-x64.ps1')
        }
        packages = @(
            $components | ForEach-Object {
                [ordered]@{
                    SPDXID = "SPDXRef-$($_.name -replace '[^A-Za-z0-9.-]', '-')"
                    name = $_.name
                    versionInfo = $_.version
                    downloadLocation = $_.downloadLocation
                    licenseConcluded = $_.license
                    licenseDeclared = $_.license
                    checksums = @([ordered]@{ algorithm = 'SHA256'; checksumValue = $_.sha256 })
                }
            }
        )
        files = @(
            $files | ForEach-Object {
                [ordered]@{
                    SPDXID = "SPDXRef-File-$($_.path -replace '[^A-Za-z0-9.-]', '-')"
                    fileName = $_.path
                    checksums = @([ordered]@{ algorithm = 'SHA256'; checksumValue = $_.sha256 })
                }
            }
        )
    }
    Write-Utf8 -Path (Join-Path $stage 'sbom.spdx.json') -Content ($spdx | ConvertTo-Json -Depth 16)

    Move-Item -LiteralPath $stage -Destination $output
    Write-Host "Built offline Windows x64 runtime: $output"
    Write-Host "Manifest: $(Join-Path $output 'manifest.json')"
} catch {
    Write-Error "Runtime build failed. Preserved staging directory for audit: $stage"
    throw
}
