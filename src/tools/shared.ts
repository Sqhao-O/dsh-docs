import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { Config } from '../config.js'
import { DoclingError, isDoclingError } from '../docling/errors.js'
import { isDocumentEngineError } from '../engine/errors.js'
import type { ConvertOptions } from '../engine/types.js'

export interface ConversionArgs {
  readonly output_format?: string
  readonly ocr?: boolean
  readonly table_mode?: string
  readonly page_range?: readonly number[]
  readonly ocr_languages?: readonly string[]
}

const OCR_LANGUAGE_PATTERN = /^[A-Za-z0-9_+-]+$/
const MAX_OCR_LANGUAGES = 16

export function convertOptions(args: ConversionArgs, config: Config): ConvertOptions {
  let pageRange: readonly [number, number] | undefined
  if (args.page_range !== undefined) {
    const firstPage = args.page_range[0]
    const lastPage = args.page_range[1]
    if (args.page_range.length !== 2
      || firstPage === undefined
      || lastPage === undefined
      || !Number.isSafeInteger(firstPage)
      || !Number.isSafeInteger(lastPage)
      || firstPage < 1
      || lastPage < firstPage) {
      throw new DoclingError('DOCLING_BAD_REQUEST', 'page_range must contain two positive page numbers in ascending order.')
    }
    pageRange = [firstPage, lastPage]
  }
  const outputFormat = args.output_format ?? config.defaultOutputFormat
  const tableMode = args.table_mode ?? config.defaultTableMode
  if (outputFormat !== 'md' && outputFormat !== 'text' && outputFormat !== 'json') {
    throw new DoclingError('DOCLING_BAD_REQUEST', 'output_format must be md, text, or json.')
  }
  if (tableMode !== 'fast' && tableMode !== 'accurate') {
    throw new DoclingError('DOCLING_BAD_REQUEST', 'table_mode must be fast or accurate.')
  }
  const ocrLanguages = args.ocr_languages
  if (ocrLanguages !== undefined
    && (ocrLanguages.length === 0
      || ocrLanguages.length > MAX_OCR_LANGUAGES
      || ocrLanguages.some(language => !OCR_LANGUAGE_PATTERN.test(language)))) {
    throw new DoclingError('DOCLING_BAD_REQUEST', 'ocr_languages must name 1-16 bundled local language packs, for example ["eng", "chi_sim"].')
  }
  return {
    outputFormat,
    ocr: args.ocr ?? config.defaultOcr,
    tableMode,
    ...ocrLanguages === undefined ? {} : { ocrLanguages },
    ...pageRange === undefined ? {} : { pageRange }
  }
}

export function asHarnessError(error: unknown): never {
  if (isDoclingError(error)) throw new HarnessError(error.message, error.code)
  if (isDocumentEngineError(error)) throw new HarnessError(error.message, error.code)
  throw error
}

export const CONVERSION_PARAMETERS = {
  output_format: {
    type: 'string' as const,
    enum: ['md', 'text', 'json'],
    description: 'Requested Docling output: md (default), text, or json.'
  },
  ocr: { type: 'boolean' as const, description: 'Enable OCR for scans and bitmap content.' },
  table_mode: {
    type: 'string' as const,
    enum: ['fast', 'accurate'],
    description: 'Table extraction mode. accurate is the plugin default.'
  },
  page_range: {
    type: 'array' as const,
    items: { type: 'integer' as const },
    description: 'Optional inclusive [start, end] page range; page numbering starts at 1. Applies to md and text output; json retains the complete structured document.'
  },
  ocr_languages: {
    type: 'array' as const,
    items: { type: 'string' as const },
    description: 'Optional ordered OCR language packs bundled with the runtime, for example ["chi_sim", "eng"]. Defaults to the configured or bundled language set.'
  }
} as const

export const CONVERSION_OUTPUT = {
  type: 'json' as const
} as const
