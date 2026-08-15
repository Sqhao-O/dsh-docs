#!/usr/bin/env node
/**
 * Builds the audited, offline-by-default Windows x64 CPython/Xberg runtime.
 *
 * The resulting directory intentionally lives under .dsh-runtime/ (gitignored).
 * It contains no installer logic and never updates a user's global Python. Every
 * downloaded executable/model asset is pinned by SHA-256 before it is unpacked.
 *
 * The script refuses an existing output directory rather than replacing it.
 *
 * Runs on any shell (cmd, PowerShell, pwsh, Git Bash) with the Node.js version
 * already required by this package. Usage:
 *
 *   node scripts/build-runtime-win32-x64.mjs [output-directory]
 */
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'

const PYTHON_VERSION = '3.11.9'
const PYTHON_ARCHIVE_NAME = `python-${PYTHON_VERSION}-embed-amd64.zip`
const PYTHON_ARCHIVE_URI = `https://www.python.org/ftp/python/${PYTHON_VERSION}/${PYTHON_ARCHIVE_NAME}`
const PYTHON_ARCHIVE_SHA256 = '009d6bf7e3b2ddca3d784fa09f90fe54336d5b60f0e0f305c37f400bf83cfd3b'

// Pin a commit as well as each model hash. Updating a language pack requires a
// source/quality/license review and a deliberate source change here.
const TESSDATA_COMMIT = '87416418657359cb625c412a48b6e1d6d41c29bd'
const TESSDATA_BASE_URI = `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${TESSDATA_COMMIT}`
const TESSDATA_ASSETS = [
  {
    name: 'eng',
    file: 'eng.traineddata',
    uri: `${TESSDATA_BASE_URI}/eng.traineddata`,
    sha256: '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2',
    license: 'Apache-2.0'
  },
  {
    name: 'chi_sim',
    file: 'chi_sim.traineddata',
    uri: `${TESSDATA_BASE_URI}/chi_sim.traineddata`,
    sha256: 'a5fcb6f0db1e1d6d8522f39db4e848f05984669172e584e8d76b6b3141e1f730',
    license: 'Apache-2.0'
  }
]
const TESSDATA_LICENSE = {
  file: 'tessdata_fast-Apache-2.0.txt',
  uri: `${TESSDATA_BASE_URI}/LICENSE`,
  sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'
}

const SMOKE_SOURCE = `import asyncio
import base64
import os
from pathlib import Path

import xberg

TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFUlEQVR4nGP8//8/AzbAhFV00EoAAFbUAw037MyjAAAAAElFTkSuQmCC"


async def main():
    tessdata = Path(os.environ["DSH_DOC_TESSDATA_PATH"])
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
`

const LAUNCHER_SOURCE = [
  '@echo off',
  'setlocal EnableExtensions',
  'set "RUNTIME_ROOT=%~dp0"',
  'set "DSH_DOC_TESSDATA_PATH=%RUNTIME_ROOT%ocr\\tessdata"',
  'set "XBERG_CACHE_DIR=%RUNTIME_ROOT%cache"',
  'set "HF_HUB_OFFLINE=1"',
  'set "HUGGINGFACE_HUB_OFFLINE=1"',
  'set "HF_HOME=%XBERG_CACHE_DIR%\\huggingface"',
  'set "HF_HUB_CACHE=%HF_HOME%\\hub"',
  'if not exist "%XBERG_CACHE_DIR%" mkdir "%XBERG_CACHE_DIR%"',
  '"%RUNTIME_ROOT%python\\python.exe" "%RUNTIME_ROOT%python\\worker.py" %*',
  'exit /b %ERRORLEVEL%',
  ''
].join('\r\n')

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function assertPinnedFile(path, expectedSha256) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`Missing downloaded asset: ${path}`)
  }
  const actual = sha256File(path)
  if (actual !== expectedSha256.toLowerCase()) {
    throw new Error(`SHA-256 mismatch for '${path}'. Expected ${expectedSha256}, received ${actual}.`)
  }
}

