export type OutputFormat = 'md' | 'text' | 'json'
export type TableMode = 'fast' | 'accurate'
export type SourceKind = 'file' | 'url'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
export interface JsonObject {
  readonly [key: string]: JsonValue
}

export interface ConvertOptions {
  readonly outputFormat: OutputFormat
  readonly ocr: boolean
  readonly tableMode: TableMode
  readonly pageRange?: readonly [number, number]
}

export interface LocalFile {
  readonly path: string
  readonly name: string
  readonly size: number
  readonly mediaType: string
  /** Immutable bytes authorized by the local-path sandbox, when available. */
  readonly blob?: Blob
}

export interface ConvertFileInput {
  readonly file: LocalFile
  readonly options: ConvertOptions
  readonly signal?: AbortSignal
}

export interface ConvertUrlInput {
  readonly url: string
  readonly options: ConvertOptions
  readonly signal?: AbortSignal
}

export interface HealthResult {
  readonly status: string
  readonly baseUrl: string
  readonly latencyMs: number
}

export interface ConversionResult {
  readonly source: {
    readonly kind: SourceKind
    readonly name?: string
    readonly url?: string
  }
  readonly format: string
  readonly markdown?: string
  readonly text?: string
  readonly json?: JsonValue
  readonly metadata: {
    readonly title?: string
    readonly pages?: number
    readonly detectedFormat?: string
  }
  readonly stats: {
    /** Characters before dsh-docling's output limit is applied. */
    readonly outputChars: number
    /** Characters retained for model-facing output. */
    readonly returnedChars: number
    readonly truncated: boolean
    readonly elapsedMs: number
  }
}

export interface DoclingClient {
  health(signal?: AbortSignal): Promise<HealthResult>
  convertFile(input: ConvertFileInput): Promise<ConversionResult>
  convertUrl(input: ConvertUrlInput): Promise<ConversionResult>
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value !== 'object') return false
  return Object.values(value).every(isJsonValue)
}
