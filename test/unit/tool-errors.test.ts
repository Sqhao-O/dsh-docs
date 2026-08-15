import { describe, expect, it } from 'vitest'
import { DshdocError, isDshdocError } from '../../src/dshdoc/errors.js'

describe('tool boundary errors', () => {
  it('preserves an explicit status without accepting lookalike errors', () => {
    const error = new DshdocError('FILE_ACCESS_DENIED', 'safe message', 403)
    expect(error).toMatchObject({ name: 'DshdocError', code: 'FILE_ACCESS_DENIED', status: 403 })
    expect(isDshdocError(error)).toBe(true)
    expect(isDshdocError({ code: 'FILE_ACCESS_DENIED' })).toBe(false)
  })
})
