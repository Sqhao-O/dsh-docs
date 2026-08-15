import { randomUUID } from 'node:crypto'
import { spawn as spawnChildProcess } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { limitText } from '../output/limiter.js'
import { documentEngineError, type DocumentEngineErrorCode } from './errors.js'
import { isJsonValue, type ConversionMetadata, type ConversionResult, type ConvertFileInput, type DocumentEngine, type DocumentSnapshot, type HealthResult } from './types.js'

/**
 * Versioned, one-request-per-process JSON protocol used by Python workers.
 *
 * The request never includes a local path or a remotely fetchable URL. Python
 * only receives an in-memory base64 byte snapshot plus a display name and MIME
 * type. This preserves the Node-side authorization and URL/SSRF boundary.
 */
export const PYTHON_STDIO_PROTOCOL = 'dsh-document-engine/v1'

const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024
const DEFAULT_MAX_OUTPUT_CHARS = 32_000

export interface PythonWorkerProcess {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  kill(signal?: NodeJS.Signals | number): boolean
  once(event: 'error', listener: (error: Error) => void): this
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  removeListener(event: 'error', listener: (error: Error) => void): this
  removeListener(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
}

/** Values exposed to a test double; `shell` is deliberately not configurable. */
export interface PythonWorkerSpawnOptions {
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly shell: false
  readonly stdio: readonly ['pipe', 'pipe', 'pipe']
  readonly windowsHide: true
}

export type PythonWorkerSpawn = (
  command: string,
  args: readonly string[],
  options: PythonWorkerSpawnOptions
) => PythonWorkerProcess

export interface PythonStdioClientOptions {
  /** Absolute embedded-runtime executable, or a trusted command resolved by the host. */
  readonly pythonCommand: string
  /** Interpreter flags inserted before `-m module` / `workerPath`. */
  readonly pythonArgs?: readonly string[]
  /** Python module that implements the protocol, for example `dsh_docparse_worker`. */
  readonly workerModule?: string
  /** Python script that implements the protocol. Mutually exclusive with `workerModule`. */
  readonly workerPath?: string
  /** Worker flags inserted after the module or script path. */
  readonly workerArgs?: readonly string[]
  readonly timeoutMs: number
  /** Bound transport memory before JSON is parsed. Defaults to 32 MiB. */
  readonly maxResponseBytes?: number
  /** Optional model-facing output bound applied after a successful conversion. */
  readonly maxOutputChars?: number
  /** Language packs requested from the managed local runtime. Defaults to every bundled pack. */
  readonly ocrLanguages?: readonly string[]
  readonly ocrBackend?: 'auto' | 'tesseract'
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  /** Dependency injection point for deterministic unit and integration tests. */
  readonly spawn?: PythonWorkerSpawn
  /** Dependency injection point for deterministic protocol tests. */
  readonly requestId?: () => string
}

interface PythonDocument {
  readonly name: string
  readonly media_type: string
  readonly size: number
  readonly bytes_base64: string
}

interface PythonConvertOptions {
  readonly output_format: ConvertFileInput['options']['outputFormat']
  readonly ocr: boolean
  readonly table_mode: ConvertFileInput['options']['tableMode']
  readonly page_range?: readonly [number, number]
  /** Pinned request languages. Omitted requests use the worker's bundled packs. */
  readonly ocr_languages?: readonly string[]
  readonly ocr_backend: 'auto' | 'tesseract'
  readonly timeout_ms: number
  readonly max_output_chars: number
}

interface PythonHealthRequest {
  readonly protocol: typeof PYTHON_STDIO_PROTOCOL
  readonly id: string
  readonly operation: 'health'
}

interface PythonConvertRequest {
  readonly protocol: typeof PYTHON_STDIO_PROTOCOL
  readonly id: string
  readonly operation: 'convert'
  readonly document: PythonDocument
  readonly options: PythonConvertOptions
}

type PythonRequest = PythonHealthRequest | PythonConvertRequest

interface WorkerSuccess {
  readonly id: string
  readonly ok: true
  readonly result: unknown
}

interface WorkerFailure {
  readonly id: string
  readonly ok: false
  readonly error: Readonly<Record<string, unknown>>
}

type WorkerResponse = WorkerSuccess | WorkerFailure

function defaultSpawn(command: string, args: readonly string[], options: PythonWorkerSpawnOptions): PythonWorkerProcess {
  // Node's overload knows the streams are non-null for this stdio tuple, but
  // does not express that through the base ChildProcess return type.
  return spawnChildProcess(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  }) as unknown as PythonWorkerProcess
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined
}

