import { isAbsolute, parse, resolve } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import type { OutputFormat, TableMode } from './docling/types.js'

export const DEFAULT_BASE_URL = 'http://127.0.0.1:5001'
export const DEFAULT_TIMEOUT_MS = 120_000
export const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024
export const DEFAULT_MAX_OUTPUT_CHARS = 32_000

export interface Config {
  baseUrl: string
  apiKey?: string
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
}

/** Schemastery schema consumed by the Cordis plugin loader. */
export const Config: Schema<Config> = Schema.object({
  baseUrl: Schema.string().min(1).default(DEFAULT_BASE_URL),
  // Schemastery fields are optional unless marked .required().
  apiKey: Schema.string().min(1),
  timeoutMs: Schema.number().step(1).min(1_000).max(600_000).default(DEFAULT_TIMEOUT_MS),
  maxFileBytes: Schema.number().step(1).min(1).max(1024 * 1024 * 1024).default(DEFAULT_MAX_FILE_BYTES),
  enableLocalFiles: Schema.boolean().default(true),
  enableRemoteUrls: Schema.boolean().default(true),
  allowedLocalRoots: Schema.array(Schema.string().min(1)).default([]),
  allowPrivateUrls: Schema.boolean().default(false),
  defaultOcr: Schema.boolean().default(true),
  defaultTableMode: Schema.union(['fast', 'accurate']).default('accurate'),
  defaultOutputFormat: Schema.union(['md', 'text', 'json']).default('md'),
  maxOutputChars: Schema.number().step(1).min(256).max(2_000_000).default(DEFAULT_MAX_OUTPUT_CHARS),
  debug: Schema.boolean().default(false)
})

export interface ResolvedConfig extends Readonly<Config> {
  readonly baseUrl: string
}

function isFilesystemRoot(path: string): boolean {
  const normalized = resolve(path)
  return parse(normalized).root === normalized
}

/** Validate semantic constraints that cannot be expressed with Schemastery alone. */
export function resolveConfig(config: Config): ResolvedConfig {
  let baseUrl: URL
  try {
    baseUrl = new URL(config.baseUrl)
  } catch {
    throw new TypeError('baseUrl must be an absolute http or https URL')
  }
  if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
    throw new TypeError('baseUrl must use http or https')
  }
  if (baseUrl.username !== '' || baseUrl.password !== '') {
    throw new TypeError('baseUrl must not contain credentials; use apiKey instead')
  }
  if (baseUrl.search !== '' || baseUrl.hash !== '') {
    throw new TypeError('baseUrl must not contain a query string or fragment')
  }
  for (const root of config.allowedLocalRoots) {
    if (!isAbsolute(root) || isFilesystemRoot(root)) {
      throw new TypeError('allowedLocalRoots entries must be absolute non-filesystem-root directories')
    }
  }
  return {
    ...config,
    baseUrl: baseUrl.toString().replace(/\/$/, '')
  }
}
