import { describe, expect, it } from 'vitest'
import { DocumentEngineError, documentEngineError, isDocumentEngineError, messageForDocumentEngineError } from '../../src/engine/errors.js'

const codes = [
  'ENGINE_INVALID_INPUT',
  'ENGINE_UNAVAILABLE',
  'ENGINE_RUNTIME_INVALID',
  'ENGINE_TIMEOUT',
  'ENGINE_CANCELLED',
  'ENGINE_PROTOCOL_ERROR',
  'ENGINE_CONVERSION_FAILED',
  'ENGINE_UNSUPPORTED_FORMAT',
  'ENGINE_OCR_UNAVAILABLE'
] as const

describe('document engine errors', () => {
  it.each(codes)('provides a stable safe message for %s', code => {
    const error = documentEngineError(code)
    expect(error).toBeInstanceOf(DocumentEngineError)
    expect(error).toMatchObject({ name: 'DocumentEngineError', code })
    expect(error.message).toBe(messageForDocumentEngineError(code))
    expect(isDocumentEngineError(error)).toBe(true)
  })

  it('does not classify arbitrary errors as document engine errors', () => {
    expect(isDocumentEngineError(new Error('private trace'))).toBe(false)
    expect(isDocumentEngineError({ code: 'ENGINE_TIMEOUT' })).toBe(false)
  })
})
