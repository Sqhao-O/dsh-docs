import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { extract, ExtractInputKind, OutputFormat as XbergOutputFormat } from '@xberg-io/xberg'
import type { ExtractedDocument, ExtractionConfig } from '@xberg-io/xberg'
import { limitText } from '../output/limiter.js'
import { documentEngineError, isDocumentEngineError } from './errors.js'
import type { ConversionResult, ConvertFileInput, DocumentEngine, HealthResult, JsonValue } from './types.js'
import { isJsonValue } from './types.js'

export interface XbergNodeClientOptions {
  readonly timeoutMs: number
  readonly maxOutputChars: number
  /** Ordered OCR language identifiers understood by the selected Xberg backend. Defaults to every bundled pack. */
  readonly ocrLanguages?: readonly string[]
  /** `auto` lets Xberg select its configured local OCR implementation. */
  readonly ocrBackend: 'auto' | 'tesseract'
  /** Absolute directory of pinned Tesseract language packs, when packaged. */
  readonly tessdataPath?: string
  readonly debug?: (message: string, details?: Readonly<Record<string, unknown>>) => void
}

function extension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? 'document' : name.slice(dot + 1).toLowerCase() || 'document'
}

function xbergFormat(format: ConvertFileInput['options']['outputFormat']): XbergOutputFormat {
  switch (format) {
    case 'md': return XbergOutputFormat.Markdown
    case 'text': return XbergOutputFormat.Plain
    case 'json': return XbergOutputFormat.Json
  }
}

function safeJson(value: unknown): JsonValue | undefined {
  if (!isJsonValue(value)) return undefined
  return value
}

function resultJson(document: ExtractedDocument): JsonValue {
  const content = document.content ?? ''
  try {
    const parsed = safeJson(JSON.parse(content))
    if (parsed !== undefined) return parsed
  } catch {
    // A custom renderer is permitted to return text even when JSON was
    // requested. Return a structured, JSON-safe envelope in that case.
  }
  const fallback = {
    content,
    mimeType: document.mimeType ?? null,
    metadata: document.metadata === undefined ? null : JSON.parse(JSON.stringify(document.metadata)) as unknown,
    tables: document.tables === undefined ? [] : JSON.parse(JSON.stringify(document.tables)) as unknown,
    pages: document.pages === undefined ? [] : JSON.parse(JSON.stringify(document.pages)) as unknown
  }
  const json = safeJson(fallback)
  if (json === undefined) throw documentEngineError('ENGINE_PROTOCOL_ERROR')
  return json
}

function selectedContent(document: ExtractedDocument, pageRange: readonly [number, number] | undefined): string {
  if (pageRange === undefined || document.pages === undefined) return document.content ?? ''
  const pages = document.pages.filter(page => page.pageNumber >= pageRange[0] && page.pageNumber <= pageRange[1])
  if (pages.length === 0) return ''
  return pages.map(page => page.content).join('\n\n')
}

function bound(result: ConversionResult, maxOutputChars: number): ConversionResult {
  const content = result.markdown ?? result.text ?? JSON.stringify(result.json, null, 2)
  const limited = limitText(content, maxOutputChars)
  if (!limited.truncated) return result
  const stats = {
    ...result.stats,
    outputChars: limited.originalChars,
    returnedChars: limited.returnedChars,
    truncated: true
  }
  if (result.markdown !== undefined) return { ...result, markdown: limited.text, stats }
  if (result.text !== undefined) return { ...result, text: limited.text, stats }
  const { json, ...withoutJson } = result
  void json
  return { ...withoutJson, text: limited.text, stats }
}

function errorForXberg(error: unknown): ReturnType<typeof documentEngineError> {
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  if (message.includes('tesseract') || message.includes('ocr')) return documentEngineError('ENGINE_OCR_UNAVAILABLE')
  if (message.includes('unsupported') || message.includes('mime')) return documentEngineError('ENGINE_UNSUPPORTED_FORMAT')
  return documentEngineError('ENGINE_CONVERSION_FAILED')
}

async function pinnedTessdata(
  tessdataPath: string | undefined,
  languages: readonly string[]
): Promise<Record<string, Uint8Array>> {
  if (tessdataPath === undefined) throw documentEngineError('ENGINE_OCR_UNAVAILABLE')
  try {
    const entries = await Promise.all(languages.map(async language => {
      const bytes = await readFile(join(tessdataPath, `${language}.traineddata`))
      if (bytes.byteLength === 0) throw documentEngineError('ENGINE_OCR_UNAVAILABLE')
      return [language, Uint8Array.from(bytes)] as const
    }))
    return Object.fromEntries(entries)
  } catch (error) {
    if (isDocumentEngineError(error)) throw error
    // Missing/bad language data must not cause Xberg to download a fallback.
    throw documentEngineError('ENGINE_OCR_UNAVAILABLE')
  }
}

