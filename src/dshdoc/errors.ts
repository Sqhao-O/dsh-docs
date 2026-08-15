export type DshdocErrorCode =
  | 'DSHDOC_UNAVAILABLE'
  | 'DSHDOC_TIMEOUT'
  | 'DSHDOC_AUTH_FAILED'
  | 'DSHDOC_BAD_REQUEST'
  | 'DSHDOC_CONVERSION_FAILED'
  | 'FILE_NOT_FOUND'
  | 'FILE_TOO_LARGE'
  | 'FILE_ACCESS_DENIED'
  | 'UNSUPPORTED_URL'
  | 'SSRF_BLOCKED'
  | 'OUTPUT_TOO_LARGE'

/** A stable, safe error intended to cross the tool boundary. */
export class DshdocError extends Error {
  readonly code: DshdocErrorCode
  readonly status?: number

  constructor(code: DshdocErrorCode, message: string, status?: number) {
    super(message)
    this.name = 'DshdocError'
    this.code = code
    if (status !== undefined) this.status = status
  }
}

export function isDshdocError(error: unknown): error is DshdocError {
  return error instanceof DshdocError
}
