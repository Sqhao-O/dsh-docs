/**
 * Shared helpers for the runtime build/fetch/verify scripts. Dependency-free so
 * every runtime command runs on any shell with only the package's Node engine.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export async function downloadPinnedFile(uri, destination, expectedSha256) {
  if (existsSync(destination) && statSync(destination).isFile()) {
    assertPinnedFile(destination, expectedSha256)
    return
  }
  mkdirSync(dirname(destination), { recursive: true })
  const partial = `${destination}.${randomUUID().replaceAll('-', '')}.part`
  try {
    const response = await fetch(uri, { redirect: 'follow' })
    if (!response.ok || response.body === null) {
      throw new Error(`Download failed for ${uri}: HTTP ${response.status}`)
    }
    writeFileSync(partial, Buffer.from(await response.arrayBuffer()))
    assertPinnedFile(partial, expectedSha256)
    renameSync(partial, destination)
  } finally {
    if (existsSync(partial)) rmSync(partial, { force: true })
  }
}

export function assertPinnedFile(path, expectedSha256) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`Missing downloaded asset: ${path}`)
  }
  const actual = sha256File(path)
  if (actual !== expectedSha256.toLowerCase()) {
    throw new Error(`SHA-256 mismatch for '${path}'. Expected ${expectedSha256}, received ${actual}.`)
  }
}

/**
 * Minimal ZIP extractor for the pinned archives handled here (CPython
 * embeddable package, Xberg wheel, prebuilt runtime artifact). Supports stored
 * and deflated entries and refuses absolute or traversing member names.
 */
export function extractZip(zipPath, destinationDirectory) {
  const buffer = readFileSync(zipPath)
  // Locate the End of Central Directory record by scanning backwards.
  let eocd = -1
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 22 - 0xffff); index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      eocd = index
      break
    }
  }
  if (eocd < 0) throw new Error(`Not a ZIP archive: ${zipPath}`)
  const entryCount = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)

  const destinationRoot = resolve(destinationDirectory)
  mkdirSync(destinationRoot, { recursive: true })
  for (let entry = 0; entry < entryCount; entry += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`Corrupt central directory in ${zipPath}`)
    }
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localHeaderOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    offset += 46 + nameLength + extraLength + commentLength

    if (name.endsWith('/')) continue // directory entry
    const target = resolve(destinationRoot, name)
    if (target !== destinationRoot && !target.startsWith(destinationRoot + sep)) {
      throw new Error(`Unsafe ZIP member path: ${name}`)
    }

    if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`Corrupt local header for ${name} in ${zipPath}`)
    }
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28)
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize)
    const content = method === 0
      ? Buffer.from(compressed)
      : method === 8
        ? inflateRawSync(compressed)
        : (() => { throw new Error(`Unsupported ZIP compression method ${method} for ${name}`) })()
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
}

/**
 * Rename a freshly populated directory into place. Windows virus scanners and
 * indexers can briefly hold handles on new native binaries, so transient EPERM
 * failures are retried before giving up.
 */
export function moveWithRetry(source, destination) {
  let lastError
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      renameSync(source, destination)
      return
    } catch (error) {
      lastError = error
      if (error?.code !== 'EPERM' && error?.code !== 'EBUSY') throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500 * (attempt + 1))
    }
  }
  throw lastError
}
