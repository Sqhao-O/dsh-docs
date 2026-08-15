import { existsSync } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PythonStdioClient } from '../../src/engine/python-stdio-client.js'
import type { ConvertFileInput } from '../../src/engine/types.js'
import { mediaTypeForPath } from '../../src/security/local-path.js'
import { generateDocumentFixtures } from '../helpers/document-fixtures.js'

const python = process.env.DSH_DOC_TEST_PYTHON
  ?? join(process.cwd(), '.dsh-test', 'xberg-spike', 'venv', 'Scripts', 'python.exe')
const tessdata = process.env.DSH_DOC_TEST_TESSDATA
  ?? join(process.cwd(), '.dsh-test', 'xberg-spike', 'runtime', 'tessdata')
const workerPath = process.env.DSH_DOC_TEST_WORKER
  ?? join(process.cwd(), 'python', 'worker.py')
const canRunPythonRuntime = existsSync(python) && existsSync(tessdata) && existsSync(workerPath)

function input(path: string, ocr = false): Promise<ConvertFileInput> {
  return readFile(path).then(bytes => ({
    file: {
      name: basename(path),
      mediaType: mediaTypeForPath(path),
      size: bytes.byteLength,
      bytes: Uint8Array.from(bytes)
    },
    options: { outputFormat: 'md', ocr, tableMode: 'accurate' }
  }))
}

async function nestedFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    const descendants = await Promise.all(entries.map(async entry => entry.isDirectory()
      ? nestedFiles(join(directory, entry.name))
      : [join(directory, entry.name)]))
    return descendants.flat()
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
}

const pythonIt = canRunPythonRuntime ? it : it.skip
const chineseOcrIt = canRunPythonRuntime && process.platform === 'win32' ? it : it.skip

