import { constants, type Stats } from 'node:fs'
import { lstat, open, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, parse, relative, resolve } from 'node:path'
import type { LocalFile } from '../engine/types.js'
import { DshdocError } from '../dshdoc/errors.js'

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate)
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))
}

function isFilesystemRoot(path: string): boolean {
  const normalized = resolve(path)
  return parse(normalized).root === normalized
}

function isNetworkDeviceOrUriPath(path: string): boolean {
  return /^(?:\\\\|\/\/|[A-Za-z][A-Za-z0-9+.-]*:\/\/)/.test(path)
}

function isLexicallyWithin(root: string, candidate: string): boolean {
  return isWithin(resolve(root), candidate)
}

/** Compare the already-open descriptor with the currently authorized path. */
export function sameFileIdentity(opened: Pick<Stats, 'dev' | 'ino'>, current: Pick<Stats, 'dev' | 'ino'>): boolean {
  return opened.dev === current.dev && opened.ino === current.ino
}

async function realAllowedRoots(roots: readonly string[]): Promise<string[]> {
  const resolved: string[] = []
  for (const root of roots) {
    try {
      const rootStat = await stat(root)
      if (!rootStat.isDirectory()) continue
      const realRoot = await realpath(root)
      if (!isFilesystemRoot(realRoot)) resolved.push(realRoot)
    } catch {
      // A stale configured root grants no access. Do not leak host filesystem details.
    }
  }
  return resolved
}

/**
 * Resolve a local file through real paths before checking the sandbox. This closes
 * both traversal and symlink-escape paths, including a symlinked configured root.
 */
export async function resolveLocalFile(
  inputPath: string,
  allowedRoots: readonly string[],
  maxFileBytes: number,
  workingDirectory?: string
): Promise<LocalFile> {
  if (allowedRoots.length === 0) {
    throw new DshdocError('FILE_ACCESS_DENIED', 'Local document access requires allowedLocalRoots configuration.')
  }
  // Do this before *any* filesystem call. A Windows UNC/device path could
  // otherwise negotiate with an attacker-controlled SMB endpoint before the
  // later realpath allowlist check rejects it.
  if (isNetworkDeviceOrUriPath(inputPath)) {
    throw new DshdocError('FILE_ACCESS_DENIED', 'The requested document is outside allowedLocalRoots.')
  }
  const requestedPath = resolve(workingDirectory ?? process.cwd(), inputPath)
  if (isNetworkDeviceOrUriPath(requestedPath)
    || !allowedRoots.some(root => !isNetworkDeviceOrUriPath(root) && isLexicallyWithin(root, requestedPath))) {
    throw new DshdocError('FILE_ACCESS_DENIED', 'The requested document is outside allowedLocalRoots.')
  }
  let realPath: string
  try {
    realPath = await realpath(requestedPath)
  } catch (error) {
    if (error instanceof DshdocError) throw error
    throw new DshdocError('FILE_NOT_FOUND', 'The requested document was not found.')
  }

  const roots = await realAllowedRoots(allowedRoots)
  if (!roots.some(root => isWithin(root, realPath))) {
    throw new DshdocError('FILE_ACCESS_DENIED', 'The requested document is outside allowedLocalRoots.')
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    // Re-resolve immediately before opening and keep the descriptor open while
    // reading. The returned Blob is therefore a snapshot of the authorized
    // file, rather than a later path-based read vulnerable to replacement.
    const currentPath = await realpath(realPath)
    if (!roots.some(root => isWithin(root, currentPath))) {
      throw new DshdocError('FILE_ACCESS_DENIED', 'The requested document is outside allowedLocalRoots.')
    }
    const pathDetails = await lstat(currentPath)
    if (!pathDetails.isFile()) {
      throw new DshdocError('FILE_ACCESS_DENIED', 'The requested path must be a regular file.')
    }
    if (pathDetails.size > maxFileBytes) {
      throw new DshdocError('FILE_TOO_LARGE', `The document exceeds the configured ${maxFileBytes}-byte limit.`)
    }
    // O_NOFOLLOW closes the open-time symlink race on platforms that support
    // it. Windows lacks that flag, so the descriptor identity check below is
    // required on every platform as the authoritative post-open guard.
    handle = await open(
      currentPath,
      process.platform === 'win32' ? 'r' : constants.O_RDONLY | constants.O_NOFOLLOW
    )
    const details = await handle.stat()
    const pathDetailsAfterOpen = await lstat(currentPath)
    const pathAfterOpen = await realpath(currentPath)
    if (pathAfterOpen !== currentPath || !roots.some(root => isWithin(root, pathAfterOpen))) {
      throw new DshdocError('FILE_ACCESS_DENIED', 'The requested document is outside allowedLocalRoots.')
    }
    if (!details.isFile() || !pathDetailsAfterOpen.isFile()) {
      throw new DshdocError('FILE_ACCESS_DENIED', 'The requested path must be a regular file.')
    }
    if (!sameFileIdentity(details, pathDetailsAfterOpen)) {
      throw new DshdocError('FILE_ACCESS_DENIED', 'The requested document changed during authorization.')
    }
    if (details.size > maxFileBytes) {
      throw new DshdocError('FILE_TOO_LARGE', `The document exceeds the configured ${maxFileBytes}-byte limit.`)
    }
    const bytes = await handle.readFile()
    if (bytes.byteLength > maxFileBytes) {
      throw new DshdocError('FILE_TOO_LARGE', `The document exceeds the configured ${maxFileBytes}-byte limit.`)
    }
    return {
      path: pathAfterOpen,
      name: basename(pathAfterOpen),
      size: bytes.byteLength,
      mediaType: mediaTypeForPath(pathAfterOpen),
      // This Buffer is the completed descriptor read. Engines take their own
      // copy before handing bytes to a native parser or subprocess.
      bytes
    }
  } catch (error) {
    if (error instanceof DshdocError) throw error
    throw new DshdocError('FILE_NOT_FOUND', 'The requested document was not found.')
  } finally {
    await handle?.close()
  }
}

export function mediaTypeForPath(filePath: string): string {
  const extension = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase()
  const knownTypes: Record<string, string> = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    html: 'text/html',
    htm: 'text/html',
    md: 'text/markdown',
    markdown: 'text/markdown',
    csv: 'text/csv',
    txt: 'text/plain',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    webp: 'image/webp'
  }
  return knownTypes[extension] ?? 'application/octet-stream'
}
