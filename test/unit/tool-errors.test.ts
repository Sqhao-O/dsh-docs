import { describe, expect, it } from 'vitest'
import { DoclingError, isDoclingError } from '../../src/docling/errors.js'

describe('tool boundary errors', () => {
  it('preserves an explicit status without accepting lookalike errors', () => {
    const error = new DoclingError('FILE_ACCESS_DENIED', 'safe message', 403)
    expect(error).toMatchObject({ name: 'DoclingError', code: 'FILE_ACCESS_DENIED', status: 403 })
    expect(isDoclingError(error)).toBe(true)
    expect(isDoclingError({ code: 'FILE_ACCESS_DENIED' })).toBe(false)
  })
})
