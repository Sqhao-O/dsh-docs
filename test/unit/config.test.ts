import { describe, expect, it } from 'vitest'
import { Config, DEFAULT_BASE_URL, DEFAULT_MAX_FILE_BYTES, DEFAULT_TIMEOUT_MS, resolveConfig } from '../../src/config.js'
import type { Config as PluginConfig } from '../../src/config.js'

function schemaInput(values: Record<string, unknown>): PluginConfig {
  return values as unknown as PluginConfig
}

describe('plugin configuration', () => {
  it('applies documented defaults through Schemastery', () => {
    const config = new Config(schemaInput({}))
    expect(config.baseUrl).toBe(DEFAULT_BASE_URL)
    expect(config.timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
    expect(config.maxFileBytes).toBe(DEFAULT_MAX_FILE_BYTES)
    expect(config.allowedLocalRoots).toEqual([])
    expect(config.defaultTableMode).toBe('accurate')
  })

  it.each([
    ['invalid base URL', { baseUrl: 'not-a-url' }],
    ['unsupported base URL protocol', { baseUrl: 'ftp://example.com' }],
    ['credential-bearing base URL', { baseUrl: 'https://user:secret@example.com' }],
    ['query-bearing base URL', { baseUrl: 'https://docling.example.test/?unexpected=true' }],
    ['fragment-bearing base URL', { baseUrl: 'https://docling.example.test/#unexpected' }],
    ['filesystem root as allowed root', { allowedLocalRoots: ['C:\\'] }]
  ])('rejects %s during semantic configuration resolution', (_label, values) => {
    expect(() => resolveConfig(new Config(schemaInput(values)))).toThrow()
  })

  it.each([
    ['timeout below the lower bound', { timeoutMs: 999 }],
    ['max file size below the lower bound', { maxFileBytes: 0 }]
  ])('rejects %s in its schema', (_label, values) => {
    expect(() => new Config(schemaInput(values))).toThrow()
  })
})
