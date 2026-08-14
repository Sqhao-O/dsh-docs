import { describe, expect, it } from 'vitest'
import { DoclingError } from '../../src/docling/errors.js'
import { isPrivateAddress, validateRemoteUrl } from '../../src/security/url.js'

const publicLookup = async (): Promise<readonly string[]> => ['93.184.216.34']

async function codeOf(action: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await action()
    return undefined
  } catch (error) {
    return error instanceof DoclingError ? error.code : undefined
  }
}

describe('remote URL security', () => {
  it.each(['https://example.com/report.pdf', 'http://example.com/report.pdf'])('allows public %s URLs', async (url) => {
    await expect(validateRemoteUrl(url, { allowPrivateUrls: false }, publicLookup)).resolves.toBeInstanceOf(URL)
  })

  it.each([
    'file:///etc/passwd',
    'ftp://example.com/report.pdf',
    'data:text/plain,hello',
    'javascript:alert(1)',
    'not a URL'
  ])('rejects unsupported or malformed URL %s', async (url) => {
    expect(await codeOf(() => validateRemoteUrl(url, { allowPrivateUrls: false }, publicLookup))).toBe('UNSUPPORTED_URL')
  })

  it.each([
    'http://localhost/report.pdf',
    'http://127.0.0.1/report.pdf',
    'http://[::1]/report.pdf',
    'http://10.0.0.4/report.pdf',
    'http://192.168.1.1/report.pdf',
    'http://169.254.10.3/report.pdf'
  ])('blocks private/local target %s', async (url) => {
    expect(await codeOf(() => validateRemoteUrl(url, { allowPrivateUrls: false }, publicLookup))).toBe('SSRF_BLOCKED')
  })

  it('blocks a hostname which resolves to a private address or cannot safely resolve', async () => {
    expect(await codeOf(() => validateRemoteUrl('https://example.com/a', { allowPrivateUrls: false }, async () => ['10.0.0.4']))).toBe('SSRF_BLOCKED')
    expect(await codeOf(() => validateRemoteUrl('https://example.com/a', { allowPrivateUrls: false }, async () => { throw new Error('DNS failure') }))).toBe('SSRF_BLOCKED')
  })

  it('permits private targets only with explicit configuration', async () => {
    await expect(validateRemoteUrl('http://127.0.0.1/report.pdf', { allowPrivateUrls: true }, publicLookup)).resolves.toBeInstanceOf(URL)
  })

  it.each([
    ['10.0.0.1', true], ['127.1.2.3', true], ['::1', true], ['fe80::1', true], ['fc00::1', true], ['93.184.216.34', false]
  ])('classifies %s private=%s', (address, expected) => {
    expect(isPrivateAddress(address)).toBe(expected)
  })
})
