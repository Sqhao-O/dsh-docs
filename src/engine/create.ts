import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ResolvedConfig } from '../config.js'
import { documentEngineError } from './errors.js'
import { PythonStdioClient } from './python-stdio-client.js'
import type { DocumentEngine } from './types.js'
import { XbergNodeClient } from './xberg-node-client.js'

export interface CreateDocumentEngineOptions {
  readonly log?: (message: string, details?: Readonly<Record<string, unknown>>) => void
}

function firstExisting(paths: readonly string[]): string | undefined {
  return paths.find(path => existsSync(path))
}

function packageWorkerPath(): string {
  // This resolves to `<package>/python/worker.py` from either `src/engine` in
  // development or `lib/engine` after publishing.
  return fileURLToPath(new URL('../../python/worker.py', import.meta.url))
}

function embeddedPythonPath(runtimeDir: string | undefined): string | undefined {
  if (runtimeDir === undefined) return undefined
  return firstExisting([
    join(runtimeDir, 'python', 'python.exe'),
    join(runtimeDir, 'python', 'bin', 'python3'),
    join(runtimeDir, 'python', 'bin', 'python')
  ])
}

function bundledTessdataPath(config: ResolvedConfig): string | undefined {
  if (config.tessdataPath !== undefined) return config.tessdataPath
  if (config.runtimeDir === undefined) return undefined
  const candidate = join(config.runtimeDir, 'ocr', 'tessdata')
  return existsSync(candidate) ? candidate : undefined
}

function createNodeEngine(config: ResolvedConfig, options: CreateDocumentEngineOptions): DocumentEngine {
  const tessdataPath = bundledTessdataPath(config)
  return new XbergNodeClient({
    timeoutMs: config.timeoutMs,
    maxOutputChars: config.maxOutputChars,
    ...(config.ocrLanguages === undefined ? {} : { ocrLanguages: config.ocrLanguages }),
    ocrBackend: config.ocrBackend,
    ...(tessdataPath === undefined ? {} : { tessdataPath }),
    ...(options.log === undefined ? {} : { debug: options.log })
  })
}

function createPythonEngine(
  config: ResolvedConfig,
  pythonCommand: string | undefined,
  options: CreateDocumentEngineOptions
): DocumentEngine {
  if (pythonCommand === undefined) throw documentEngineError('ENGINE_RUNTIME_INVALID')
  const workerPath = config.pythonWorkerPath
    ?? firstExisting(config.runtimeDir === undefined ? [] : [join(config.runtimeDir, 'python', 'worker.py')])
    ?? packageWorkerPath()
  if (!existsSync(workerPath)) throw documentEngineError('ENGINE_RUNTIME_INVALID')
  const tessdataPath = bundledTessdataPath(config)
  const runtimeCache = config.runtimeDir === undefined
    ? join(dirname(workerPath), '.xberg-cache')
    : join(config.runtimeDir, 'cache')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DSH_DOC_WORKER_MAX_INPUT_BYTES: String(config.maxFileBytes),
    DSH_DOC_WORKER_MAX_TIMEOUT_MS: String(config.timeoutMs),
    DSH_DOC_WORKER_MAX_OUTPUT_CHARS: String(config.maxOutputChars),
    XBERG_CACHE_DIR: runtimeCache,
    HF_HUB_OFFLINE: '1',
    HUGGINGFACE_HUB_OFFLINE: '1',
    ...(tessdataPath === undefined ? {} : {
      DSH_DOC_TESSDATA_PATH: tessdataPath,
      TESSDATA_PREFIX: tessdataPath
    })
  }
  options.log?.('Using the local embedded Python document engine.', {
    runtime: config.runtimeDir ?? 'custom-python-command',
    offlineModels: tessdataPath !== undefined
  })
  return new PythonStdioClient({
    pythonCommand,
    pythonArgs: ['-I', '-s'],
    workerPath,
    timeoutMs: config.timeoutMs,
    maxOutputChars: config.maxOutputChars,
    ...(config.ocrLanguages === undefined ? {} : { ocrLanguages: config.ocrLanguages }),
    ocrBackend: config.ocrBackend,
    env
  })
}

/**
 * Select the packaged Python runtime when it is explicitly configured or
 * present; otherwise use the local Xberg N-API binding. Neither path requires
 * Docling Serve, Docker, a local HTTP port, or a remote converter.
 */
export function createDocumentEngine(config: ResolvedConfig, options: CreateDocumentEngineOptions = {}): DocumentEngine {
  const pythonCommand = config.pythonCommand ?? embeddedPythonPath(config.runtimeDir)
  if (config.engine === 'python') return createPythonEngine(config, pythonCommand, options)
  if (config.engine === 'auto' && pythonCommand !== undefined) return createPythonEngine(config, pythonCommand, options)
  return createNodeEngine(config, options)
}
