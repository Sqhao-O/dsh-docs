import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PythonStdioClient, PYTHON_STDIO_PROTOCOL } from '../../src/engine/python-stdio-client.js'
import type { ConvertFileInput } from '../../src/engine/types.js'
import type { PythonWorkerProcess, PythonWorkerSpawn, PythonWorkerSpawnOptions } from '../../src/engine/python-stdio-client.js'

class FakeWorker extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  killed = false

  kill(): boolean {
    this.killed = true
    return true
  }

  close(code: number | null = 0): void {
    this.emit('close', code, null)
  }
}

type Request = Readonly<Record<string, unknown>>
type Responder = (worker: FakeWorker, request: Request) => void

function spawnWith(responder: Responder, observed?: { command?: string, args?: readonly string[], options?: PythonWorkerSpawnOptions }): PythonWorkerSpawn {
  return (command, args, options) => {
    // Preserve observable fields without making tests depend on a real process.
    if (observed !== undefined) {
      observed.command = command
      observed.args = args
      observed.options = options
    }
    const worker = new FakeWorker()
    const chunks: Buffer[] = []
    worker.stdin.on('data', chunk => chunks.push(Buffer.from(chunk)))
    worker.stdin.once('finish', () => {
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Request
      responder(worker, request)
    })
    return worker as unknown as PythonWorkerProcess
  }
}

function response(worker: FakeWorker, request: Request, result: unknown, code = 0): void {
  queueMicrotask(() => {
    worker.stdout.write(JSON.stringify({ protocol: PYTHON_STDIO_PROTOCOL, id: request.id, ok: true, result }))
    worker.close(code)
  })
}

function failure(worker: FakeWorker, request: Request, code: string): void {
  queueMicrotask(() => {
    worker.stdout.write(JSON.stringify({ protocol: PYTHON_STDIO_PROTOCOL, id: request.id, ok: false, error: { code } }))
    worker.close(0)
  })
}

function input(outputFormat: 'md' | 'text' | 'json' = 'md'): ConvertFileInput {
  return {
    file: { name: 'report.pdf', mediaType: 'application/pdf', size: 5, bytes: new Uint8Array([1, 2, 3, 4, 5]) },
    options: { outputFormat, ocr: true, tableMode: 'accurate', pageRange: [1, 2] }
  }
}

function client(responder: Responder, overrides: Partial<ConstructorParameters<typeof PythonStdioClient>[0]> = {}, observed?: { command?: string, args?: readonly string[], options?: PythonWorkerSpawnOptions }): PythonStdioClient {
  return new PythonStdioClient({
    pythonCommand: 'embedded-python',
    pythonArgs: ['-I', '-s'],
    workerPath: 'worker.py',
    timeoutMs: 1_000,
    maxOutputChars: 8_192,
    ocrLanguages: ['eng', 'chi_sim'],
    ocrBackend: 'tesseract',
    requestId: () => 'request-1',
    spawn: spawnWith(responder, observed),
    ...overrides
  })
}

afterEach(() => vi.useRealTimers())

