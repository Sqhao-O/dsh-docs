import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { XbergNodeClient } from '../../src/engine/xberg-node-client.js'
import type { ConvertFileInput } from '../../src/engine/types.js'
import { mediaTypeForPath } from '../../src/security/local-path.js'
import { generateDocumentFixtures } from '../helpers/document-fixtures.js'

function input(path: string, outputFormat: 'md' | 'text' | 'json' = 'md', ocr = false): Promise<ConvertFileInput> {
  return readFile(path).then(bytes => ({
    file: {
      name: basename(path),
      mediaType: mediaTypeForPath(path),
      size: bytes.byteLength,
      bytes: Uint8Array.from(bytes)
    },
    options: { outputFormat, ocr, tableMode: 'accurate' }
  }))
}

const tessdata = process.env.DSH_DOC_TEST_TESSDATA
  ?? join(process.cwd(), '.dsh-test', 'xberg-spike', 'runtime', 'tessdata')
const ocrIt = existsSync(tessdata) ? it : it.skip

describe('local Xberg N-API engine', () => {
  it('parses generated PDF and OOXML files without a Docling service', async () => {
    const fixtures = await generateDocumentFixtures()
    const debug = vi.fn()
    const engine = new XbergNodeClient({
      timeoutMs: 60_000,
      maxOutputChars: 8_192,
      ocrLanguages: ['eng'],
      ocrBackend: 'auto',
      debug
    })
    try {
      await expect(engine.health()).resolves.toMatchObject({ status: 'ready', engine: 'xberg-node', ocrAvailable: false, ocrLanguages: [] })
      for (const [name, sentinel] of [
        ['pdf', fixtures.sentinels.pdf],
        ['docx', fixtures.sentinels.docx],
        ['xlsx', fixtures.sentinels.xlsx],
        ['pptx', fixtures.sentinels.pptx]
      ] as const) {
        const result = await engine.convertFile(await input(fixtures.file(name)))
        expect(result.markdown).toContain(sentinel)
        expect(result.source).toEqual({ kind: 'file', name: basename(fixtures.file(name)) })
        expect(result.stats.truncated).toBe(false)
      }

      const json = await engine.convertFile(await input(fixtures.file('pdf'), 'json'))
      expect(json.json).toBeDefined()
      expect(json.stats.outputChars).toBe(JSON.stringify(json.json, null, 2).length)

      const text = await engine.convertFile(await input(fixtures.file('pdf'), 'text'))
      expect(text.text).toContain(fixtures.sentinels.pdf)

      const pagedInput = await input(fixtures.file('pdf'))
      const paged = await engine.convertFile({ ...pagedInput, options: { ...pagedInput.options, pageRange: [1, 1] } })
      expect(paged.markdown).toContain(fixtures.sentinels.pdf)
      expect(debug).toHaveBeenCalledWith('Local Xberg conversion completed.', expect.objectContaining({ format: 'pdf' }))
    } finally {
      await fixtures.dispose()
    }
  }, 120_000)

  it('limits model-facing output using the same pretty JSON representation used by the renderer', async () => {
    const fixtures = await generateDocumentFixtures()
    const engine = new XbergNodeClient({
      timeoutMs: 60_000,
      maxOutputChars: 256,
      ocrLanguages: ['eng'],
      ocrBackend: 'auto'
    })
    try {
      const path = `${fixtures.directory}/large.md`
      await writeFile(path, `# Large\n\n${'local Xberg output '.repeat(300)}`)
      const result = await engine.convertFile(await input(path, 'json'))
      expect(result.stats).toMatchObject({ truncated: true })
      expect(result.text).toContain('output was truncated')
      expect(result.text?.length).toBeLessThanOrEqual(256)
    } finally {
      await fixtures.dispose()
    }
  }, 120_000)

  it('validates engine options and input snapshots and honors an already-cancelled call', async () => {
    expect(() => new XbergNodeClient({ timeoutMs: 0, maxOutputChars: 256, ocrLanguages: ['eng'], ocrBackend: 'auto' })).toThrow('runtime')
    expect(() => new XbergNodeClient({ timeoutMs: 1, maxOutputChars: 127, ocrLanguages: ['eng'], ocrBackend: 'auto' })).toThrow('runtime')
    expect(() => new XbergNodeClient({ timeoutMs: 1, maxOutputChars: 256, ocrLanguages: [''], ocrBackend: 'auto' })).toThrow('runtime')
    expect(() => new XbergNodeClient({ timeoutMs: 1, maxOutputChars: 256, ocrLanguages: ['eng'], ocrBackend: 'paddleocr' as never })).toThrow('runtime')

    const engine = new XbergNodeClient({ timeoutMs: 60_000, maxOutputChars: 256, ocrLanguages: ['eng'], ocrBackend: 'auto' })
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(engine.health(cancelled.signal)).rejects.toMatchObject({ code: 'ENGINE_CANCELLED' })
    await expect(engine.convertFile({
      file: { name: '', mediaType: 'text/plain', size: 1, bytes: new Uint8Array([1]) },
      options: { outputFormat: 'md', ocr: false, tableMode: 'fast' }
    })).rejects.toMatchObject({ code: 'ENGINE_INVALID_INPUT' })
    await expect(engine.convertFile({
      file: { name: 'scan.png', mediaType: 'image/png', size: 1, bytes: new Uint8Array([0]) },
      options: { outputFormat: 'md', ocr: true, tableMode: 'fast' }
    })).rejects.toMatchObject({ code: 'ENGINE_OCR_UNAVAILABLE' })
  })

  ocrIt('parses generated images and scanned PDFs with an explicit local Tesseract data directory', async () => {
    const fixtures = await generateDocumentFixtures()
    const engine = new XbergNodeClient({
      timeoutMs: 60_000,
      maxOutputChars: 8_192,
      ocrLanguages: ['eng'],
      ocrBackend: 'tesseract',
      tessdataPath: tessdata
    })
    try {
      for (const name of ['png', 'scannedPdf']) {
      const result = await engine.convertFile(await input(fixtures.file(name), 'md', true))
      expect(result.markdown).toContain(fixtures.sentinels[name])
      expect(result.metadata.ocrUsed).toBe(true)
      await expect(engine.health()).resolves.toMatchObject({ ocrAvailable: true, ocrLanguages: ['eng'] })
      }
    } finally {
      await fixtures.dispose()
    }
  }, 180_000)

  ocrIt('defaults OCR languages to every pack in the pinned tessdata directory', async () => {
    const engine = new XbergNodeClient({
      timeoutMs: 60_000,
      maxOutputChars: 8_192,
      ocrBackend: 'tesseract',
      tessdataPath: tessdata
    })
    const bundled = (await readdir(tessdata))
      .filter(entry => entry.endsWith('.traineddata'))
      .map(entry => entry.slice(0, -'.traineddata'.length))
      .sort()
    await expect(engine.health()).resolves.toMatchObject({ ocrAvailable: true, ocrLanguages: bundled })
  }, 180_000)

  ocrIt('does not retain document-derived OCR cache files', async () => {
    const fixtures = await generateDocumentFixtures()
    const cacheDirectory = await mkdtemp(join(tmpdir(), 'dsh-docling-xberg-cache-'))
    const previousCacheDirectory = process.env.XBERG_CACHE_DIR
    process.env.XBERG_CACHE_DIR = cacheDirectory
    const engine = new XbergNodeClient({
      timeoutMs: 60_000,
      maxOutputChars: 8_192,
      ocrLanguages: ['eng'],
      ocrBackend: 'tesseract',
      tessdataPath: tessdata
    })
    try {
      const result = await engine.convertFile(await input(fixtures.file('png'), 'md', true))
      expect(result.markdown).toContain(fixtures.sentinels.png)
      const entries = await readdir(cacheDirectory, { recursive: true, withFileTypes: true })
      expect(entries.filter(entry => entry.isFile())).toEqual([])
    } finally {
      if (previousCacheDirectory === undefined) delete process.env.XBERG_CACHE_DIR
      else process.env.XBERG_CACHE_DIR = previousCacheDirectory
      await Promise.all([fixtures.dispose(), rm(cacheDirectory, { recursive: true, force: true })])
    }
  }, 180_000)
})
