#!/usr/bin/env node
/**
 * Downloads the prebuilt, offline-by-default Windows x64 CPython/Xberg runtime
 * from this repository's GitHub Release instead of building it locally.
 *
 * The archive SHA-256 is pinned in this script; updating the release asset
 * requires a source change here. After extraction the script runs the manifest
 * verifier, so corrupted or substituted payloads fail closed.
 *
 * Runs on any shell (cmd, PowerShell, pwsh, Git Bash) with the Node.js version
 * already required by this package. Usage:
 *
 *   node scripts/fetch-runtime-win32-x64.mjs [output-directory]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { downloadPinnedFile, extractZip, moveWithRetry } from './lib/runtime-common.mjs'

// Pinned release asset. Bump the tag and hash together after a reviewed
// runtime rebuild; never point this at a mutable release asset.
const RELEASE_TAG = 'runtime-win32-x64-v1.0.14'
const ARCHIVE_NAME = 'dshdoc-runtime-win32-x64.zip'
const ARCHIVE_URI = `https://github.com/Sqhao-O/dsh-docs/releases/download/${RELEASE_TAG}/${ARCHIVE_NAME}`
const ARCHIVE_SHA256 = '1c94381c9b5f3cd366357adaa5ad17b1e0757db2c86c1dc4e394e5ea7720f0c5'

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('This prebuilt runtime only supports Windows x64. Use engine: node on other platforms.')
  }

  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const packageRoot = resolve(scriptDir, '..')
  const artifactRoot = resolve(packageRoot, '.dsh-runtime')
  // An explicit argument may point anywhere (for example a stable directory
  // outside node_modules when the plugin was installed from the npm registry);
  // the default stays inside the package's gitignored .dsh-runtime directory.
  const output = resolve(process.argv[2] ?? join(artifactRoot, 'runtime-win32-x64'))
  if (existsSync(output)) {
    throw new Error(`Refusing to overwrite existing runtime output '${output}'. Choose a new path or remove it explicitly.`)
  }

  mkdirSync(artifactRoot, { recursive: true })
  const archive = join(artifactRoot, 'downloads', ARCHIVE_NAME)
  await downloadPinnedFile(ARCHIVE_URI, archive, ARCHIVE_SHA256)

  const stageParent = dirname(output)
  mkdirSync(stageParent, { recursive: true })
  const stage = join(stageParent, `.fetch-${Date.now().toString(36)}`)
  try {
    extractZip(archive, stage)
    moveWithRetry(stage, output)
  } catch (error) {
    console.error(`Runtime fetch failed. Preserved staging directory for audit: ${stage}`)
    throw error
  }

  // Verify every extracted payload hash against the bundled manifest.
  execFileSync(process.execPath, [join(scriptDir, 'verify-runtime-win32-x64.mjs'), output], { stdio: 'inherit' })
  console.log(`Fetched prebuilt offline Windows x64 runtime: ${output}`)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