function optionalString(value: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const field = value[key]
  return typeof field === 'string' ? field : undefined
}

function optionalBoolean(value: Readonly<Record<string, unknown>>, key: string): boolean | undefined {
  const field = value[key]
  return typeof field === 'boolean' ? field : undefined
}

function optionalStrings(value: Readonly<Record<string, unknown>>, key: string): string[] | undefined {
  const field = value[key]
  if (field === undefined) return undefined
  if (!Array.isArray(field) || field.some(item => typeof item !== 'string')) {
    throw documentEngineError('ENGINE_PROTOCOL_ERROR')
  }
  return [...field]
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isEngineErrorCode(value: unknown): value is DocumentEngineErrorCode {
  return value === 'ENGINE_INVALID_INPUT'
    || value === 'ENGINE_UNAVAILABLE'
    || value === 'ENGINE_RUNTIME_INVALID'
    || value === 'ENGINE_TIMEOUT'
    || value === 'ENGINE_CANCELLED'
    || value === 'ENGINE_PROTOCOL_ERROR'
    || value === 'ENGINE_CONVERSION_FAILED'
    || value === 'ENGINE_UNSUPPORTED_FORMAT'
    || value === 'ENGINE_OCR_UNAVAILABLE'
}

function workerFailure(error: Readonly<Record<string, unknown>>): ReturnType<typeof documentEngineError> {
  const code = error.code
  // Only use a known code. Worker text is intentionally not passed through.
  return documentEngineError(isEngineErrorCode(code) ? code : 'ENGINE_CONVERSION_FAILED')
}

function invalidInput(): ReturnType<typeof documentEngineError> {
  return documentEngineError('ENGINE_INVALID_INPUT')
}

function checkedSnapshot(snapshot: DocumentSnapshot): PythonDocument {
  if (snapshot.name.trim() === ''
    || snapshot.mediaType.trim() === ''
    || !Number.isSafeInteger(snapshot.size)
    || snapshot.size < 0
    || !(snapshot.bytes instanceof Uint8Array)
    || snapshot.size !== snapshot.bytes.byteLength) {
    throw invalidInput()
  }

  // Take one further copy immediately before serialization. A caller can retain
  // its Uint8Array reference, so this makes the exact authorized snapshot sent
  // over stdio independent from mutations after `convert()` begins.
  const bytes = Uint8Array.from(snapshot.bytes)
  return {
    name: snapshot.name,
    media_type: snapshot.mediaType,
    size: bytes.byteLength,
    bytes_base64: Buffer.from(bytes).toString('base64')
  }
}

function checkedPageRange(input: ConvertFileInput): readonly [number, number] | undefined {
  const pageRange = input.options.pageRange
  if (pageRange === undefined) return undefined
  const [first, last] = pageRange
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first) {
    throw invalidInput()
  }
  return pageRange
}

function parseResponse(text: string, expectedId: string): WorkerResponse {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw documentEngineError('ENGINE_PROTOCOL_ERROR')
  }
  const response = asRecord(parsed)
  if (response?.protocol !== PYTHON_STDIO_PROTOCOL || response.id !== expectedId) {
    throw documentEngineError('ENGINE_PROTOCOL_ERROR')
  }
  if (response.ok === true && Object.hasOwn(response, 'result')) {
    return { id: expectedId, ok: true, result: response.result }
  }
  const error = asRecord(response.error)
  if (response.ok === false && error !== undefined) return { id: expectedId, ok: false, error }
  throw documentEngineError('ENGINE_PROTOCOL_ERROR')
}

function metadataFrom(value: unknown): ConversionMetadata {
  if (value === undefined) return {}
  const metadata = asRecord(value)
  if (metadata === undefined) throw documentEngineError('ENGINE_PROTOCOL_ERROR')
  const title = optionalString(metadata, 'title')
  const detectedFormat = optionalString(metadata, 'detected_format')
  const pages = metadata.pages
  if (pages !== undefined && !isNonnegativeSafeInteger(pages)) {
    throw documentEngineError('ENGINE_PROTOCOL_ERROR')
  }
  return {
    ...title === undefined ? {} : { title },
    ...pages === undefined ? {} : { pages },
    ...detectedFormat === undefined ? {} : { detectedFormat }
  }
}

