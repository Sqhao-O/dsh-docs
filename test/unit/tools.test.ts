import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { JsonValue, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { DEFAULT_BASE_URL, type Config } from '../../src/config.js'
import type { ConversionResult, ConvertFileInput, ConvertUrlInput, DoclingClient, HealthResult } from '../../src/docling/types.js'
import { createConvertFileTool } from '../../src/tools/convert-file.js'
import { createConvertUrlTool } from '../../src/tools/convert-url.js'
import { createExtractTool } from '../../src/tools/extract.js'
import { createHealthTool } from '../../src/tools/health.js'

const directories: string[] = []

const result: ConversionResult = {
  source: { kind: 'file', name: 'report.pdf' },
  format: 'pdf',
  markdown: '# Report\n\nContent',
  metadata: { pages: 1, detectedFormat: 'pdf' },
  stats: { outputChars: 17, returnedChars: 17, truncated: false, elapsedMs: 10 }
}

class FakeDoclingClient implements DoclingClient {
  fileInput?: ConvertFileInput
  urlInput?: ConvertUrlInput

  async health(): Promise<HealthResult> {
    return { status: 'ok', baseUrl: DEFAULT_BASE_URL, latencyMs: 4 }
  }

  async convertFile(input: ConvertFileInput): Promise<ConversionResult> {
    this.fileInput = input
    return result
  }

  async convertUrl(input: ConvertUrlInput): Promise<ConversionResult> {
    this.urlInput = input
    return { ...result, source: { kind: 'url', url: input.url } }
  }
}

function config(root: string, overrides: Partial<Config> = {}): Config {
  return {
    baseUrl: DEFAULT_BASE_URL,
    timeoutMs: 120_000,
    maxFileBytes: 1_000_000,
    enableLocalFiles: true,
    enableRemoteUrls: true,
    allowedLocalRoots: [root],
    allowPrivateUrls: true,
    defaultOcr: true,
    defaultTableMode: 'accurate',
    defaultOutputFormat: 'md',
    maxOutputChars: 32_000,
    debug: false,
    ...overrides
  }
}

async function fixture(): Promise<{ root: string, file: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-docling-tools-'))
  directories.push(root)
  const file = join(root, 'report.md')
  await writeFile(file, '# report')
  return { root, file }
}

const execution = { signal: new AbortController().signal } as unknown as ToolRunContext

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('DSH tool definitions', () => {
  it('executes and renders docling_health', async () => {
    const tool = createHealthTool(new FakeDoclingClient())
    const value = await tool.execute({}, execution)
    expect(tool.output.render({}, value as JsonValue)[0]).toMatchObject({ text: expect.stringContaining('Docling status: ok') })
  })

  it('validates a local path then delegates conversion with model options', async () => {
    const { root, file } = await fixture()
    const client = new FakeDoclingClient()
    const tool = createConvertFileTool(client, config(root))
    const value = await tool.execute({ path: file, ocr: false, table_mode: 'fast', page_range: [2, 3] }, execution)
    expect(client.fileInput).toMatchObject({ file: { name: 'report.md' }, options: { outputFormat: 'md', ocr: false, tableMode: 'fast', pageRange: [2, 3] } })
    expect(tool.output.render({ path: file }, value as JsonValue)[0]).toMatchObject({ text: expect.stringContaining('Document: report.pdf') })
  })

  it('routes URLs and auto-detected sources through the URL client', async () => {
    const { root } = await fixture()
    const client = new FakeDoclingClient()
    const urlTool = createConvertUrlTool(client, config(root))
    await urlTool.execute({ url: 'http://127.0.0.1/report.pdf' }, execution)
    expect(client.urlInput?.url).toBe('http://127.0.0.1/report.pdf')
    const extractTool = createExtractTool(client, config(root))
    await extractTool.execute({ source: 'https://example.com/report.pdf' }, execution)
    expect(client.urlInput?.url).toBe('https://example.com/report.pdf')
  })

  it('routes a forced file source through the local file client', async () => {
    const { root, file } = await fixture()
    const client = new FakeDoclingClient()
    const tool = createExtractTool(client, config(root))
    await tool.execute({ source: file, source_type: 'file' }, execution)
    expect(client.fileInput?.file.name).toBe('report.md')
  })

  it('maps invalid page ranges and disabled capabilities into stable Harness errors', async () => {
    const { root, file } = await fixture()
    const client = new FakeDoclingClient()
    const fileTool = createConvertFileTool(client, config(root))
    await expect(fileTool.execute({ path: file, page_range: [3, 2] }, execution)).rejects.toMatchObject({ code: 'DOCLING_BAD_REQUEST' })
    const disabledTool = createExtractTool(client, config(root, { enableRemoteUrls: false }))
    await expect(disabledTool.execute({ source: 'https://example.com/report.pdf' }, execution)).rejects.toThrow('Remote document conversion is disabled')
  })
})
