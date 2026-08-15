import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Config, ResolvedConfig } from '../../src/config.js'
import { createDocumentEngine } from '../../src/engine/create.js'
import { PythonStdioClient } from '../../src/engine/python-stdio-client.js'
import { XbergNodeClient } from '../../src/engine/xberg-node-client.js'

const directories: string[] = []

function config(overrides: Partial<Config> = {}): ResolvedConfig {
  const base: Config = {
    engine: 'auto',
    ocrBackend: 'auto',
    ocrLanguages: ['eng'],
    timeoutMs: 60_000,
    maxFileBytes: 50 * 1024 * 1024,
    enableLocalFiles: true,
    enableRemoteUrls: false,
    allowedLocalRoots: [],
    allowWorkspaceFiles: true,
    allowPrivateUrls: false,
    defaultOcr: true,
    defaultTableMode: 'accurate',
    defaultOutputFormat: 'md',
    maxOutputChars: 32_000,
    debug: false
  }
  return Object.assign({}, base, overrides) as ResolvedConfig
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('document engine factory', () => {
  it('uses the native Xberg binding by default or when explicitly selected', () => {
    expect(createDocumentEngine(config())).toBeInstanceOf(XbergNodeClient)
    expect(createDocumentEngine(config({ engine: 'node' }))).toBeInstanceOf(XbergNodeClient)
  })

  it('uses an explicitly configured trusted Python worker and rejects an absent Python runtime', () => {
    const workerPath = join(process.cwd(), 'python', 'worker.py')
    const log = vi.fn()
    const python = createDocumentEngine(config({ engine: 'python', pythonCommand: 'python', pythonWorkerPath: workerPath }), { log })
    expect(python).toBeInstanceOf(PythonStdioClient)
    expect(log).toHaveBeenCalledWith('Using the local embedded Python document engine.', expect.objectContaining({ offlineModels: false }))
    expect(() => createDocumentEngine(config({ engine: 'python' }))).toThrow('runtime')
  })

  it('discovers a packaged embedded runtime and its bundled OCR directory without using PATH', async () => {
    const runtime = await mkdtemp(join(tmpdir(), 'dsh-doc-runtime-'))
    directories.push(runtime)
    await mkdir(join(runtime, 'python'), { recursive: true })
    await mkdir(join(runtime, 'ocr', 'tessdata'), { recursive: true })
    await writeFile(join(runtime, 'python', 'python.exe'), '')
    await writeFile(join(runtime, 'python', 'worker.py'), '')
    await writeFile(join(runtime, 'ocr', 'tessdata', 'eng.traineddata'), '')
    const log = vi.fn()
    const engine = createDocumentEngine(config({ runtimeDir: runtime }), { log })
    expect(engine).toBeInstanceOf(PythonStdioClient)
    expect(log).toHaveBeenCalledWith('Using the local embedded Python document engine.', expect.objectContaining({ runtime, offlineModels: true }))
  })
})