interface WorkerOutputStats {
  readonly outputChars: number
  readonly returnedChars: number
  readonly truncated: boolean
}

function workerOutputStats(value: unknown): WorkerOutputStats | undefined {
  if (value === undefined) return undefined
  const stats = asRecord(value)
  if (stats === undefined
    || !isNonnegativeSafeInteger(stats.output_chars)
    || !isNonnegativeSafeInteger(stats.returned_chars)
    || typeof stats.truncated !== 'boolean'
    || stats.output_chars < stats.returned_chars) {
    throw documentEngineError('ENGINE_PROTOCOL_ERROR')
  }
  return {
    outputChars: stats.output_chars,
    returnedChars: stats.returned_chars,
    truncated: stats.truncated
  }
}

function conversionFromWorker(value: unknown, input: ConvertFileInput, elapsedMs: number): ConversionResult {
  const result = asRecord(value)
  if (result === undefined) throw documentEngineError('ENGINE_PROTOCOL_ERROR')
  const format = optionalString(result, 'format')
  if (format === undefined || format.trim() === '') throw documentEngineError('ENGINE_PROTOCOL_ERROR')

  const metadata = metadataFrom(result.metadata)
  const workerStats = workerOutputStats(result.stats)
  const base = {
    source: { kind: 'file', name: input.file.name },
    format,
    metadata,
    stats: {
      outputChars: 0,
      returnedChars: 0,
      truncated: false,
      elapsedMs: Math.max(0, Math.round(elapsedMs))
    }
  } as const

  if (input.options.outputFormat === 'md') {
    const markdown = optionalString(result, 'markdown')
    if (markdown === undefined) throw documentEngineError('ENGINE_PROTOCOL_ERROR')
    return withStats({ ...base, markdown }, markdown, workerStats)
  }
  if (input.options.outputFormat === 'text') {
    const text = optionalString(result, 'text')
    if (text === undefined) throw documentEngineError('ENGINE_PROTOCOL_ERROR')
    return withStats({ ...base, text }, text, workerStats)
  }
  const json = result.json
  if (json !== undefined && isJsonValue(json)) {
    return withStats({ ...base, json }, JSON.stringify(json, null, 2), workerStats)
  }
  const preview = optionalString(result, 'text')
  if (preview === undefined || workerStats?.truncated !== true) throw documentEngineError('ENGINE_PROTOCOL_ERROR')
  return withStats({ ...base, text: preview }, preview, workerStats)
}

function withStats(
  result: Omit<ConversionResult, 'stats'> & { readonly stats: ConversionResult['stats'] },
  content: string,
  workerStats: WorkerOutputStats | undefined
): ConversionResult {
  return {
    ...result,
    stats: {
      ...result.stats,
      outputChars: workerStats?.outputChars ?? content.length,
      returnedChars: workerStats?.returnedChars ?? content.length,
      truncated: workerStats?.truncated ?? false
    }
  }
}

function bound(result: ConversionResult, maxOutputChars: number | undefined): ConversionResult {
  if (maxOutputChars === undefined) return result
  const content = result.markdown ?? result.text ?? JSON.stringify(result.json, null, 2)
  const limited = limitText(content, maxOutputChars)
  if (!limited.truncated) return result
  const stats = {
    ...result.stats,
    outputChars: limited.originalChars,
    returnedChars: limited.returnedChars,
    truncated: true
  }
  if (result.markdown !== undefined) return { ...result, markdown: limited.text, stats }
  if (result.text !== undefined) return { ...result, text: limited.text, stats }
  // A partial JSON string is not canonical JSON. Preserve the requested output
  // format while returning a safe bounded text preview.
  const { json, ...withoutJson } = result
  void json
  return { ...withoutJson, text: limited.text, stats }
}

function bufferFromChunk(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk
  if (chunk instanceof Uint8Array) return Buffer.from(chunk)
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8')
  return Buffer.from(String(chunk), 'utf8')
}

/**
 * Launches one isolated Python worker for each request. It intentionally uses
 * `shell: false`, sends no path or URL, and kills the process on timeout or
 * cancellation. A later pooled implementation can implement DocumentEngine
 * without changing callers or this protocol's document-byte invariant.
 */
