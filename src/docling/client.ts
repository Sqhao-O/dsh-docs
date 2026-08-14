import { openAsBlob } from 'node:fs'
import type { ResolvedConfig } from '../config.js'
import { limitText } from '../output/limiter.js'
import { DoclingError } from './errors.js'
import { normalizeConversionResponse } from './normalize.js'
import type {
  ConversionResult,
  ConvertFileInput,
  ConvertUrlInput,
  DoclingClient,
  HealthResult,
  JsonValue
} from './types.js'

type FetchImplementation = typeof fetch

export interface DoclingHttpClientOptions extends Pick<ResolvedConfig, 'apiKey' | 'baseUrl' | 'debug' | 'maxOutputChars' | 'timeoutMs'> {
  readonly fetchImplementation?: FetchImplementation
  readonly log?: (message: string, details?: Readonly<Record<string, unknown>>) => void
}

function safeDebug(
  options: DoclingHttpClientOptions,
  message: string,
  details?: Readonly<Record<string, unknown>>
): void {
  if (options.debug) options.log?.(message, details)
}

function appendOptions(form: FormData, options: ConvertFileInput['options']): void {
  form.append('to_formats', options.outputFormat)
  form.append('ocr', String(options.ocr))
  form.append('table_mode', options.tableMode)
  if (options.pageRange !== undefined) {
    form.append('page_range', String(options.pageRange[0]))
    form.append('page_range', String(options.pageRange[1]))
  }
}

function responseError(status: number): DoclingError {
  if (status === 401 || status === 403) return new DoclingError('DOCLING_AUTH_FAILED', 'Docling authentication failed.', status)
  if (status === 400 || status === 404 || status === 413 || status === 422) {
    return new DoclingError('DOCLING_BAD_REQUEST', 'Docling rejected the conversion request.', status)
  }
  if (status === 408 || status === 504) return new DoclingError('DOCLING_TIMEOUT', 'Docling conversion timed out.', status)
  if (status === 502 || status === 503) return new DoclingError('DOCLING_UNAVAILABLE', 'Docling Serve is unavailable.', status)
  return new DoclingError('DOCLING_CONVERSION_FAILED', `Docling conversion failed (HTTP ${status}).`, status)
}

function bounded(result: ConversionResult, maxOutputChars: number): ConversionResult {
  const content = result.markdown ?? result.text ?? JSON.stringify(result.json)
  const limited = limitText(content, maxOutputChars)
  if (!limited.truncated) return result
  if (result.markdown !== undefined) {
    return {
      ...result,
      markdown: limited.text,
      stats: { ...result.stats, outputChars: limited.originalChars, returnedChars: limited.returnedChars, truncated: true }
    }
  }
  if (result.text !== undefined) {
    return {
      ...result,
      text: limited.text,
      stats: { ...result.stats, outputChars: limited.originalChars, returnedChars: limited.returnedChars, truncated: true }
    }
  }
  // A partial JSON string is not valid canonical JSON. Keep a bounded preview as
  // text while preserving the requested `format: json` and clear the full object.
  const { json, ...withoutJson } = result
  void json
  return {
    ...withoutJson,
    text: limited.text,
    stats: { ...result.stats, outputChars: limited.originalChars, returnedChars: limited.returnedChars, truncated: true }
  }
}

/** HTTP implementation for the stable synchronous Docling Serve v1 endpoints. */
export class DoclingHttpClient implements DoclingClient {
  private readonly fetchImplementation: FetchImplementation

  constructor(private readonly options: DoclingHttpClientOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch
  }