async function downloadPinnedFile(uri, destination, expectedSha256) {
  if (existsSync(destination) && statSync(destination).isFile()) {
    assertPinnedFile(destination, expectedSha256)
    return
  }
  mkdirSync(dirname(destination), { recursive: true })
  const partial = `${destination}.${randomUUID().replaceAll('-', '')}.part`
  try {
    const response = await fetch(uri, { redirect: 'follow' })
    if (!response.ok || response.body === null) {
      throw new Error(`Download failed for ${uri}: HTTP ${response.status}`)
    }
    writeFileSync(partial, Buffer.from(await response.arrayBuffer()))
    assertPinnedFile(partial, expectedSha256)
    renameSync(partial, destination)
  } finally {
    if (existsSync(partial)) rmSync(partial, { force: true })
  }
}

function readXbergLock(requirementsPath) {
  const normalized = readFileSync(requirementsPath, 'utf8').replace(/\\\s*/g, ' ')
  const match = /xberg==(?<version>[0-9]+\.[0-9]+\.[0-9]+)\s+--hash=sha256:(?<sha>[a-fA-F0-9]{64})/i.exec(normalized)
  if (match?.groups === undefined) {
    throw new Error(`Could not locate a hash-pinned xberg requirement in '${requirementsPath}'.`)
  }
  return { version: match.groups.version, sha256: match.groups.sha.toLowerCase() }
}

async function downloadPinnedXbergWheel(lock, downloadDirectory) {
  const wheelName = `xberg-${lock.version}-cp310-abi3-win_amd64.whl`
  const metadata = await (await fetch(`https://pypi.org/pypi/xberg/${lock.version}/json`)).json()
  const candidate = metadata.urls.find(entry => entry.filename === wheelName && entry.packagetype === 'bdist_wheel')
  if (candidate === undefined) {
    throw new Error(`PyPI did not publish expected Windows x64 wheel '${wheelName}'.`)
  }
  if (String(candidate.digests.sha256).toLowerCase() !== lock.sha256) {
    throw new Error(`PyPI metadata SHA-256 for '${wheelName}' does not match python/requirements/win32-x64.txt.`)
  }
  const destination = join(downloadDirectory, wheelName)
  await downloadPinnedFile(candidate.url, destination, lock.sha256)
  return destination
}

function writeUtf8(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, { encoding: 'utf8' }) // no BOM
}

/**
 * Minimal ZIP extractor for the two pinned archives handled here (CPython
 * embeddable package, Xberg wheel). Supports stored and deflated entries and
 * refuses absolute or traversing member names. Avoids a shell, PowerShell, or
 * third-party unzip dependency.
 */
function extractZip(zipPath, destinationDirectory) {
  const buffer = readFileSync(zipPath)
  // Locate the End of Central Directory record by scanning backwards.
  let eocd = -1
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 22 - 0xffff); index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      eocd = index
      break
    }
  }
  if (eocd < 0) throw new Error(`Not a ZIP archive: ${zipPath}`)
  const entryCount = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)

  const destinationRoot = resolve(destinationDirectory)
  mkdirSync(destinationRoot, { recursive: true })
  for (let entry = 0; entry < entryCount; entry += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`Corrupt central directory in ${zipPath}`)
    }
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localHeaderOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    offset += 46 + nameLength + extraLength + commentLength

    if (name.endsWith('/')) continue // directory entry
    const target = resolve(destinationRoot, name)
    if (target !== destinationRoot && !target.startsWith(destinationRoot + sep)) {
      throw new Error(`Unsafe ZIP member path: ${name}`)
    }

    if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`Corrupt local header for ${name} in ${zipPath}`)
    }
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28)
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize)
    const content = method === 0
      ? Buffer.from(compressed)
      : method === 8
        ? inflateRawSync(compressed)
        : (() => { throw new Error(`Unsupported ZIP compression method ${method} for ${name}`) })()
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
}

