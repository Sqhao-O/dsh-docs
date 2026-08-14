import { describe, expect, it } from 'vitest'
import { asConversionResult, renderConversion } from '../../src/output/render.js'
import type { ConversionResult } from '../../src/engine/types.js'

function result(overrides: Partial<ConversionResult> = {}): ConversionResult {
  return {
    source: { kind: 'file', name: 'report.pdf' },
    format: 'pdf',
    markdown: '# Parsed',
    metadata: { detectedFormat: 'application/pdf' },
    stats: { outputChars: 8, returnedChars: 8, truncated: false, elapsedMs: 2 },
    ...overrides
  }
}

describe('model-facing conversion renderer', () => {
  it('renders Markdown and compact result metadata', () => {
    expect(renderConversion(result())).toContain('Document: report.pdf\nFormat: application/pdf\nParsed successfully\nTruncated: false\n\n# Parsed')
  })

  it('renders text and pretty JSON results', () => {
    const { markdown: originalMarkdown, ...textBase } = result()
    void originalMarkdown
    const text: ConversionResult = { ...textBase, text: 'plain text', metadata: { pages: 2 } }
    expect(renderConversion(text)).toContain('Pages: 2\nTruncated: false\n\nplain text')

    const { markdown: originalForJson, ...jsonBase } = result()
    void originalForJson
    const json: ConversionResult = { ...jsonBase, json: { title: 'JSON', items: [1, 2] } }
    expect(renderConversion(json)).toContain('"title": "JSON"')
  })

  it('reports a bounded response and narrows canonical tool values', () => {
    const truncated = result({ stats: { outputChars: 1000, returnedChars: 256, truncated: true, elapsedMs: 2 } })
    expect(renderConversion(truncated)).toContain('Output: 256/1000 characters returned')
    expect(asConversionResult(truncated as never)).toBe(truncated)
  })
})
