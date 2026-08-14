import { isAbsolute, parse, resolve } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import type { OutputFormat, TableMode } from './engine/types.js'

export const DEFAULT_TIMEOUT_MS = 120_000
export const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024
export const DEFAULT_MAX_OUTPUT_CHARS = 32_000
export const DEFAULT_ENGINE = 'auto' as const

export interface Config {
  /** Prefer the bundled Python worker when installed, otherwise use Xberg N-API. */
  engine: 'auto' | 'node' | 'python'
  /** Optional absolute directory containing an embedded Python runtime and models. */
  runtimeDir?: string
  /** Optional trusted Python executable. Used only for engine=python or auto fallback. */
  pythonCommand?: string
  /** Optional trusted worker script path. Defaults to the worker shipped with this plugin. */
  pythonWorkerPath?: string
  /** Optional absolute directory of bundled Tesseract language packs. */
  tessdataPath?: string
  /** Select the local OCR implementation exposed by Xberg. */
  /** Only the pinned local Tesseract backend is exposed in this release. */
  ocrBackend: 'auto' | 'tesseract'
  /** Ordered local OCR languages; runtime packs decide which language data is installed. */
  ocrLanguages: string[]
  timeoutMs: number
  maxFileBytes: number
  enableLocalFiles: boolean
  enableRemoteUrls: boolean
  allowedLocalRoots: string[]
  /** Explicit opt-in for private URL targets. This weakens the SSRF guard. */
  allowPrivateUrls: boolean
  defaultOcr: boolean
  defaultTableMode: TableMode
  defaultOutputFormat: OutputFormat
  maxOutputChars: number
  debug: boolean
  /** Legacy ignored fields accepted for a smooth upgrade from Docling-based profiles. */
  baseUrl?: string
  apiKey?: string
}

/** Schemastery schema consumed by the Cordis plugin loader. */
export const Config: Schema<Config> = Schema.object({
  engine: Schema.union(['auto', 'node', 'python']).default(DEFAULT_ENGINE),
  runtimeDir: Schema.string().min(1),
  pythonCommand: Schema.string().min(1),
  pythonWorkerPath: Schema.string().min(1),
  tessdataPath: Schema.string().min(1),
  ocrBackend: Schema.union(['auto', 'tesseract']).default('auto'),
  ocrLanguages: Schema.array(Schema.string().min(1)).default(['eng']),
  timeoutMs: Schema.number().step(1).min(1_000).max(600_000).default(DEFAULT_TIMEOUT_MS),
  maxFileBytes: Schema.number().step(1).min(1).max(1024 * 1024 * 1024).default(DEFAULT_MAX_FILE_BYTES),
  enableLocalFiles: Schema.boolean().default(true),
  enableRemoteUrls: Schema.boolean().default(false),
  allowedLocalRoots: Schema.array(Schema.string().min(1)).default([]),
  allowPrivateUrls: Schema.boolean().default(false),
  // OCR needs explicitly bundled tessdata. Keep generic Node-only installs
  // offline and deterministic until a managed runtime is configured.
  defaultOcr: Schema.boolean().default(false),
  defaultTableMode: Schema.union(['fast', 'accurate']).default('accurate'),
  defaultOutputFormat: Schema.union(['md', 'text', 'json']).default('md'),
  maxOutputChars: Schema.number().step(1).min(256).max(2_000_000).default(DEFAULT_MAX_OUTPUT_CHARS),
  debug: Schema.boolean().default(false),
  baseUrl: Schema.string().min(1),
  apiKey: Schema.string().min(1)
})

export type ResolvedConfig = Readonly<Config>

function isFilesystemRoot(path: string): boolean {
  const normalized = resolve(path)
  return parse(normalized).root === normalized
}

function isNetworkDeviceOrUriPath(path: string): boolean {
  return /^(?:\\\\|\/\/|[A-Za-z][A-Za-z0-9+.-]*:\/\/)/.test(path)
}

function checkOptionalDirectory(path: string | undefined, name: string): void {
  if (path === undefined) return
  if (!isAbsolute(path) || isFilesystemRoot(path) || isNetworkDeviceOrUriPath(path)) {
    throw new TypeError(`${name} must be an absolute non-filesystem-root directory`)
  }
}

/** Validate semantic constraints that cannot be expressed with Schemastery alone. */
export function resolveConfig(config: Config): ResolvedConfig {
  checkOptionalDirectory(config.runtimeDir, 'runtimeDir')
  checkOptionalDirectory(config.tessdataPath, 'tessdataPath')
  if (config.pythonWorkerPath !== undefined
    && (!isAbsolute(config.pythonWorkerPath) || isNetworkDeviceOrUriPath(config.pythonWorkerPath))) {
    throw new TypeError('pythonWorkerPath must be an absolute path')
  }
  if (config.ocrLanguages.length === 0
    || config.ocrLanguages.some(language => !/^[A-Za-z0-9_+-]+$/.test(language))) {
    throw new TypeError('ocrLanguages must contain one or more safe local language identifiers')
  }
  for (const root of config.allowedLocalRoots) {
    if (!isAbsolute(root) || isFilesystemRoot(root) || isNetworkDeviceOrUriPath(root)) {
      throw new TypeError('allowedLocalRoots entries must be absolute non-filesystem-root directories')
    }
  }
  return { ...config }
}
