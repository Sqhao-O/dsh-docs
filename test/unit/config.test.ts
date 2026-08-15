import { parse, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Config, DEFAULT_ENGINE, DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_OUTPUT_CHARS, DEFAULT_TIMEOUT_MS, resolveConfig } from '../../src/config.js'
import type { Config as PluginConfig } from '../../src/config.js'

function schemaInput(values: Record<string, unknown>): PluginConfig {
  return values as unknown as PluginConfig
}

describe('plugin configuration', () => {
  it('applies local-engine defaults through Schemastery', () => {
    const config = new Config(schemaInput({}))
    expect(config.engine).toBe(DEFAULT_ENGINE)
    expect(config.timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
    expect(config.maxFileBytes).toBe(DEFAULT_MAX_FILE_BYTES)
    expect(config.maxOutputChars).toBe(DEFAULT_MAX_OUTPUT_CHARS)
    expect(config.ocrLanguages).toBeUndefined()
    expect(config.enableRemoteUrls).toBe(false)
    expect(config.allowedLocalRoots).toEqual([])
    expect(config.defaultOcr).toBe(false)
    expect(config.defaultTableMode).toBe('accurate')
  })

  it.each([
    ['filesystem root as allowed root', { allowedLocalRoots: [parse(process.cwd()).root] }],
    ['normalized filesystem root as allowed root', { allowedLocalRoots: [`${parse(process.cwd()).root}workspace${sep}..`] }],
    ['filesystem root as runtime directory', { runtimeDir: parse(process.cwd()).root }],
    ['filesystem root as tessdata directory', { tessdataPath: parse(process.cwd()).root }],
    ['relative Python worker path', { pythonWorkerPath: 'python/worker.py' }]
  ])('rejects %s during semantic configuration resolution', (_label, values) => {
    expect(() => resolveConfig(new Config(schemaInput(values)))).toThrow()
  })

  it.each([
    ['invalid engine', { engine: 'remote' }],
    ['timeout below the lower bound', { timeoutMs: 999 }],
    ['max file size below the lower bound', { maxFileBytes: 0 }],
    ['empty OCR language', { ocrLanguages: [''] }],
    ['downloadable Paddle OCR backend', { ocrBackend: 'paddleocr' }]
  ])('rejects %s in its schema', (_label, values) => {
    expect(() => new Config(schemaInput(values))).toThrow()
  })

  it.each([
    ['no OCR languages', { ocrLanguages: [] }],
    ['unsafe OCR language path', { ocrLanguages: ['../eng'] }]
  ])('rejects %s during semantic configuration resolution', (_label, values) => {
    expect(() => resolveConfig(new Config(schemaInput(values)))).toThrow()
  })
})
