import type { ConversionResult, JsonObject, JsonValue, OutputFormat, SourceKind } from './types.js'
import { isJsonValue } from './types.js'
import { DoclingError } from './errors.js'

function record(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && isJsonValue(value)
    ? value as JsonObject
    : undefined
}

function stringField(object: JsonObject | undefined, key: string): string | undefined {
  const value = object?.[key]
  return typeof value === 'string' ? value : undefined
}

function documentFromResponse(raw: JsonObject): JsonObject | undefined {
  const direct = record(raw.document)
  if (direct !== undefined) return direct
  const documents = raw.documents
  if (!Array.isArray(documents) || documents.length === 0) return undefined
  return record(record(documents[0])?.content)
}

function inferredPages(json: JsonValue | undefined): number | undefined {
  const pages = record(json)?.pages
  return Array.isArray(pages) ? pages.length : undefined
}

function inferredTitle(document: JsonObject, json: JsonValue | undefined): string | undefined {
  return stringField(document, 'title')
    ?? stringField(record(json), 'name')
    ?? stringField(record(record(json)?.origin), 'filename')
}

function outputFor(document: JsonObject, format: OutputFormat): Pick<ConversionResult, 'markdown' | 'text' | 'json'> {
  if (format === 'md') {
    const markdown = stringField(document, 'md_content')
    if (markdown === undefined) throw new DoclingError('DOCLING_CONVERSION_FAILED', 'Docling did not return Markdown output.')
    return { markdown }
  }
  if (format === 'text') {
    const text = stringField(document, 'text_content')
    if (text === undefined) throw new DoclingError('DOCLING_CONVERSION_FAILED', 'Docling did not return text output.')
    return { text }
  }
  const json = document.json_content
  if (json === undefined || !isJsonValue(json)) {
    throw new DoclingError('DOCLING_CONVERSION_FAILED', 'Docling did not return JSON output.')
  }
  return { json }
}

export function normalizeConversionResponse(input: {
  readonly raw: unknown
  readonly kind: SourceKind
  readonly name?: string
  readonly url?: string
  readonly outputFormat: OutputFormat
  readonly elapsedMs: number
}): ConversionResult {
  const raw = record(input.raw)
  if (raw === undefined) throw new DoclingError('DOCLING_CONVERSION_FAILED', 'Docling returned an invalid JSON response.')
  if (stringField(raw, 'status') === 'failure') {
    throw new DoclingError('DOCLING_CONVERSION_FAILED', 'Docling could not convert this document.')
  }
  const document = documentFromResponse(raw)
  if (document === undefined) {
    throw new DoclingError('DOCLING_CONVERSION_FAILED', 'Docling returned no converted document.')
  }
  const documentJson = document.json_content
  const json = documentJson !== undefined && isJsonValue(documentJson) ? documentJson : undefined
  const output = outputFor(document, input.outputFormat)
  const format = stringField(document, 'format') ?? input.name?.split('.').pop() ?? input.url?.split(/[?#]/)[0]?.split('.').pop() ?? 'unknown'
  const content = output.markdown ?? output.text ?? JSON.stringify(output.json, null, 2)
  const title = inferredTitle(document, json)
  const pages = inferredPages(json)
  return {
    source: {
      kind: input.kind,
      ...input.name === undefined ? {} : { name: input.name },
      ...input.url === undefined ? {} : { url: input.url }
    },
    format,
    ...output,
    metadata: {
      ...title === undefined ? {} : { title },
      ...pages === undefined ? {} : { pages },
      detectedFormat: format
    },
    stats: {
      outputChars: content.length,
      returnedChars: content.length,
      truncated: false,
      elapsedMs: Math.max(0, Math.round(input.elapsedMs))
    }
  }
}
