import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import * as DocumentPlugin from '../../src/index.js'
import type { Config } from '../../src/config.js'
import { generateDocumentFixtures } from '../helpers/document-fixtures.js'

function rawConfig(values: Record<string, unknown>): Config {
  return values as unknown as Config
}

describe('DSH ToolRuntime execution', () => {
  it('executes local Xberg parsing through the real DSH lifecycle and renders model context', async () => {
    const fixtures = await generateDocumentFixtures()
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      const fiber = await ctx.plugin(DocumentPlugin, rawConfig({
        engine: 'node',
        allowedLocalRoots: [fixtures.directory],
        defaultOcr: false,
        maxOutputChars: 4_096
      }))
      const run = (name: string, arguments_: unknown, cwd?: string) => ctx.tools.execute({
        callId: CallId(`dsh-local-document-${name}`),
        name,
        arguments: arguments_,
        signal: new AbortController().signal,
        ...(cwd === undefined ? {} : { agent: { session: { header: { cwd } } } as never })
      })

      const health = await run('docling_health', {})
      expect(health.isError).toBe(false)
      if (!health.isError) expect(health.value).toMatchObject({ status: 'ready', engine: 'xberg-node' })

      const docx = await run('docling_convert_file', { path: fixtures.file('docx'), ocr: false })
      expect(docx.isError).toBe(false)
      if (!docx.isError) expect(docx.value).toMatchObject({ source: { kind: 'file', name: 'document.docx' } })
      expect(JSON.stringify(docx)).toContain(fixtures.sentinels.docx)

      const relative = await run('docling_extract', { source: `./${fixtures.files.xlsx}`, ocr: false }, fixtures.directory)
      expect(relative.isError).toBe(false)
      expect(JSON.stringify(relative)).toContain(fixtures.sentinels.xlsx)

      const remote = await run('docling_convert_url', { url: 'https://example.com/report.pdf' })
      expect(remote.isError).toBe(true)
      if (remote.isError) expect(JSON.stringify(remote.error)).toContain('UNSUPPORTED_URL')

      const unavailableOcr = await run('docling_extract', { source: fixtures.file('png'), ocr: true })
      expect(unavailableOcr.isError).toBe(true)
      if (unavailableOcr.isError) expect(JSON.stringify(unavailableOcr.error)).toContain('ENGINE_OCR_UNAVAILABLE')

      for (const result of [docx, relative]) {
        expect(result.content).toHaveLength(1)
        expect(result.content[0]).toMatchObject({ type: 'text' })
        expect(JSON.stringify(result.content)).toContain('Parsed successfully')
      }
      await fiber.dispose()
    } finally {
      await fixtures.dispose()
    }
  }, 120_000)
})
