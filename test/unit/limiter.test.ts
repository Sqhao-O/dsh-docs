import { describe, expect, it } from 'vitest'
import { limitText } from '../../src/output/limiter.js'

describe('output limiter', () => {
  it('leaves a short document and the exact boundary untouched', () => {
    expect(limitText('short', 256)).toMatchObject({ text: 'short', originalChars: 5, returnedChars: 5, truncated: false })
    const exact = 'a'.repeat(256)
    expect(limitText(exact, 256)).toMatchObject({ text: exact, truncated: false })
  })

  it('bounds a long document and announces truncation', () => {
    const limited = limitText('# One\n\n' + 'a'.repeat(300) + '\n## Two\n\n' + 'b'.repeat(300), 256)
    expect(limited.truncated).toBe(true)
    expect(limited.text.length).toBeLessThanOrEqual(256)
    expect(limited.text).toContain('Document parsed successfully, but output was truncated.')
    expect(limited.originalChars).toBeGreaterThan(limited.returnedChars)
  })

  it('does not split Unicode surrogate pairs', () => {
    const limited = limitText('😀'.repeat(300), 256)
    expect(limited.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  })

  it('rejects an impossible limit', () => {
    expect(() => limitText('x'.repeat(300), 16)).toThrow(RangeError)
  })
})