  async health(signal?: AbortSignal): Promise<HealthResult> {
    const startedAt = performance.now()
    const response = await this.request('/health', { method: 'GET', ...withSignal(signal) })
    const raw = await this.readJson(response)
    const rawStatus = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).status
      : undefined
    const status = typeof rawStatus === 'string'
      ? rawStatus
      : 'ok'
    return { status, baseUrl: this.options.baseUrl, latencyMs: Math.max(0, Math.round(performance.now() - startedAt)) }
  }

  async convertFile(input: ConvertFileInput): Promise<ConversionResult> {
    const startedAt = performance.now()
    const form = new FormData()
    appendOptions(form, input.options)
    // Node's file-backed Blob streams multipart bytes from disk without first
    // copying an entire document into a JavaScript Buffer.
    const blob = await openAsBlob(input.file.path, { type: input.file.mediaType })
    form.append('files', blob, input.file.name)
    const response = await this.request('/v1/convert/file', {
      method: 'POST', body: form, ...withSignal(input.signal)
    })
    const raw = await this.readJson(response)
    const normalized = normalizeConversionResponse({
      raw,
      kind: 'file',
      name: input.file.name,
      outputFormat: input.options.outputFormat,
      elapsedMs: performance.now() - startedAt
    })
    return bounded(normalized, this.options.maxOutputChars)
  }

  async convertUrl(input: ConvertUrlInput): Promise<ConversionResult> {
    const startedAt = performance.now()
    const body = JSON.stringify({
      options: toSourceOptions(input.options),
      sources: [{ kind: 'http', url: input.url }]
    })
    const response = await this.request('/v1/convert/source', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      ...withSignal(input.signal)
    })
    const raw = await this.readJson(response)
    const normalized = normalizeConversionResponse({
      raw,
      kind: 'url',
      url: input.url,
      outputFormat: input.options.outputFormat,
      elapsedMs: performance.now() - startedAt
    })
    return bounded(normalized, this.options.maxOutputChars)
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const timeout = new AbortController()
    const timeoutId = setTimeout(() => timeout.abort(), this.options.timeoutMs)
    const callerSignal = init.signal ?? undefined
    const signal = callerSignal === undefined ? timeout.signal : AbortSignal.any([callerSignal, timeout.signal])
    try {
      const headers = new Headers(init.headers)
      headers.set('accept', 'application/json')
      if (this.options.apiKey !== undefined) headers.set('X-Api-Key', this.options.apiKey)
      const response = await this.fetchImplementation(`${this.options.baseUrl}${path}`, { ...init, headers, signal })
      safeDebug(this.options, 'Docling request completed.', { method: init.method, path, status: response.status })
      if (!response.ok) {
        // Consume at most the response body; it is intentionally never included in
        // a model-facing error because it can contain a server traceback.
        await response.body?.cancel()
        throw responseError(response.status)
      }
      return response
    } catch (error) {
      if (error instanceof DoclingError) throw error
      if (timeout.signal.aborted) throw new DoclingError('DOCLING_TIMEOUT', 'Docling conversion timed out.')
      if (callerSignal?.aborted === true) throw new DoclingError('DOCLING_TIMEOUT', 'The document conversion was cancelled.')
      safeDebug(this.options, 'Docling request failed.', { method: init.method, path, error: error instanceof Error ? error.name : typeof error })
      throw new DoclingError('DOCLING_UNAVAILABLE', 'Docling Serve is unavailable.')
    } finally {
      clearTimeout(timeoutId)
    }
  }

  private async readJson(response: Response): Promise<JsonValue> {
    try {
      return await response.json() as JsonValue
    } catch {
      throw new DoclingError('DOCLING_CONVERSION_FAILED', 'Docling returned an invalid JSON response.')
    }
  }
}

function withSignal(signal: AbortSignal | undefined): Pick<RequestInit, 'signal'> | Record<string, never> {
  return signal === undefined ? {} : { signal }
}

function toSourceOptions(options: ConvertUrlInput['options']): Record<string, JsonValue> {
  return {
    to_formats: [options.outputFormat],
    ocr: options.ocr,
    table_mode: options.tableMode,
    ...options.pageRange === undefined ? {} : { page_range: [...options.pageRange] }
  }
}