function relativeRuntimeFiles(runtimeDirectory) {
  const excluded = new Set([
    resolve(runtimeDirectory, 'manifest.json'),
    resolve(runtimeDirectory, 'sbom.spdx.json')
  ])
  const files = []
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = join(directory, entry.name)
      if (entry.isDirectory()) walk(fullPath)
      else if (entry.isFile() && !excluded.has(resolve(fullPath))) files.push(fullPath)
    }
  }
  walk(runtimeDirectory)
  files.sort()
  const prefix = resolve(runtimeDirectory) + sep
  return files.map(fullPath => ({
    path: fullPath.slice(prefix.length).split(sep).join('/'),
    size: statSync(fullPath).size,
    sha256: sha256File(fullPath)
  }))
}

function runEmbeddedSmoke(pythonExe, runtimeDirectory) {
  const smokePath = join(runtimeDirectory, '.build-smoke.py')
  writeUtf8(smokePath, SMOKE_SOURCE)

  const cacheRoot = join(runtimeDirectory, 'cache')
  const hfHome = join(cacheRoot, 'huggingface')
  try {
    mkdirSync(cacheRoot, { recursive: true })
    execFileSync(pythonExe, [smokePath], {
      stdio: 'inherit',
      env: {
        ...process.env,
        DSH_DOC_TESSDATA_PATH: join(runtimeDirectory, 'ocr', 'tessdata'),
        XBERG_CACHE_DIR: cacheRoot,
        HF_HUB_OFFLINE: '1',
        HUGGINGFACE_HUB_OFFLINE: '1',
        HF_HOME: hfHome,
        HF_HUB_CACHE: join(hfHome, 'hub')
      }
    })
  } catch (error) {
    throw new Error(`Embedded Python/Xberg smoke test failed: ${error.message}`)
  } finally {
    if (existsSync(smokePath)) rmSync(smokePath, { force: true })
  }
}

/**
 * Rename a freshly populated directory into place. Windows virus scanners and
 * indexers can briefly hold handles on new native binaries, so transient EPERM
 * failures are retried before giving up.
 */