export class PythonStdioClient implements DocumentEngine {
  private readonly spawn: PythonWorkerSpawn
  private readonly commandArgs: readonly string[]
  private readonly requestId: () => string
  private readonly maxResponseBytes: number
  private readonly maxOutputChars: number

  constructor(private readonly options: PythonStdioClientOptions) {
    if (options.pythonCommand.trim() === ''
      || (options.workerModule === undefined && options.workerPath === undefined)
      || (options.workerModule !== undefined && options.workerPath !== undefined)
      || (options.workerModule !== undefined && options.workerModule.trim() === '')
      || (options.workerPath !== undefined && options.workerPath.trim() === '')
      || !Number.isSafeInteger(options.timeoutMs)
      || options.timeoutMs < 1) {
      throw documentEngineError('ENGINE_RUNTIME_INVALID')
    }
    if (options.maxResponseBytes !== undefined
      && (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes < 1)) {
      throw documentEngineError('ENGINE_RUNTIME_INVALID')
    }
    if (options.maxOutputChars !== undefined
      && (!Number.isSafeInteger(options.maxOutputChars) || options.maxOutputChars < 128)) {
      throw documentEngineError('ENGINE_RUNTIME_INVALID')
    }
    if (options.ocrLanguages !== undefined
      && (options.ocrLanguages.length === 0 || options.ocrLanguages.some(language => language.trim() === ''))) {
      throw documentEngineError('ENGINE_RUNTIME_INVALID')
    }
    this.spawn = options.spawn ?? defaultSpawn
    this.requestId = options.requestId ?? randomUUID
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
    this.maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS
    this.commandArgs = [
      '-u',
      ...(options.pythonArgs ?? []),
      ...(options.workerModule === undefined ? [options.workerPath as string] : ['-m', options.workerModule]),
      ...(options.workerArgs ?? [])
    ]
  }

