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

function ipv6Hextets(address: string): number[] | undefined {
  const parts = address.split('::')
  if (parts.length > 2) return undefined
  const expand = (part: string): number[] | undefined => {
    if (part === '') return []
    const segments = part.split(':')
    const hextets: number[] = []
    for (const [index, segment] of segments.entries()) {
      if (segment.includes('.')) {
        if (index !== segments.length - 1) return undefined
        const octets = ipv4Octets(segment)
        if (octets === undefined) return undefined
        hextets.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!)
        continue
      }
      if (!/^[0-9a-f]{1,4}$/i.test(segment)) return undefined
      hextets.push(Number.parseInt(segment, 16))
    }
    return hextets
  }
  const left = expand(parts[0]!)
  const right = expand(parts[1] ?? '')
  if (left === undefined || right === undefined) return undefined
  if (parts.length === 1) return left.length === 8 ? left : undefined
  const zeroes = 8 - left.length - right.length
  return zeroes >= 1 ? [...left, ...Array<number>(zeroes).fill(0), ...right] : undefined
}

function ipv4FromHextets(hextets: readonly number[]): string {
  const high = hextets[6]!
  const low = hextets[7]!
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
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
    const hextets = ipv6Hextets(withoutBrackets)
    if (hextets === undefined) return true
    const first = hextets[0]!
    const ipv4Compatible = hextets.slice(0, 6).every(value => value === 0)
    const ipv4Mapped = hextets.slice(0, 5).every(value => value === 0) && hextets[5] === 0xffff
    if (ipv4Compatible || ipv4Mapped) return isPrivateAddress(ipv4FromHextets(hextets))
    return (first & 0xffc0) === 0xfe80 // fe80::/10 link-local
      || (first & 0xfe00) === 0xfc00 // fc00::/7 unique-local
      || (first & 0xff00) === 0xff00 // ff00::/8 multicast
      || (first === 0x2001 && hextets[1] === 0x0db8) // 2001:db8::/32 documentation
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