function moveWithRetry(source, destination) {
  let lastError
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      renameSync(source, destination)
      return
    } catch (error) {
      lastError = error
      if (error?.code !== 'EPERM' && error?.code !== 'EBUSY') throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500 * (attempt + 1))
    }
  }
  throw lastError
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('This runtime builder only supports Windows x64.')
  }

  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const repoRoot = resolve(scriptDir, '..')
  const artifactRoot = resolve(repoRoot, '.dsh-runtime')
  const output = resolve(process.argv[2] ?? join(artifactRoot, 'runtime-win32-x64'))
  const artifactPrefix = artifactRoot + sep
  if (!output.startsWith(artifactPrefix)) {
    throw new Error(`Output directory must remain below the gitignored '${artifactRoot}' directory.`)
  }
  if (existsSync(output)) {
    throw new Error(`Refusing to overwrite existing runtime output '${output}'. Choose a new path or remove it explicitly.`)
  }

  const requirementsPath = join(repoRoot, 'python', 'requirements', 'win32-x64.txt')
  const workerSource = join(repoRoot, 'python', 'worker.py')
  if (!existsSync(requirementsPath) || !existsSync(workerSource)) {
    throw new Error('Expected runtime source files are missing.')
  }

  const lock = readXbergLock(requirementsPath)
  if (lock.version !== '1.0.14') {
    throw new Error(`This builder is reviewed for Xberg 1.0.14, received lock version ${lock.version}.`)
  }

  mkdirSync(artifactRoot, { recursive: true })
  const downloadDirectory = join(artifactRoot, 'downloads')
  const pythonArchive = join(downloadDirectory, PYTHON_ARCHIVE_NAME)
  await downloadPinnedFile(PYTHON_ARCHIVE_URI, pythonArchive, PYTHON_ARCHIVE_SHA256)
  const wheel = await downloadPinnedXbergWheel(lock, downloadDirectory)

  for (const asset of TESSDATA_ASSETS) {
    await downloadPinnedFile(asset.uri, join(downloadDirectory, asset.file), asset.sha256)
  }
  await downloadPinnedFile(TESSDATA_LICENSE.uri, join(downloadDirectory, TESSDATA_LICENSE.file), TESSDATA_LICENSE.sha256)

  const stage = join(artifactRoot, `.build-${randomUUID().replaceAll('-', '')}`)
  mkdirSync(stage, { recursive: true })

  try {
    const pythonRoot = join(stage, 'python')
    extractZip(pythonArchive, pythonRoot)
    const pythonExe = join(pythonRoot, 'python.exe')
    if (!existsSync(pythonExe)) {
      throw new Error('The CPython embeddable archive did not contain python.exe.')
    }

    const pthFiles = readdirSync(pythonRoot).filter(name => /^python[^/]*\._pth$/i.test(name))
    if (pthFiles.length !== 1) {
      throw new Error('Expected exactly one CPython embedded ._pth file.')
    }
    const pthBase = pthFiles[0].replace(/\._pth$/i, '').replaceAll('_', '')
    writeUtf8(join(pythonRoot, pthFiles[0]), `${pthBase}.zip\n.\nLib\\site-packages\nimport site\n`)

    const sitePackages = join(pythonRoot, 'Lib', 'site-packages')
    mkdirSync(sitePackages, { recursive: true })
    extractZip(wheel, sitePackages)

    const xbergMetadata = join(sitePackages, `xberg-${lock.version}.dist-info`, 'METADATA')
    if (!existsSync(xbergMetadata)) {
      throw new Error('Xberg wheel metadata was not found after extraction.')
    }
    if (/^Requires-Dist:/m.test(readFileSync(xbergMetadata, 'utf8'))) {
      throw new Error('The pinned Xberg wheel unexpectedly has third-party Python dependencies.')
    }

    copyFileSync(workerSource, join(pythonRoot, 'worker.py'))
    copyFileSync(requirementsPath, join(pythonRoot, 'requirements-win32-x64.txt'))

    const tessdataDirectory = join(stage, 'ocr', 'tessdata')
    mkdirSync(tessdataDirectory, { recursive: true })
    for (const asset of TESSDATA_ASSETS) {
      copyFileSync(join(downloadDirectory, asset.file), join(tessdataDirectory, asset.file))
    }

    const licenseDirectory = join(stage, 'licenses')
    mkdirSync(licenseDirectory, { recursive: true })
    copyFileSync(join(pythonRoot, 'LICENSE.txt'), join(licenseDirectory, 'Python-PSF-2.0.txt'))
    copyFileSync(
      join(sitePackages, `xberg-${lock.version}.dist-info`, 'licenses', 'LICENSE'),
      join(licenseDirectory, 'xberg-MIT.txt')
    )
    copyFileSync(join(downloadDirectory, TESSDATA_LICENSE.file), join(licenseDirectory, TESSDATA_LICENSE.file))

    // The wheel carries a much more detailed native/Rust component inventory
    // than Python's Requires-Dist metadata can express. Keep that upstream
    // CycloneDX document beside our top-level SPDX/file inventory for release
    // review instead of incorrectly presenting the latter as a full dependency
    // graph.
    const xbergCycloneDx = join(sitePackages, `xberg-${lock.version}.dist-info`, 'sboms', 'xberg-py.cyclonedx.json')
    if (!existsSync(xbergCycloneDx)) {
      throw new Error('The pinned Xberg wheel did not contain its CycloneDX component inventory.')
    }
    const vendorSbomDirectory = join(stage, 'sbom')
    mkdirSync(vendorSbomDirectory, { recursive: true })
    copyFileSync(xbergCycloneDx, join(vendorSbomDirectory, 'xberg-py.cyclonedx.json'))

    writeUtf8(join(stage, 'run-worker.cmd'), LAUNCHER_SOURCE)

    runEmbeddedSmoke(pythonExe, stage)
    const smokeCache = join(stage, 'cache')
    if (existsSync(smokeCache)) rmSync(smokeCache, { recursive: true, force: true })

    const noticeLines = [
      'DSH document runtime third-party notices',
      '=========================================',
      '',
      `CPython ${PYTHON_VERSION} (PSF-2.0)`,
      `  Source: ${PYTHON_ARCHIVE_URI}`,
      `  SHA-256: ${PYTHON_ARCHIVE_SHA256}`,
      '  Full text: licenses/Python-PSF-2.0.txt',
      '',
      `Xberg ${lock.version} (MIT)`,
      `  Source: PyPI wheel ${basename(wheel)}`,
      `  SHA-256: ${lock.sha256}`,
      '  Full text: licenses/xberg-MIT.txt',
      '  Component inventory: sbom/xberg-py.cyclonedx.json',
      '',
      `tessdata_fast language data at commit ${TESSDATA_COMMIT} (Apache-2.0)`,
      `  Source: ${TESSDATA_BASE_URI}`,
      `  Full text: licenses/${TESSDATA_LICENSE.file}`,
      ...TESSDATA_ASSETS.map(asset => `  ${asset.file}: ${asset.sha256}`),
      '',
      'This artifact is offline by default. Do not enable model downloads or replace',
      'these assets without updating their version, source URI, SHA-256, license',
      'records, and validation evidence.'
    ]
    writeUtf8(join(stage, 'NOTICE'), noticeLines.join('\r\n'))

    const files = relativeRuntimeFiles(stage)
    const created = new Date().toISOString()
    const components = [
      {
        name: 'CPython embeddable package',
        version: PYTHON_VERSION,
        license: 'PSF-2.0',
        downloadLocation: PYTHON_ARCHIVE_URI,
        sha256: PYTHON_ARCHIVE_SHA256
      },
      {
        name: 'xberg',
        version: lock.version,
        license: 'MIT',
        downloadLocation: `https://pypi.org/project/xberg/${lock.version}/`,
        sha256: lock.sha256
      },
      ...TESSDATA_ASSETS.map(asset => ({
        name: asset.file,
        version: TESSDATA_COMMIT,
        license: asset.license,
        downloadLocation: asset.uri,
        sha256: asset.sha256
      }))
    ]

    const manifest = {
      schemaVersion: 1,
      artifact: 'dshdoc-runtime-win32-x64',
      platform: 'win32-x64',
      createdUtc: created,
      offlineDefaults: {
        DSH_DOC_TESSDATA_PATH: 'ocr/tessdata',
        XBERG_CACHE_DIR: 'cache',
        HF_HUB_OFFLINE: '1',
        HUGGINGFACE_HUB_OFFLINE: '1'
      },
      components,
      thirdPartyComponentInventory: 'sbom/xberg-py.cyclonedx.json',
      files
    }
    writeUtf8(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2))

    const spdxIdSafe = value => value.replace(/[^A-Za-z0-9.-]/g, '-')
    const spdx = {
      SPDXID: 'SPDXRef-DOCUMENT',
      spdxVersion: 'SPDX-2.3',
      name: 'dshdoc-runtime-win32-x64',
      dataLicense: 'CC0-1.0',
      documentComment: 'This SPDX document inventories the runtime artifact files and top-level source components. The Xberg wheel vendor component inventory is copied separately at sbom/xberg-py.cyclonedx.json and must be reviewed with this document.',
      creationInfo: {
        created,
        creators: ['Tool: scripts/build-runtime-win32-x64.mjs']
      },
      packages: components.map(component => ({
        SPDXID: `SPDXRef-${spdxIdSafe(component.name)}`,
        name: component.name,
        versionInfo: component.version,
        downloadLocation: component.downloadLocation,
        licenseConcluded: component.license,
        licenseDeclared: component.license,
        checksums: [{ algorithm: 'SHA256', checksumValue: component.sha256 }]
      })),
      files: files.map(file => ({
        SPDXID: `SPDXRef-File-${spdxIdSafe(file.path)}`,
        fileName: file.path,
        checksums: [{ algorithm: 'SHA256', checksumValue: file.sha256 }]
      }))
    }
    writeUtf8(join(stage, 'sbom.spdx.json'), JSON.stringify(spdx, null, 2))

    moveWithRetry(stage, output)
    console.log(`Built offline Windows x64 runtime: ${output}`)
    console.log(`Manifest: ${join(output, 'manifest.json')}`)
  } catch (error) {
    console.error(`Runtime build failed. Preserved staging directory for audit: ${stage}`)
    throw error
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