describe('PythonStdioClient protocol boundary', () => {
  it('sends a bytes-only conversion request and maps a worker Markdown result', async () => {
    let request: Request | undefined
    const observed: { command?: string, args?: readonly string[], options?: PythonWorkerSpawnOptions } = {}
    const engine = client((worker, received) => {
      request = received
      response(worker, received, {
        format: 'pdf',
        metadata: { title: 'Report', pages: 2, detected_format: 'application/pdf' },
        markdown: '# Parsed\n\nSafe content'
      })
    }, {}, observed)

    const result = await engine.convertFile(input())
    expect(result).toMatchObject({ markdown: '# Parsed\n\nSafe content', metadata: { title: 'Report', pages: 2, detectedFormat: 'application/pdf' } })
    expect(request).toMatchObject({
      protocol: PYTHON_STDIO_PROTOCOL,
      id: 'request-1',
      operation: 'convert',
      document: { name: 'report.pdf', media_type: 'application/pdf', size: 5, bytes_base64: 'AQIDBAU=' },
      options: { output_format: 'md', ocr: true, table_mode: 'accurate', page_range: [1, 2], ocr_languages: ['eng', 'chi_sim'], ocr_backend: 'tesseract', timeout_ms: 1_000, max_output_chars: 8_192 }
    })
    expect(JSON.stringify(request)).not.toContain('path')
    expect(observed).toMatchObject({ command: 'embedded-python', args: ['-u', '-I', '-s', 'worker.py'], options: { shell: false, windowsHide: true } })
  })

  it('omits ocr_languages from the request when none are configured', async () => {
    let request: Request | undefined
    const engine = new PythonStdioClient({
      pythonCommand: 'embedded-python',
      workerPath: 'worker.py',
      timeoutMs: 1_000,
      maxOutputChars: 8_192,
      requestId: () => 'request-1',
      spawn: spawnWith((worker, received) => {
        request = received
        response(worker, received, { format: 'pdf', metadata: {}, markdown: 'ok' })
      })
    })

    await engine.convertFile(input())
    const options = request?.options as Record<string, unknown>
    expect('ocr_languages' in options).toBe(false)
  })

  it('maps health, text, JSON, and bounded JSON previews from well-formed responses', async () => {
    const health = client((worker, request) => response(worker, request, {
      status: 'ready',
      engine: 'xberg-python',
      runtime_version: '1.0.14',
      ocr_available: true,
      ocr_languages: ['eng', 'chi_sim']
    }))
    await expect(health.health()).resolves.toMatchObject({
      status: 'ready',
      engine: 'xberg-python',
      runtimeVersion: '1.0.14',
      ocrAvailable: true,
      ocrLanguages: ['eng', 'chi_sim']
    })

    const missingLanguage = client((worker, request) => response(worker, request, {
      status: 'ready',
      ocr_available: true,
      ocr_languages: ['eng']
    }))
    await expect(missingLanguage.health()).resolves.toMatchObject({ ocrAvailable: false, ocrLanguages: ['eng'] })

    const text = client((worker, request) => response(worker, request, { format: 'pdf', metadata: {}, text: 'plain text' }))
    await expect(text.convertFile(input('text'))).resolves.toMatchObject({ text: 'plain text' })

    const json = client((worker, request) => response(worker, request, { format: 'pdf', metadata: {}, json: { title: 'Parsed', items: [1, 2] } }))
    await expect(json.convertFile(input('json'))).resolves.toMatchObject({ json: { title: 'Parsed', items: [1, 2] } })

    const limited = client((worker, request) => response(worker, request, { format: 'pdf', metadata: {}, json: { nested: { value: 'x'.repeat(400) } } }), { maxOutputChars: 256 })
    const result = await limited.convertFile(input('json'))
    expect(result).toMatchObject({ text: expect.stringContaining('output was truncated'), stats: { truncated: true } })
    expect(result.text?.length).toBeLessThanOrEqual(256)
  })

  it('maps worker failures and malformed responses to safe engine errors', async () => {
    const unsupported = client((worker, request) => failure(worker, request, 'ENGINE_UNSUPPORTED_FORMAT'))
    await expect(unsupported.convertFile(input())).rejects.toMatchObject({ code: 'ENGINE_UNSUPPORTED_FORMAT' })

    const malformed = client((worker) => queueMicrotask(() => {
      worker.stdout.write('{ not-json')
      worker.close(0)
    }))
    await expect(malformed.health()).rejects.toMatchObject({ code: 'ENGINE_PROTOCOL_ERROR' })

    const mismatched = client((worker) => queueMicrotask(() => {
      worker.stdout.write(JSON.stringify({ protocol: 'wrong', id: 'request-1', ok: true, result: {} }))
      worker.close(0)
    }))
    await expect(mismatched.health()).rejects.toMatchObject({ code: 'ENGINE_PROTOCOL_ERROR' })

    const unknownFailure = client((worker, request) => failure(worker, request, 'private-worker-code'))
    await expect(unknownFailure.convertFile(input())).rejects.toMatchObject({ code: 'ENGINE_CONVERSION_FAILED' })
  })

  it('rejects incomplete worker payloads without reflecting worker data', async () => {
    const missingStatus = client((worker, request) => response(worker, request, { engine: 'xberg-python' }))
    await expect(missingStatus.health()).rejects.toMatchObject({ code: 'ENGINE_PROTOCOL_ERROR' })

    const missingMarkdown = client((worker, request) => response(worker, request, { format: 'pdf', metadata: {} }))
    await expect(missingMarkdown.convertFile(input())).rejects.toMatchObject({ code: 'ENGINE_PROTOCOL_ERROR' })

    const unsafeMetadata = client((worker, request) => response(worker, request, { format: 'pdf', metadata: 'private path', markdown: 'ok' }))
    await expect(unsafeMetadata.convertFile(input())).rejects.toMatchObject({ code: 'ENGINE_PROTOCOL_ERROR' })

    const invalidPages = client((worker, request) => response(worker, request, { format: 'pdf', metadata: { pages: -1 }, markdown: 'ok' }))
    await expect(invalidPages.convertFile(input())).rejects.toMatchObject({ code: 'ENGINE_PROTOCOL_ERROR' })

    const missingJson = client((worker, request) => response(worker, request, { format: 'pdf', metadata: {} }))
    await expect(missingJson.convertFile(input('json'))).rejects.toMatchObject({ code: 'ENGINE_PROTOCOL_ERROR' })
  })

  it('bounds Markdown and text results and supports module worker invocation', async () => {
    const markdown = client((worker, request) => response(worker, request, { format: 'pdf', markdown: 'x'.repeat(512) }), { maxOutputChars: 256 })
    await expect(markdown.convertFile(input())).resolves.toMatchObject({ markdown: expect.stringContaining('output was truncated'), stats: { truncated: true } })

    const text = client((worker, request) => response(worker, request, { format: 'pdf', text: 'x'.repeat(512) }), { maxOutputChars: 256 })
    await expect(text.convertFile(input('text'))).resolves.toMatchObject({ text: expect.stringContaining('output was truncated'), stats: { truncated: true } })

    const observed: { args?: readonly string[] } = {}
    const module = new PythonStdioClient({
      pythonCommand: 'embedded-python',
      workerModule: 'dsh_worker',
      workerArgs: ['--offline'],
      timeoutMs: 1_000,
      requestId: () => 'request-1',
      cwd: 'runtime',
      env: { TEST: '1' },
      spawn: spawnWith((worker, request) => response(worker, request, { status: 'ready' }), observed)
    })
    await expect(module.health()).resolves.toMatchObject({ status: 'ready' })
    expect(observed.args).toEqual(['-u', '-m', 'dsh_worker', '--offline'])
  })

  it('rejects invalid snapshots, cancels early, and terminates workers for transport failures', async () => {
    const neverCalled = vi.fn<Responder>()
    const engine = client(neverCalled)
    await expect(engine.convertFile({ ...input(), file: { ...input().file, size: 6 } })).rejects.toMatchObject({ code: 'ENGINE_INVALID_INPUT' })
    await expect(engine.convertFile({ ...input(), options: { ...input().options, pageRange: [2, 1] } })).rejects.toMatchObject({ code: 'ENGINE_INVALID_INPUT' })
    expect(neverCalled).not.toHaveBeenCalled()

    const controller = new AbortController()
    controller.abort()
    await expect(engine.health(controller.signal)).rejects.toMatchObject({ code: 'ENGINE_CANCELLED' })

    let oversizedWorker: FakeWorker | undefined
    const oversized = client((worker) => {
      oversizedWorker = worker
      queueMicrotask(() => worker.stdout.write('x'.repeat(1_024)))
    }, { maxResponseBytes: 32 })
    await expect(oversized.health()).rejects.toMatchObject({ code: 'ENGINE_PROTOCOL_ERROR' })
    expect(oversizedWorker?.killed).toBe(true)
  })

  it('enforces constructor invariants and converts child errors, abnormal exits, and timeouts safely', async () => {
    expect(() => new PythonStdioClient({ pythonCommand: '', workerPath: 'worker.py', timeoutMs: 1_000 })).toThrow('runtime')
    expect(() => new PythonStdioClient({ pythonCommand: 'python', workerPath: 'worker.py', workerModule: 'worker', timeoutMs: 1_000 })).toThrow('runtime')
    expect(() => new PythonStdioClient({ pythonCommand: 'python', workerPath: 'worker.py', timeoutMs: 1_000, ocrLanguages: [] })).toThrow('runtime')

    const childError = client(worker => queueMicrotask(() => worker.emit('error', new Error('private path'))))
    await expect(childError.health()).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' })

    const abnormal = client(worker => queueMicrotask(() => {
      worker.stdout.write(JSON.stringify({ protocol: PYTHON_STDIO_PROTOCOL, id: 'request-1', ok: true, result: { status: 'ready' } }))
      worker.close(1)
    }))
    await expect(abnormal.health()).rejects.toMatchObject({ code: 'ENGINE_CONVERSION_FAILED' })

    vi.useFakeTimers()
    let timedWorker: FakeWorker | undefined
    const timeout = client(worker => { timedWorker = worker }, { timeoutMs: 10 })
    const pending = timeout.health()
    const rejected = expect(pending).rejects.toMatchObject({ code: 'ENGINE_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(10)
    await rejected
    expect(timedWorker?.killed).toBe(true)
  })
})
