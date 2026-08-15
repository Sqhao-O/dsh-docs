#!/usr/bin/env node
/**
 * Verifies every payload hash recorded in a dsh-doc Windows runtime manifest.
 *
 * The runtime is a separately distributed binary artifact. Run this before
 * configuring `runtimeDir`, after copying it between machines, or in release CI.
 * It performs only local reads and fails on missing, changed, or unexpected files.
 *
 * Runs on any shell (cmd, PowerShell, pwsh, Git Bash). Usage:
 *
 *   node scripts/verify-runtime-win32-x64.mjs [runtime-directory]
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const runtime = resolve(process.argv[2] ?? join(scriptDir, '..', '.dsh-runtime', 'runtime-win32-x64'))
  const manifestPath = join(runtime, 'manifest.json')
  if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) {
    throw new Error(`Runtime manifest was not found: ${manifestPath}`)
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.schemaVersion !== 1 || manifest.artifact !== 'dshdoc-runtime-win32-x64') {
    throw new Error('Unsupported runtime manifest.')
  }

  const expected = new Map()
  for (const entry of manifest.files) {
    if (!/^[A-Za-z0-9._/-]+$/.test(entry.path) || entry.path.includes('..')) {
      throw new Error(`Unsafe manifest path: ${entry.path}`)
    }
    expected.set(entry.path, String(entry.sha256).toLowerCase())
    const path = join(runtime, ...entry.path.split('/'))
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new Error(`Missing runtime payload: ${entry.path}`)
    }
    if (sha256File(path) !== expected.get(entry.path)) {
      throw new Error(`Runtime payload hash mismatch: ${entry.path}`)
    }
  }

  const excluded = new Set([resolve(manifestPath), resolve(runtime, 'sbom.spdx.json')])
  const actualPaths = []
  const walk = directory => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = join(directory, item.name)
      if (item.isDirectory()) walk(fullPath)
      else if (item.isFile() && !excluded.has(resolve(fullPath))) actualPaths.push(fullPath)
    }
  }
  walk(runtime)
  const prefix = resolve(runtime) + sep
  const unexpected = actualPaths
    .map(fullPath => fullPath.slice(prefix.length).split(sep).join('/'))
    .filter(relative => !expected.has(relative))
  if (unexpected.length > 0) {
    throw new Error(`Unexpected runtime payload(s): ${unexpected.join(', ')}`)
  }

  console.log(`Verified runtime payload hashes: ${expected.size} files`)
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
