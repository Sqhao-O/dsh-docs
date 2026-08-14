export type DoclingErrorCode =
  | 'DOCLING_UNAVAILABLE'
  | 'DOCLING_TIMEOUT'
  | 'DOCLING_AUTH_FAILED'
  | 'DOCLING_BAD_REQUEST'
  | 'DOCLING_CONVERSION_FAILED'
  | 'FILE_NOT_FOUND'
  | 'FILE_TOO_LARGE'
  | 'FILE_ACCESS_DENIED'
  | 'UNSUPPORTED_URL'
  | 'SSRF_BLOCKED'
  | 'OUTPUT_TOO_LARGE'

/** A stable, safe error intended to cross the tool boundary. */
export class DoclingError extends Error {
  readonly code: DoclingErrorCode
  readonly status?: number

  constructor(code: DoclingErrorCode, message: string, status?: number) {
    super(message)
    this.name = 'DoclingError'
    this.code = code
    if (status !== undefined) this.status = status
  }
}

export function isDoclingError(error: unknown): error is DoclingError {
  return error instanceof DoclingError
}
