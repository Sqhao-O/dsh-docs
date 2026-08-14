import { isIP } from 'node:net'
import { lookup as lookupHost } from 'node:dns/promises'
import { DoclingError } from '../docling/errors.js'

export interface UrlSecurityPolicy {
  readonly allowPrivateUrls: boolean
}

export type HostLookup = (host: string) => Promise<readonly string[]>

const defaultLookup: HostLookup = async (host) => {
  const addresses = await lookupHost(host, { all: true, verbatim: true })
  return addresses.map(entry => entry.address)
}

function ipv4Octets(address: string): number[] | undefined {
  const octets = address.split('.').map(value => Number(value))
  return octets.length === 4 && octets.every(value => Number.isInteger(value) && value >= 0 && value <= 255)
    ? octets
    : undefined
}

export function isPrivateAddress(address: string): boolean {
  const withoutBrackets = address.replace(/^\[|\]$/g, '').toLowerCase()
  const mappedIpv4 = withoutBrackets.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1]
  if (mappedIpv4 !== undefined) return isPrivateAddress(mappedIpv4)
  const octets = ipv4Octets(withoutBrackets)
  if (octets !== undefined) {
    const first = octets[0]!
    const second = octets[1]!
    return first === 0
      || first === 10
      || first === 127
      || first >= 224
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || (first === 198 && (second === 18 || second === 19))
  }
  if (isIP(withoutBrackets) === 6) {
    return withoutBrackets === '::' || withoutBrackets === '::1'
      || withoutBrackets.startsWith('fe80:')
      || /^f[cd][0-9a-f]{2}:/i.test(withoutBrackets)
  }
  return false
}

/** Validate URL syntax and resolve DNS once to reject obvious SSRF targets. */
export async function validateRemoteUrl(
  input: string,
  policy: UrlSecurityPolicy,
  lookup: HostLookup = defaultLookup
): Promise<URL> {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new DoclingError('UNSUPPORTED_URL', 'The document URL is malformed.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DoclingError('UNSUPPORTED_URL', 'Only http and https document URLs are supported.')
  }
  if (url.username !== '' || url.password !== '') {
    throw new DoclingError('UNSUPPORTED_URL', 'Document URLs must not contain credentials.')
  }
  if (policy.allowPrivateUrls) return url

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || isPrivateAddress(hostname)) {
    throw new DoclingError('SSRF_BLOCKED', 'The document URL targets a blocked private or local address.')
  }
  try {
    const addresses = await lookup(hostname)
    if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
      throw new DoclingError('SSRF_BLOCKED', 'The document URL resolves to a blocked private or local address.')
    }
  } catch (error) {
    if (error instanceof DoclingError) throw error
    throw new DoclingError('SSRF_BLOCKED', 'The document URL host could not be safely resolved.')
  }
  return url
}
