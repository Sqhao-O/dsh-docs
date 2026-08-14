import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { DoclingHttpClient } from '../../src/docling/client.js'
import { DoclingError } from '../../src/docling/errors.js'

interface MockRequest {
  readonly method: string | undefined
  readonly url: string | undefined
  readonly headers: Record<string, string | string[] | undefined>
  readonly body: string
}

interface MockServer {
  readonly baseUrl: string
  close(): Promise<void>
}

const servers: MockServer[] = []
const temporaryDirectories: string[] = []

async function startServer(handler: (request: MockRequest) => Promise<{ status?: number, body?: string, headers?: Record<string, string> }>): Promise<MockServer> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    await once(request, 'end')
    const result = await handler({ method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString('utf8') })
    response.writeHead(result.status ?? 200, { 'content-type': 'application/json', ...result.headers })
    response.end(result.body ?? JSON.stringify({ status: 'ok' }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as AddressInfo
  const instance = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => { server.close(); await once(server, 'close') }
  }
  servers.push(instance)
  return instance
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

function client(baseUrl: string, overrides: Partial<ConstructorParameters<typeof DoclingHttpClient>[0]> = {}): DoclingHttpClient {
  return new DoclingHttpClient({ baseUrl, timeoutMs: 1_000, maxOutputChars: 512, debug: false, ...overrides })
}

async function sampleFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-docling-client-'))
  temporaryDirectories.push(directory)
  const file = join(directory, 'sample.md')
  await writeFile(file, '# Sample\ncontent')
  return file
}

async function errorCode(action: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await action()
    return undefined
  } catch (error) {
    return error instanceof DoclingError ? error.code : undefined
  }
}

const markdownResponse = JSON.stringify({ document: { md_content: '# Report\n\nHello' }, status: 'success' })

describe('Docling Serve HTTP client', () => {
  it('checks health and sends the documented X-Api-Key header', async () => {
    const server = await startServer(async request => {
      expect(request.method).toBe('GET')
      expect(request.url).toBe('/health')
      expect(request.headers['x-api-key']).toBe('secret')
      return { body: JSON.stringify({ status: 'healthy' }) }
    })
    await expect(client(server.baseUrl, { apiKey: 'secret' }).health()).resolves.toMatchObject({ status: 'healthy', baseUrl: server.baseUrl })
  })

  it('uploads files as multipart with a filename, binary body, and conversion options', async () => {
    const server = await startServer(async request => {
      expect(request.method).toBe('POST')
      expect(request.url).toBe('/v1/convert/file')
      expect(request.headers['content-type']).toContain('multipart/form-data; boundary=')
      expect(request.body).toContain('name="files"; filename="sample.md"')
      expect(request.body).toContain('Content-Type: text/markdown')
      expect(request.body).toContain('# Sample\ncontent')
      expect(request.body).not.toContain('base64')
      expect(request.body).toContain('name="to_formats"')
      expect(request.body).toContain('name="do_ocr"')
      expect(request.body).toContain('name="table_mode"')
      expect(request.body.match(/name="page_range"/g)).toHaveLength(2)
      return { body: markdownResponse }
    })
    const file = await sampleFile()
    const result = await client(server.baseUrl).convertFile({
      file: { path: file, name: 'sample.md', size: 16, mediaType: 'text/markdown' },
      options: { outputFormat: 'md', ocr: true, tableMode: 'accurate', pageRange: [1, 2] }
    })
    expect(result.markdown).toBe('# Report\n\nHello')
  })

  it('uses the v1 source endpoint and JSON source options for URLs', async () => {
    const server = await startServer(async request => {
      expect(request.method).toBe('POST')
      expect(request.url).toBe('/v1/convert/source')
      expect(request.headers['content-type']).toContain('application/json')
      expect(request.headers['x-api-key']).toBe('source-secret')
      expect(JSON.parse(request.body)).toEqual({
        options: { to_formats: ['text'], do_ocr: false, table_mode: 'fast', page_range: [3, 4] },
        http_sources: [{ url: 'https://example.com/report.pdf' }]
      })
      return { body: JSON.stringify({ document: { text_content: 'converted' }, status: 'success' }) }
    })
    await expect(client(server.baseUrl, { apiKey: 'source-secret' }).convertUrl({
      url: 'https://example.com/report.pdf',
      options: { outputFormat: 'text', ocr: false, tableMode: 'fast', pageRange: [3, 4] }
    })).resolves.toMatchObject({ text: 'converted', source: { kind: 'url', url: 'https://example.com/report.pdf' } })
  })

  it.each([
    [401, 'DOCLING_AUTH_FAILED'],
    [400, 'DOCLING_BAD_REQUEST'],
    [500, 'DOCLING_CONVERSION_FAILED'],
    [503, 'DOCLING_UNAVAILABLE']
  ])('maps HTTP %i to %s without exposing response details', async (status, code) => {
    const server = await startServer(async () => ({ status, body: JSON.stringify({ detail: 'private upstream traceback' }) }))
    expect(await errorCode(() => client(server.baseUrl).convertUrl({
      url: 'https://example.com/report.pdf', options: { outputFormat: 'md', ocr: true, tableMode: 'accurate' }
    }))).toBe(code)
  })

  it('maps a timeout, connection failure, and malformed response safely', async () => {
    const slowServer = await startServer(async () => {
      await new Promise(resolve => setTimeout(resolve, 100))
      return { body: markdownResponse }
    })
    expect(await errorCode(() => client(slowServer.baseUrl, { timeoutMs: 10 }).health())).toBe('DOCLING_TIMEOUT')
    expect(await errorCode(() => client('http://127.0.0.1:0').health())).toBe('DOCLING_UNAVAILABLE')
    const malformedServer = await startServer(async () => ({ body: 'not json', headers: { 'content-type': 'text/plain' } }))
    expect(await errorCode(() => client(malformedServer.baseUrl).health())).toBe('DOCLING_CONVERSION_FAILED')
    const unexpectedServer = await startServer(async () => ({ body: JSON.stringify({ document: {} }) }))
    expect(await errorCode(() => client(unexpectedServer.baseUrl).convertUrl({
      url: 'https://example.com/report.pdf', options: { outputFormat: 'md', ocr: true, tableMode: 'accurate' }
    }))).toBe('DOCLING_CONVERSION_FAILED')
  })

  it('truncates oversized Docling output before it becomes a Tool Result', async () => {
    const server = await startServer(async () => ({ body: JSON.stringify({ document: { md_content: '# Big\n\n' + 'x'.repeat(1_000) } }) }))
    const result = await client(server.baseUrl, { maxOutputChars: 256 }).convertUrl({
      url: 'https://example.com/report.pdf', options: { outputFormat: 'md', ocr: true, tableMode: 'accurate' }
    })
    expect(result.stats).toMatchObject({ truncated: true, outputChars: 1_007 })
    expect(result.markdown).toContain('output was truncated')
  })
})
