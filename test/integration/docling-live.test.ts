import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DoclingHttpClient } from '../../src/docling/client.js'

const baseUrl = process.env.DOCLING_BASE_URL
const describeLive = baseUrl === undefined ? describe.skip : describe

describeLive('real Docling Serve integration', () => {
  const client = new DoclingHttpClient({
    baseUrl: baseUrl as string,
    timeoutMs: 120_000,
    maxOutputChars: 32_000,
    debug: false,
    ...process.env.DOCLING_API_KEY === undefined ? {} : { apiKey: process.env.DOCLING_API_KEY }
  })

  it('checks health and converts the small Markdown fixture', async () => {
    await expect(client.health()).resolves.toMatchObject({ baseUrl })
    const path = fileURLToPath(new URL('../fixtures/sample.md', import.meta.url))
    const body = await readFile(path)
    const result = await client.convertFile({
      file: { path, name: 'sample.md', size: body.byteLength, mediaType: 'text/markdown' },
      options: { outputFormat: 'md', ocr: false, tableMode: 'fast' }
    })
    expect(result.markdown).toContain('Sample document')
  }, 130_000)
})
