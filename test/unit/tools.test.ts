import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { JsonValue, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Config } from '../../src/config.js'
import { documentEngineError } from '../../src/engine/errors.js'
import type { ConversionResult, ConvertFileInput, DocumentEngine, HealthResult } from '../../src/engine/types.js'
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

class FakeDocumentEngine implements DocumentEngine {
  fileInput?: ConvertFileInput

  async health(): Promise<HealthResult> {
    return { status: 'ready', engine: 'fake', runtimeVersion: 'test', latencyMs: 4 }
  }

  async convertFile(input: ConvertFileInput): Promise<ConversionResult> {
    this.fileInput = input
    return result
  }
}

function config(root: string, overrides: Partial<Config> = {}): Config {
  const baseline: Config = {
    engine: 'node',
    ocrBackend: 'auto',
    ocrLanguages: ['eng'],
    timeoutMs: 120_000,
    maxFileBytes: 1_000_000,
    enableLocalFiles: true,
    enableRemoteUrls: false,
    allowedLocalRoots: [root],
    allowPrivateUrls: false,
    defaultOcr: true,
    defaultTableMode: 'accurate',
    defaultOutputFormat: 'md',
    maxOutputChars: 32_000,
    debug: false
  }
  return Object.assign({}, baseline, overrides) as Config
}

async function fixture(): Promise<{ root: string, file: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-doc-tools-'))
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
  it('executes and renders the local engine health tool', async () => {
    const tool = createHealthTool(new FakeDocumentEngine())
    const value = await tool.execute({}, execution)
    expect(tool.output.render({}, value as JsonValue)[0]).toMatchObject({ text: expect.stringContaining('Local document engine: fake') })
  })

  it('renders a healthy engine even when optional implementation metadata is absent', async () => {
    const tool = createHealthTool({
      health: async () => ({ status: 'ready', latencyMs: 1 }),
      convertFile: async () => result
    })
    const value = await tool.execute({}, execution)
    expect(tool.output.render({}, value as JsonValue)[0]).toMatchObject({ text: expect.stringContaining('Runtime: unknown') })
  })

  it('reports offline OCR availability and preserves engine error codes from health', async () => {
    const unavailableOcr = createHealthTool({
      health: async () => ({ status: 'ready', latencyMs: 1, ocrAvailable: false, ocrLanguages: [] }),
      convertFile: async () => result
    })
    const value = await unavailableOcr.execute({}, execution)
    expect(unavailableOcr.output.render({}, value as JsonValue)[0]).toMatchObject({ text: expect.stringContaining('OCR: unavailable') })

    const failedHealth = createHealthTool({
      health: async () => { throw documentEngineError('ENGINE_OCR_UNAVAILABLE') },
      convertFile: async () => result
    })
    await expect(failedHealth.execute({}, execution)).rejects.toMatchObject({ code: 'ENGINE_OCR_UNAVAILABLE' })
  })

  it('validates a local path then delegates its byte snapshot with model options', async () => {
    const { root, file } = await fixture()
    const engine = new FakeDocumentEngine()
    const tool = createConvertFileTool(engine, config(root))
    const value = await tool.execute({ path: file, ocr: false, table_mode: 'fast', page_range: [2, 3] }, execution)
    expect(engine.fileInput).toMatchObject({
      file: { name: 'report.md', bytes: expect.any(Uint8Array) },
      options: { outputFormat: 'md', ocr: false, tableMode: 'fast', pageRange: [2, 3] }
    })
    expect(tool.output.render({ path: file }, value as JsonValue)[0]).toMatchObject({ text: expect.stringContaining('Document: report.pdf') })
  })

  it('passes per-request OCR languages to the engine and rejects unsafe identifiers', async () => {
    const { root, file } = await fixture()
    const engine = new FakeDocumentEngine()
    const tool = createConvertFileTool(engine, config(root))
    await tool.execute({ path: file, ocr: true, ocr_languages: ['chi_sim', 'eng'] }, execution)
    expect(engine.fileInput?.options).toMatchObject({ ocr: true, ocrLanguages: ['chi_sim', 'eng'] })
    await expect(tool.execute({ path: file, ocr: true, ocr_languages: [] }, execution)).rejects.toMatchObject({ code: 'DSHDOC_BAD_REQUEST' })
    await expect(tool.execute({ path: file, ocr: true, ocr_languages: ['../eng'] }, execution)).rejects.toMatchObject({ code: 'DSHDOC_BAD_REQUEST' })
    await expect(tool.execute({ path: file, ocr: true, ocr_languages: Array.from({ length: 17 }, () => 'eng') }, execution)).rejects.toMatchObject({ code: 'DSHDOC_BAD_REQUEST' })
  })

  it('routes a forced file source through the local engine', async () => {
    const { root, file } = await fixture()
    const engine = new FakeDocumentEngine()
    const tool = createExtractTool(engine, config(root))
    await tool.execute({ source: file, source_type: 'file' }, execution)
    expect(engine.fileInput?.file.name).toBe('report.md')
  })

  it('rejects remote URLs without passing them to an engine', async () => {
    const urlTool = createConvertUrlTool()
    await expect(urlTool.execute({ url: 'https://example.com/report.pdf' }, execution)).rejects.toMatchObject({ code: 'UNSUPPORTED_URL' })

    const { root } = await fixture()
    const extractTool = createExtractTool(new FakeDocumentEngine(), config(root))
    await expect(extractTool.execute({ source: 'https://example.com/report.pdf' }, execution)).rejects.toMatchObject({ code: 'UNSUPPORTED_URL' })
  })

  it('maps invalid page ranges and disabled local access into stable Harness errors', async () => {
    const { root, file } = await fixture()
    const engine = new FakeDocumentEngine()
    const fileTool = createConvertFileTool(engine, config(root))
    await expect(fileTool.execute({ path: file, page_range: [3, 2] }, execution)).rejects.toMatchObject({ code: 'DSHDOC_BAD_REQUEST' })
    const disabledTool = createExtractTool(engine, config(root, { enableLocalFiles: false }))
    await expect(disabledTool.execute({ source: file }, execution)).rejects.toMatchObject({ code: 'FILE_ACCESS_DENIED' })
  })
})
