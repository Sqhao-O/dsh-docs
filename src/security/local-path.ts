import { lstat, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, parse, relative, resolve } from 'node:path'
import type { LocalFile } from '../docling/types.js'
import { DoclingError } from '../docling/errors.js'

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate)
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))
}

function isFilesystemRoot(path: string): boolean {
  const normalized = resolve(path)
  return parse(normalized).root === normalized
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
  maxFileBytes: number
): Promise<LocalFile> {
  if (allowedRoots.length === 0) {
    throw new DoclingError('FILE_ACCESS_DENIED', 'Local document access requires allowedLocalRoots configuration.')
  }
  const requestedPath = resolve(inputPath)
  let realPath: string
  try {
    realPath = await realpath(requestedPath)
  } catch {
    throw new DoclingError('FILE_NOT_FOUND', 'The requested document was not found.')
  }

  const roots = await realAllowedRoots(allowedRoots)
  if (!roots.some(root => isWithin(root, realPath))) {
    throw new DoclingError('FILE_ACCESS_DENIED', 'The requested document is outside allowedLocalRoots.')
  }

  let details: Awaited<ReturnType<typeof lstat>>
  try {
    details = await lstat(realPath)
  } catch {
    throw new DoclingError('FILE_NOT_FOUND', 'The requested document was not found.')
  }
  if (!details.isFile()) {
    throw new DoclingError('FILE_ACCESS_DENIED', 'The requested path must be a regular file.')
  }
  if (details.size > maxFileBytes) {
    throw new DoclingError('FILE_TOO_LARGE', `The document exceeds the configured ${maxFileBytes}-byte limit.`)
  }

  return {
    path: realPath,
    name: basename(realPath),
    size: details.size,
    mediaType: mediaTypeForPath(realPath)
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
