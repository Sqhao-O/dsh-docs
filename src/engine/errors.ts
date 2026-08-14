/**
 * Errors emitted by a document engine implementation.
 *
 * These codes deliberately describe the engine boundary rather than a specific
 * parser. The DSH plugin can map them to its public tool errors while a native
 * Node binding, a Python worker, or another local runtime all implement the
 * same contract.
 */
export type DocumentEngineErrorCode =
  | 'ENGINE_INVALID_INPUT'
  | 'ENGINE_UNAVAILABLE'
  | 'ENGINE_RUNTIME_INVALID'
  | 'ENGINE_TIMEOUT'
  | 'ENGINE_CANCELLED'
  | 'ENGINE_PROTOCOL_ERROR'
  | 'ENGINE_CONVERSION_FAILED'
  | 'ENGINE_UNSUPPORTED_FORMAT'
  | 'ENGINE_OCR_UNAVAILABLE'

/** A stable, non-sensitive error that may safely cross the tool boundary. */
export class DocumentEngineError extends Error {
  readonly code: DocumentEngineErrorCode

  constructor(code: DocumentEngineErrorCode, message: string) {
    super(message)
    this.name = 'DocumentEngineError'
    this.code = code
  }
}

export function isDocumentEngineError(error: unknown): error is DocumentEngineError {
  return error instanceof DocumentEngineError
}

/**
 * Do not surface an arbitrary worker-supplied message. A parser can include a
 * traceback, a local path, or document content in such a message.
 */
export function messageForDocumentEngineError(code: DocumentEngineErrorCode): string {
  switch (code) {
    case 'ENGINE_INVALID_INPUT':
      return 'The document engine received an invalid conversion request.'
    case 'ENGINE_UNAVAILABLE':
      return 'The local document engine is unavailable.'
    case 'ENGINE_RUNTIME_INVALID':
      return 'The local document engine runtime is not configured correctly.'
    case 'ENGINE_TIMEOUT':
      return 'The local document engine timed out.'
    case 'ENGINE_CANCELLED':
      return 'The document conversion was cancelled.'
    case 'ENGINE_PROTOCOL_ERROR':
      return 'The local document engine returned an invalid response.'
    case 'ENGINE_CONVERSION_FAILED':
      return 'The local document engine could not convert this document.'
    case 'ENGINE_UNSUPPORTED_FORMAT':
      return 'This document format is not supported by the local document engine.'
    case 'ENGINE_OCR_UNAVAILABLE':
      return 'OCR is unavailable in the local document engine runtime.'
  }
}

export function documentEngineError(code: DocumentEngineErrorCode): DocumentEngineError {
  return new DocumentEngineError(code, messageForDocumentEngineError(code))
}
