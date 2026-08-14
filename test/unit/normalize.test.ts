import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { normalizeConversionResponse } from '../../src/docling/normalize.js'

async function fixture(name: string): Promise<unknown> {
  const url = new URL(`../fixtures/${name}`, import.meta.url)
  return JSON.parse(await readFile(fileURLToPath(url), 'utf8')) as unknown
}

describe('Docling response normalization', () => {
  it('normalizes Markdown with metadata and page count', async () => {
    const result = normalizeConversionResponse({ raw: await fixture('docling-markdown.json'), kind: 'file', name: 'report.pdf', outputFormat: 'md', elapsedMs: 12.2 })
    expect(result).toMatchObject({
      source: { kind: 'file', name: 'report.pdf' },
      markdown: '# Quarterly report\n\nRevenue increased by 12%.\n',
      metadata: { title: 'Quarterly report', pages: 2, detectedFormat: 'pdf' },
      stats: { outputChars: 46, returnedChars: 46, truncated: false, elapsedMs: 12 }
    })
  })

  it('normalizes text and JSON output', async () => {
    const text = normalizeConversionResponse({ raw: await fixture('docling-text.json'), kind: 'url', url: 'https://example.com/a.html', outputFormat: 'text', elapsedMs: 1 })
    expect(text.text).toBe('Revenue increased by 12%.')
    const json = normalizeConversionResponse({ raw: await fixture('docling-json.json'), kind: 'file', name: 'book.pdf', outputFormat: 'json', elapsedMs: 1 })
    expect(json.json).toMatchObject({ schema_name: 'DoclingDocument' })
  })

  it('accepts the batch-compatible documents[0].content response shape', () => {
    const result = normalizeConversionResponse({
      raw: { documents: [{ content: { md_content: '# Report' } }] },
      kind: 'url', url: 'https://example.com/report.md', outputFormat: 'md', elapsedMs: 0
    })
    expect(result.markdown).toBe('# Report')
  })

  it.each([
    [{}, 'Docling returned no converted document.'],
    [{ status: 'failure' }, 'Docling could not convert this document.'],
    [{ document: {} }, 'Docling did not return Markdown output.']
  ] as const)('returns a safe conversion error for malformed upstream responses', (raw, message) => {
    try {
      normalizeConversionResponse({ raw, kind: 'file', name: 'x.pdf', outputFormat: 'md', elapsedMs: 1 })
      throw new Error('Expected normalizer to fail')
    } catch (error) {
      expect(error).toMatchObject({ code: 'DOCLING_CONVERSION_FAILED', message })
    }
  })
})
