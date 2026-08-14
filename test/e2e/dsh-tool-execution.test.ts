import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import * as DoclingPlugin from '../../src/index.js'
import type { Config } from '../../src/config.js'

function rawConfig(values: Record<string, unknown>): Config {
  return values as unknown as Config
}

async function startMockDocling(): Promise<{ baseUrl: string, close(): Promise<void> }> {
  const server = createServer(async (request, response) => {
    const ended = once(request, 'end')
    request.resume() // Consume the multipart/JSON request so the client path is fully exercised.
    await ended
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: 'healthy' }))
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ document: { md_content: '# Converted\n\nMock Docling output.' }, status: 'success' }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => { server.close(); await once(server, 'close') }
  }
}

describe('DSH ToolRuntime execution', () => {
  it('executes each tool through the real DSH lifecycle with canonical values and rendered model content', async () => {
    const server = await startMockDocling()
    const directory = await mkdtemp(join(tmpdir(), 'dsh-docling-runtime-'))
    const file = join(directory, 'report.md')
    await writeFile(file, '# Input\n\nBody')
    const ctx = new Context()

    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      const fiber = await ctx.plugin(DoclingPlugin, rawConfig({
        baseUrl: server.baseUrl,
        allowedLocalRoots: [directory],
        allowPrivateUrls: true,
        maxOutputChars: 512
      }))
      const run = (name: string, arguments_: unknown) => ctx.tools.execute({
        callId: CallId(`dsh-docling-${name}`),
        name,
        arguments: arguments_,
        signal: new AbortController().signal
      })

      const health = await run('docling_health', {})
      expect(health.isError).toBe(false)
      if (!health.isError) expect(health.value).toMatchObject({ status: 'healthy', baseUrl: server.baseUrl })

      const fileResult = await run('docling_convert_file', { path: file })
      expect(fileResult.isError).toBe(false)
      if (!fileResult.isError) expect(fileResult.value).toMatchObject({ source: { kind: 'file' }, markdown: '# Converted\n\nMock Docling output.' })

      const urlResult = await run('docling_convert_url', { url: `${server.baseUrl}/report.pdf` })
      expect(urlResult.isError).toBe(false)
      if (!urlResult.isError) expect(urlResult.value).toMatchObject({ source: { kind: 'url', url: `${server.baseUrl}/report.pdf` } })

      const extractResult = await run('docling_extract', { source: file })
      expect(extractResult.isError).toBe(false)
      if (!extractResult.isError) expect(extractResult.value).toMatchObject({ source: { kind: 'file' } })

      for (const result of [fileResult, urlResult, extractResult]) {
        expect(result.content).toHaveLength(1)
        expect(result.content[0]).toMatchObject({ type: 'text' })
        expect(JSON.stringify(result.content)).toContain('Parsed successfully')
      }

      const invalid = await run('docling_convert_file', {})
      expect(invalid.isError).toBe(true)
      if (invalid.isError) expect(JSON.stringify(invalid.error)).toContain('path')

      await fiber.dispose()
    } finally {
      await server.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
