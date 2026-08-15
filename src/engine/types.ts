/** Engine-neutral document conversion contract. */

export type OutputFormat = 'md' | 'text' | 'json'
export type TableMode = 'fast' | 'accurate'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
export interface JsonObject {
  readonly [key: string]: JsonValue
}

export interface ConvertOptions {
  readonly outputFormat: OutputFormat
  readonly ocr: boolean
  readonly tableMode: TableMode
  /** Per-request OCR language override. Falls back to the engine's configured set. */
  readonly ocrLanguages?: readonly string[]
  readonly pageRange?: readonly [number, number]
}

/**
 * A byte snapshot authorized by the caller. Engine implementations must parse
 * these bytes, rather than reopening `path` or fetching a source URL.
 */
export interface DocumentSnapshot {
  /** Display name / extension used for format detection. It is not a path. */
  readonly name: string
  readonly mediaType: string
  readonly size: number
  readonly bytes: Uint8Array
}

/**
 * Sandbox resolution metadata retained by the tool layer. The engine must use
 * `bytes`; `path` exists only for diagnostics and is never forwarded to a
 * parser process or native extractor.
 */
export interface LocalFile extends DocumentSnapshot {
  readonly path: string
}

export interface LocalFileSource {
  readonly kind: 'file'
  readonly name: string
}

/**
 * The engine boundary is intentionally local-file-only. A caller that accepts
 * a URL must first download it through its own SSRF-safe policy and construct a
 * byte snapshot; it may then rewrite result attribution outside this contract.
 */
export interface ConvertFileInput {
  readonly file: DocumentSnapshot
  readonly options: ConvertOptions
  readonly signal?: AbortSignal
}

export interface HealthResult {
  readonly status: string
  /** A stable implementation id, for example `xberg-python` or `xberg-node`. */
  readonly engine?: string
  readonly runtimeVersion?: string
  /** Whether every configured local OCR language pack is available offline. */
  readonly ocrAvailable?: boolean
  /** Locally discovered OCR language identifiers, never a filesystem path. */
  readonly ocrLanguages?: string[]
  readonly latencyMs: number
}

export interface ConversionMetadata {
  readonly title?: string
  readonly pages?: number
  readonly detectedFormat?: string
}

export interface ConversionStats {
  /** Characters before an output boundary applies a size limit. */
  readonly outputChars: number
  /** Characters retained for the caller. */
  readonly returnedChars: number
  readonly truncated: boolean
  readonly elapsedMs: number
}

export interface ConversionResult {
  readonly source: LocalFileSource
  readonly format: string
  readonly markdown?: string
  readonly text?: string
  readonly json?: JsonValue
  readonly metadata: ConversionMetadata
  readonly stats: ConversionStats
}

/**
 * An implementation can be a native Node binding, a Python worker, or another
 * local backend. It receives only caller-authorized document bytes.
 */
export interface DocumentEngine {
  health(signal?: AbortSignal): Promise<HealthResult>
  convertFile(input: ConvertFileInput): Promise<ConversionResult>
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value !== 'object') return false
  return Object.values(value).every(isJsonValue)
}