describe('embedded Python Xberg stdio engine', () => {
  pythonIt('uses the versioned bytes-only protocol to parse real local documents', async () => {
    const fixtures = await generateDocumentFixtures()
    const engine = new PythonStdioClient({
      pythonCommand: python,
      pythonArgs: ['-I', '-s'],
      workerPath,
      timeoutMs: 60_000,
      maxOutputChars: 8_192,
      ocrLanguages: ['eng'],
      ocrBackend: 'tesseract',
      env: {
        ...process.env,
        DSH_DOC_TESSDATA_PATH: tessdata,
        TESSDATA_PREFIX: tessdata,
        XBERG_CACHE_DIR: join(fixtures.directory, 'xberg-cache'),
        HF_HUB_OFFLINE: '1',
        HUGGINGFACE_HUB_OFFLINE: '1'
      }
    })
    try {
      await expect(engine.health()).resolves.toMatchObject({ status: 'ready', engine: 'xberg-python', runtimeVersion: '1.0.14' })
      for (const [name, sentinel] of [
        ['pdf', fixtures.sentinels.pdf],
        ['docx', fixtures.sentinels.docx],
        ['xlsx', fixtures.sentinels.xlsx],
        ['pptx', fixtures.sentinels.pptx]
      ] as const) {
        const result = await engine.convertFile(await input(fixtures.file(name)))
        expect(result.markdown).toContain(sentinel)
        expect(result.metadata.detectedFormat).toBeDefined()
      }
      const pagedInput = await input(fixtures.file('pdf'))
      const paged = await engine.convertFile({ ...pagedInput, options: { ...pagedInput.options, pageRange: [1, 1] } })
      expect(paged.markdown).toContain(fixtures.sentinels.pdf)
    } finally {
      await fixtures.dispose()
    }
  }, 180_000)

  pythonIt('bounds worker output before the stdio response reaches the parent', async () => {
    const fixtures = await generateDocumentFixtures()
    const largeDocument = join(fixtures.directory, 'large.md')
    await writeFile(largeDocument, `# Large\n\n${'bytes-only local parser output '.repeat(4_000)}`)
    const engine = new PythonStdioClient({
      pythonCommand: python,
      pythonArgs: ['-I', '-s'],
      workerPath,
      timeoutMs: 60_000,
      // The complete document is far larger than this transport cap. Passing
      // proves worker-side truncation happens before stdout serialization.
      maxResponseBytes: 1_024,
      maxOutputChars: 256,
      ocrLanguages: ['eng'],
      ocrBackend: 'tesseract',
      env: {
        ...process.env,
        DSH_DOC_TESSDATA_PATH: tessdata,
        TESSDATA_PREFIX: tessdata,
        XBERG_CACHE_DIR: join(fixtures.directory, 'xberg-cache'),
        HF_HUB_OFFLINE: '1',
        HUGGINGFACE_HUB_OFFLINE: '1'
      }
    })
    try {
      const result = await engine.convertFile(await input(largeDocument))
      expect(result.markdown).toContain('output was truncated')
      expect(result.stats).toMatchObject({ truncated: true })
      expect(result.stats.returnedChars).toBeLessThanOrEqual(256)
      expect(result.stats.outputChars).toBeGreaterThan(result.stats.returnedChars)
    } finally {
      await fixtures.dispose()
    }
  }, 180_000)

  pythonIt('keeps the native text layer of a searchable PDF when OCR is enabled', async () => {
    const fixtures = await generateDocumentFixtures()
    const engine = new PythonStdioClient({
      pythonCommand: python,
      pythonArgs: ['-I', '-s'],
      workerPath,
      timeoutMs: 60_000,
      maxOutputChars: 8_192,
      ocrLanguages: ['eng'],
      ocrBackend: 'tesseract',
      env: {
        ...process.env,
        DSH_DOC_TESSDATA_PATH: tessdata,
        TESSDATA_PREFIX: tessdata,
        XBERG_CACHE_DIR: join(fixtures.directory, 'xberg-cache'),
        HF_HUB_OFFLINE: '1',
        HUGGINGFACE_HUB_OFFLINE: '1'
      }
    })
    try {
      const withoutOcr = await engine.convertFile(await input(fixtures.file('pdf'), false))
      const withOcr = await engine.convertFile(await input(fixtures.file('pdf'), true))
      expect(withOcr.markdown).toContain(fixtures.sentinels.pdf)
      // OCR must not replace a healthy embedded text layer with a lossy
      // Tesseract rendering; both paths extract the same native text.
      expect(withOcr.markdown).toBe(withoutOcr.markdown)
      // ocrUsed reports whether the OCR pipeline contributed anywhere (for
      // example embedded images), not whether it replaced the text layer.
      expect(withoutOcr.metadata.ocrUsed).toBe(false)
      expect(typeof withOcr.metadata.ocrUsed).toBe('boolean')
    } finally {
      await fixtures.dispose()
    }
  }, 180_000)

  pythonIt('uses only bundled Tesseract language data for image and scanned-PDF OCR', async () => {
    const fixtures = await generateDocumentFixtures()
    const cache = join(fixtures.directory, 'offline-xberg-cache')
    const engine = new PythonStdioClient({
      pythonCommand: python,
      pythonArgs: ['-I', '-s'],
      workerPath,
      timeoutMs: 60_000,
      maxOutputChars: 8_192,
      ocrLanguages: ['eng'],
      ocrBackend: 'tesseract',
      env: {
        ...process.env,
        DSH_DOC_TESSDATA_PATH: tessdata,
        TESSDATA_PREFIX: tessdata,
        XBERG_CACHE_DIR: cache,
        HF_HUB_OFFLINE: '1',
        HUGGINGFACE_HUB_OFFLINE: '1'
      }
    })
    try {
      for (const name of ['png', 'scannedPdf']) {
        const result = await engine.convertFile(await input(fixtures.file(name), true))
        expect(result.markdown).toContain(fixtures.sentinels[name])
        expect(result.metadata.ocrUsed).toBe(true)
      }
      expect(await nestedFiles(cache)).toEqual([])
    } finally {
      await fixtures.dispose()
    }
  }, 180_000)

  chineseOcrIt('uses the bundled chi_sim language pack without a network fallback', async () => {
    const fixtures = await generateDocumentFixtures()
    const cache = join(fixtures.directory, 'offline-chinese-xberg-cache')
    const engine = new PythonStdioClient({
      pythonCommand: python,
      pythonArgs: ['-I', '-s'],
      workerPath,
      timeoutMs: 60_000,
      maxOutputChars: 8_192,
      ocrLanguages: ['chi_sim'],
      ocrBackend: 'tesseract',
      env: {
        ...process.env,
        DSH_DOC_TESSDATA_PATH: tessdata,
        TESSDATA_PREFIX: tessdata,
        XBERG_CACHE_DIR: cache,
        HF_HUB_OFFLINE: '1',
        HUGGINGFACE_HUB_OFFLINE: '1'
      }
    })
    try {
      const result = await engine.convertFile(await input(fixtures.file('chinesePng'), true))
      // Tesseract fast can insert spaces or make a minor glyph mistake on
      // complex Chinese headings, so assert robust Chinese/numeric evidence
      // rather than promising document-quality accuracy in a smoke test.
      const compact = result.markdown?.replace(/\s/g, '') ?? ''
      expect(compact).toContain('中文')
      expect(compact).toContain('128')
      expect(await nestedFiles(cache)).toEqual([])
    } finally {
      await fixtures.dispose()
    }
  }, 180_000)

  chineseOcrIt('defaults to every bundled language pack when none are configured', async () => {
    const fixtures = await generateDocumentFixtures()
    const engine = new PythonStdioClient({
      pythonCommand: python,
      pythonArgs: ['-I', '-s'],
      workerPath,
      timeoutMs: 60_000,
      maxOutputChars: 8_192,
      ocrBackend: 'tesseract',
      env: {
        ...process.env,
        DSH_DOC_TESSDATA_PATH: tessdata,
        TESSDATA_PREFIX: tessdata,
        XBERG_CACHE_DIR: join(fixtures.directory, 'default-languages-cache'),
        HF_HUB_OFFLINE: '1',
        HUGGINGFACE_HUB_OFFLINE: '1'
      }
    })
    try {
      await expect(engine.health()).resolves.toMatchObject({ ocrAvailable: true })
      // chi_sim is bundled but was never configured; the default language set
      // must still recognize the Chinese fixture.
      const result = await engine.convertFile(await input(fixtures.file('chinesePng'), true))
      const compact = result.markdown?.replace(/\s/g, '') ?? ''
      expect(compact).toContain('中文')
    } finally {
      await fixtures.dispose()
    }
  }, 180_000)

  chineseOcrIt('honors a per-request ocr_languages override', async () => {
    const fixtures = await generateDocumentFixtures()
    const engine = new PythonStdioClient({
      pythonCommand: python,
      pythonArgs: ['-I', '-s'],
      workerPath,
      timeoutMs: 60_000,
      maxOutputChars: 8_192,
      ocrLanguages: ['eng'],
      ocrBackend: 'tesseract',
      env: {
        ...process.env,
        DSH_DOC_TESSDATA_PATH: tessdata,
        TESSDATA_PREFIX: tessdata,
        XBERG_CACHE_DIR: join(fixtures.directory, 'override-languages-cache'),
        HF_HUB_OFFLINE: '1',
        HUGGINGFACE_HUB_OFFLINE: '1'
      }
    })
    try {
      // The client is configured eng-only; the request pins chi_sim instead.
      const pngInput = await input(fixtures.file('chinesePng'), true)
      const result = await engine.convertFile({ ...pngInput, options: { ...pngInput.options, ocrLanguages: ['chi_sim'] } })
      const compact = result.markdown?.replace(/\s/g, '') ?? ''
      expect(compact).toContain('中文')
    } finally {
      await fixtures.dispose()
    }
  }, 180_000)
})