  async health(signal?: AbortSignal): Promise<HealthResult> {
    const startedAt = performance.now()
    const result = await this.request({ operation: 'health' }, signal)
    const health = asRecord(result)
    if (health === undefined) throw documentEngineError('ENGINE_PROTOCOL_ERROR')
    const status = optionalString(health, 'status')
    if (status === undefined || status.trim() === '') throw documentEngineError('ENGINE_PROTOCOL_ERROR')
    const engine = optionalString(health, 'engine')
    const runtimeVersion = optionalString(health, 'runtime_version')
    const workerOcrAvailable = optionalBoolean(health, 'ocr_available')
    const workerOcrLanguages = optionalStrings(health, 'ocr_languages')
    const expectedOcrLanguages = this.options.ocrLanguages
    const ocrAvailable = workerOcrAvailable === undefined
      ? undefined
      : workerOcrAvailable
        && (expectedOcrLanguages === undefined || expectedOcrLanguages.every(language => workerOcrLanguages?.includes(language)))
    return {
      status,
      ...engine === undefined ? {} : { engine },
      ...runtimeVersion === undefined ? {} : { runtimeVersion },
      ...ocrAvailable === undefined ? {} : { ocrAvailable },
      ...workerOcrLanguages === undefined ? {} : { ocrLanguages: workerOcrLanguages },
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt))
    }
  }

  async convertFile(input: ConvertFileInput): Promise<ConversionResult> {
    const startedAt = performance.now()
    const document = checkedSnapshot(input.file)
    const pageRange = checkedPageRange(input)
    const result = await this.request({
      operation: 'convert',
      document,
      options: {
        output_format: input.options.outputFormat,
        ocr: input.options.ocr,
        table_mode: input.options.tableMode,
        ...(this.options.ocrLanguages === undefined ? {} : { ocr_languages: [...this.options.ocrLanguages] }),
        ocr_backend: this.options.ocrBackend ?? 'auto',
        timeout_ms: this.options.timeoutMs,
        max_output_chars: this.maxOutputChars,
        ...(pageRange === undefined ? {} : { page_range: pageRange })
      }
    }, input.signal)
    return bound(conversionFromWorker(result, input, performance.now() - startedAt), this.maxOutputChars)
  }

  private async request(
    input: Omit<PythonConvertRequest, 'protocol' | 'id'> | Omit<PythonHealthRequest, 'protocol' | 'id'>,
    signal: AbortSignal | undefined
  ): Promise<unknown> {
    if (signal?.aborted === true) throw documentEngineError('ENGINE_CANCELLED')
    const id = this.requestId()
    if (id.trim() === '') throw documentEngineError('ENGINE_RUNTIME_INVALID')
    const request: PythonRequest = input.operation === 'health'
      ? { protocol: PYTHON_STDIO_PROTOCOL, id, operation: 'health' }
      : { protocol: PYTHON_STDIO_PROTOCOL, id, ...input }
    return this.run(request, signal)
  }

  private run(request: PythonRequest, signal: AbortSignal | undefined): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let child: PythonWorkerProcess | undefined
      let settled = false
      let stdoutBytes = 0
      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []

      const removeListeners = (): void => {
        if (child === undefined) return
        child.removeListener('error', onChildError)
        child.removeListener('close', onClose)
        child.stdin.removeListener('error', onStdinError)
        child.stdout.removeListener('error', onStdoutError)
        signal?.removeEventListener('abort', onAbort)
      }
      const stopChild = (): void => {
        try {
          child?.kill('SIGTERM')
        } catch {
          // A process can exit between completion and kill; either outcome is safe.
        }
      }
      const finish = (error: Error | undefined, value?: unknown, terminate = false): void => {
        if (settled) return
        settled = true
        clearTimeout(timeoutId)
        removeListeners()
        if (terminate) stopChild()
        if (error !== undefined) reject(error)
        else resolve(value)
      }
      const onAbort = (): void => finish(documentEngineError('ENGINE_CANCELLED'), undefined, true)
      const onChildError = (): void => finish(documentEngineError('ENGINE_UNAVAILABLE'), undefined, true)
      const onStdinError = (): void => finish(documentEngineError('ENGINE_UNAVAILABLE'), undefined, true)
      const onStdoutError = (): void => finish(documentEngineError('ENGINE_PROTOCOL_ERROR'), undefined, true)
      const onStdoutData = (chunk: unknown): void => {
        const buffer = bufferFromChunk(chunk)
        stdoutBytes += buffer.byteLength
        if (stdoutBytes > this.maxResponseBytes) {
          finish(documentEngineError('ENGINE_PROTOCOL_ERROR'), undefined, true)
          return
        }
        stdoutChunks.push(buffer)
      }
      const onStderrData = (chunk: unknown): void => {
        // Drain stderr to avoid a child-process deadlock. Never include it in an
        // error, because it can contain local paths, tracebacks, or document data.
        if (stderrChunks.reduce((total, item) => total + item.byteLength, 0) < 8 * 1024) {
          stderrChunks.push(bufferFromChunk(chunk))
        }
      }
      const onClose = (exitCode: number | null): void => {
        const output = Buffer.concat(stdoutChunks).toString('utf8').trim()
        if (output === '') {
          finish(documentEngineError(exitCode === 0 ? 'ENGINE_PROTOCOL_ERROR' : 'ENGINE_CONVERSION_FAILED'))
          return
        }
        let response: WorkerResponse
        try {
          response = parseResponse(output, request.id)
        } catch (error) {
          finish(error instanceof Error ? error : documentEngineError('ENGINE_PROTOCOL_ERROR'))
          return
        }
        if (!response.ok) {
          finish(workerFailure(response.error))
          return
        }
        if (exitCode !== 0) {
          finish(documentEngineError('ENGINE_CONVERSION_FAILED'))
          return
        }
        finish(undefined, response.result)
      }
      const timeoutId = setTimeout(() => finish(documentEngineError('ENGINE_TIMEOUT'), undefined, true), this.options.timeoutMs)

      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        child = this.spawn(this.options.pythonCommand, this.commandArgs, {
          ...this.options.cwd === undefined ? {} : { cwd: this.options.cwd },
          ...this.options.env === undefined ? {} : { env: this.options.env },
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        })
        child.once('error', onChildError)
        child.once('close', onClose)
        child.stdin.once('error', onStdinError)
        child.stdout.once('error', onStdoutError)
        child.stdout.on('data', onStdoutData)
        child.stderr.on('data', onStderrData)
        if (signal?.aborted === true) {
          onAbort()
          return
        }
        child.stdin.end(`${JSON.stringify(request)}\n`, 'utf8')
      } catch {
        finish(documentEngineError('ENGINE_UNAVAILABLE'), undefined, true)
      }
    })
  }
}