async function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined, timeoutMs: number): Promise<T> {
  if (signal?.aborted === true) throw documentEngineError('ENGINE_CANCELLED')
  let timeout: ReturnType<typeof setTimeout> | undefined
  let removeAbort: (() => void) | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(documentEngineError('ENGINE_TIMEOUT')), timeoutMs)
      }),
      new Promise<T>((_resolve, reject) => {
        if (signal === undefined) return
        const abort = (): void => reject(documentEngineError('ENGINE_CANCELLED'))
        signal.addEventListener('abort', abort, { once: true })
        removeAbort = () => signal.removeEventListener('abort', abort)
      })
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    removeAbort?.()
  }
}

/**
 * Local Xberg implementation used by default. It receives only an immutable
 * byte snapshot and never lets the engine reopen a user path or fetch a URL.
 */
export class XbergNodeClient implements DocumentEngine {
  constructor(private readonly options: XbergNodeClientOptions) {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1
      || !Number.isSafeInteger(options.maxOutputChars) || options.maxOutputChars < 128
      || (options.ocrLanguages !== undefined
        && (options.ocrLanguages.length === 0
          || options.ocrLanguages.some(language => !/^[A-Za-z0-9_+-]+$/.test(language))))
      || (options.ocrBackend !== 'auto' && options.ocrBackend !== 'tesseract')) {
      throw documentEngineError('ENGINE_RUNTIME_INVALID')
    }
  }

  /** Per-request or configured languages, or every pack bundled in the pinned tessdata directory. */
  private async resolvedLanguages(override?: readonly string[]): Promise<string[]> {
    const languages = override ?? this.options.ocrLanguages
    if (languages !== undefined) return [...languages]
    const tessdataPath = this.options.tessdataPath
    if (tessdataPath === undefined) throw documentEngineError('ENGINE_OCR_UNAVAILABLE')
    let entries: string[]
    try {
      entries = await readdir(tessdataPath)
    } catch {
      throw documentEngineError('ENGINE_OCR_UNAVAILABLE')
    }
    return entries
      .filter(entry => entry.endsWith('.traineddata'))
      .map(entry => entry.slice(0, -'.traineddata'.length))
      .filter(stem => /^[A-Za-z0-9_+-]+$/.test(stem))
      .sort()
  }

  private async ocrConfig(tableMode: ConvertFileInput['options']['tableMode'], override?: readonly string[]): Promise<NonNullable<ExtractionConfig['ocr']>> {
    const languages = await this.resolvedLanguages(override)
    // Per-request languages bypass the constructor invariant; pinnedTessdata
    // joins them into a path, so reject unsafe identifiers here as well.
    if (languages.some(language => !/^[A-Za-z0-9_+-]+$/.test(language))) {
      throw documentEngineError('ENGINE_INVALID_INPUT')
    }
    if (languages.length === 0) throw documentEngineError('ENGINE_OCR_UNAVAILABLE')
    const tessdataPath = this.options.tessdataPath
    if (tessdataPath === undefined) throw documentEngineError('ENGINE_OCR_UNAVAILABLE')
    const tessdataBytes = await pinnedTessdata(tessdataPath, languages)
    return {
      enabled: true,
      // Never let Xberg auto-select a downloadable model backend in the
      // local-only plugin. The only supported OCR asset is pinned tessdata.
      backend: 'tesseract',
      language: languages,
      tessdataPath,
      tessdataBytes,
      // Xberg has a separate Tesseract-result cache in addition to its
      // top-level extraction cache. Never retain document-derived OCR data.
      tesseractConfig: {
        language: languages,
        enableTableDetection: tableMode === 'accurate',
        useCache: false
      }
    }
  }

  /** Languages whose pinned packs all exist, or empty when OCR is unavailable. */
  private async availableOcrLanguages(): Promise<readonly string[]> {
    try {
      const languages = await this.resolvedLanguages()
      if (languages.length === 0) return []
      await pinnedTessdata(this.options.tessdataPath, languages)
      return languages
    } catch {
      return []
    }
  }

  async health(signal?: AbortSignal): Promise<HealthResult> {
    const startedAt = performance.now()
    const ocrLanguages = await this.availableOcrLanguages()
    const ocrAvailable = ocrLanguages.length > 0
    // A tiny in-memory parse confirms that the N-API binary was loaded, not
    // merely that its JavaScript wrapper could be imported.
    try {
      await raceWithAbort(extract({
        kind: ExtractInputKind.Bytes,
        bytes: new TextEncoder().encode('dsh-document-engine health probe'),
        mimeType: 'text/plain',
        filename: 'health.txt'
      }, {
        outputFormat: XbergOutputFormat.Plain,
        disableOcr: true,
        useCache: false,
        extractionTimeoutSecs: Math.max(1, Math.ceil(this.options.timeoutMs / 1_000))
      }), signal, this.options.timeoutMs)
      return {
        status: 'ready',
        engine: 'xberg-node',
        runtimeVersion: '1.0.14',
        ocrAvailable,
        ocrLanguages: [...ocrLanguages],
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt))
      }
    } catch (error) {
      if (isDocumentEngineError(error)) throw error
      throw errorForXberg(error)
    }
  }

  async convertFile(input: ConvertFileInput): Promise<ConversionResult> {
    const startedAt = performance.now()
    if (input.file.name.trim() === '' || input.file.mediaType.trim() === ''
      || input.file.size !== input.file.bytes.byteLength || input.file.size < 0) {
      throw documentEngineError('ENGINE_INVALID_INPUT')
    }
    const bytes = Uint8Array.from(input.file.bytes)
    const pageRange = input.options.pageRange
    try {
      const ocr = input.options.ocr ? await this.ocrConfig(input.options.tableMode, input.options.ocrLanguages) : undefined
      const config: ExtractionConfig = {
        outputFormat: xbergFormat(input.options.outputFormat),
        useCache: false,
        extractionTimeoutSecs: Math.max(1, Math.ceil(this.options.timeoutMs / 1_000)),
        enableQualityProcessing: true,
        disableOcr: !input.options.ocr,
        ...(ocr === undefined ? {} : { ocr }),
        pdfOptions: {
          extractTables: input.options.tableMode === 'accurate',
          // Reading-order reflow improves Markdown/JSON structure, but on
          // multi-column layouts it interleaves fragments into scrambled
          // plain text, so text output keeps the native stream order.
          readingOrder: input.options.tableMode === 'accurate' && input.options.outputFormat !== 'text'
        },
        ...(pageRange === undefined ? {} : { pages: { extractPages: true } })
      }
      const envelope = await raceWithAbort(extract({
        kind: ExtractInputKind.Bytes,
        bytes,
        mimeType: input.file.mediaType,
        filename: input.file.name
      }, config), input.signal, this.options.timeoutMs)
      const document = envelope.results?.[0]
      if (document === undefined) throw documentEngineError('ENGINE_CONVERSION_FAILED')
      const elapsedMs = Math.max(0, Math.round(performance.now() - startedAt))
      const metadata = {
        ...(document.metadata?.title === undefined ? {} : { title: document.metadata.title }),
        ...(document.counts?.pages === undefined ? {} : { pages: document.counts.pages }),
        ...(document.metadata?.ocrUsed === undefined ? {} : { ocrUsed: document.metadata.ocrUsed }),
        detectedFormat: document.mimeType ?? extension(input.file.name)
      }
      const base = {
        source: { kind: 'file' as const, name: input.file.name },
        format: extension(input.file.name),
        metadata,
        stats: { outputChars: 0, returnedChars: 0, truncated: false, elapsedMs }
      }
      let result: ConversionResult
      if (input.options.outputFormat === 'md') {
        const markdown = selectedContent(document, pageRange)
        result = { ...base, markdown, stats: { ...base.stats, outputChars: markdown.length, returnedChars: markdown.length } }
      } else if (input.options.outputFormat === 'text') {
        const text = selectedContent(document, pageRange)
        result = { ...base, text, stats: { ...base.stats, outputChars: text.length, returnedChars: text.length } }
      } else {
        const json = resultJson(document)
        const content = JSON.stringify(json, null, 2)
        result = { ...base, json, stats: { ...base.stats, outputChars: content.length, returnedChars: content.length } }
      }
      this.options.debug?.('Local Xberg conversion completed.', {
        format: result.format,
        outputFormat: input.options.outputFormat,
        elapsedMs: result.stats.elapsedMs
      })
      return bound(result, this.options.maxOutputChars)
    } catch (error) {
      if (isDocumentEngineError(error)) throw error
      throw errorForXberg(error)
    }
  }
}
