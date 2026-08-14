import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join, parse, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { DoclingError } from '../../src/docling/errors.js'
import { mediaTypeForPath, resolveLocalFile, sameFileIdentity } from '../../src/security/local-path.js'

const temporaryDirectories: string[] = []

async function sandbox(): Promise<{ root: string, outside: string }> {
  const base = await mkdtemp(join(tmpdir(), 'dsh-docling-path-'))
  temporaryDirectories.push(base)
  const root = join(base, 'allowed')
  const outside = join(base, 'outside')
  await Promise.all([mkdir(root), mkdir(outside)])
  return { root, outside }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function codeOf(action: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await action()
    return undefined
  } catch (error) {
    return error instanceof DoclingError ? error.code : undefined
  }
}

describe('local path sandbox', () => {
  it('allows a regular file contained in a real allowed root', async () => {
    const { root } = await sandbox()
    const file = join(root, 'report.md')
    await writeFile(file, '# report')
    await expect(resolveLocalFile(file, [root], 1024)).resolves.toMatchObject({ name: 'report.md', size: 8, mediaType: 'text/markdown' })
  })

  it('resolves relative paths against the calling workspace when supplied', async () => {
    const { root } = await sandbox()
    const file = join(root, 'report.md')
    await writeFile(file, '# report')
    await expect(resolveLocalFile('./report.md', [root], 1024, root)).resolves.toMatchObject({ path: file, name: 'report.md' })
  })

  it('returns an immutable authorized file snapshot', async () => {
    const { root } = await sandbox()
    const file = join(root, 'report.md')
    await writeFile(file, 'original')
    const resolved = await resolveLocalFile(file, [root], 1024)
    await writeFile(file, 'replacement')
    expect(new TextDecoder().decode(resolved.bytes)).toBe('original')
  })

  it('rejects a path outside the allowed root and a traversal escape', async () => {
    const { root, outside } = await sandbox()
    const file = join(outside, 'private.md')
    await writeFile(file, 'secret')
    expect(await codeOf(() => resolveLocalFile(file, [root], 1024))).toBe('FILE_ACCESS_DENIED')
    expect(await codeOf(() => resolveLocalFile(join(root, '..', 'outside', 'private.md'), [root], 1024))).toBe('FILE_ACCESS_DENIED')
  })

  it('rejects UNC, device, and URI inputs before filesystem resolution', async () => {
    const { root } = await sandbox()
    for (const unsafeInput of [
      String.raw`\\untrusted-host\share\report.pdf`,
      String.raw`\\?\C:\Windows\report.pdf`,
      'file:///C:/Windows/report.pdf'
    ]) {
      expect(await codeOf(() => resolveLocalFile(unsafeInput, [root], 1024))).toBe('FILE_ACCESS_DENIED')
    }
  })

  it('rejects a symlink that escapes the allowed root', async () => {
    const { root, outside } = await sandbox()
    const privateFile = join(outside, 'private.md')
    const link = join(root, 'link.md')
    await writeFile(privateFile, 'secret')
    await symlink(privateFile, link, 'file')
    expect(await codeOf(() => resolveLocalFile(link, [root], 1024))).toBe('FILE_ACCESS_DENIED')
  })

  it('does not allow a configured symlink to canonicalize to a filesystem root', async () => {
    const { root, outside } = await sandbox()
    const privateFile = join(outside, 'private.md')
    const rootLink = join(root, 'root-link')
    await writeFile(privateFile, 'secret')
    await symlink(parse(root).root, rootLink, process.platform === 'win32' ? 'junction' : 'dir')
    expect(await codeOf(() => resolveLocalFile(privateFile, [rootLink], 1024))).toBe('FILE_ACCESS_DENIED')
  })

  it('requires the opened descriptor identity to match the post-open path', () => {
    expect(sameFileIdentity({ dev: 7, ino: 11 }, { dev: 7, ino: 11 })).toBe(true)
    // This models an outside target opened during a path replacement race,
    // followed by a swap back to an allowlisted file before post-open checks.
    expect(sameFileIdentity({ dev: 7, ino: 11 }, { dev: 7, ino: 12 })).toBe(false)
    expect(sameFileIdentity({ dev: 7, ino: 11 }, { dev: 8, ino: 11 })).toBe(false)
  })

  it('reports missing files, directories, over-limit files, and an empty allowlist safely', async () => {
    const { root } = await sandbox()
    const bigFile = join(root, 'large.md')
    await writeFile(bigFile, 'too large')
    expect(await codeOf(() => resolveLocalFile(join(root, 'missing.md'), [root], 1024))).toBe('FILE_NOT_FOUND')
    expect(await codeOf(() => resolveLocalFile(root, [root], 1024))).toBe('FILE_ACCESS_DENIED')
    expect(await codeOf(() => resolveLocalFile(bigFile, [root], 1))).toBe('FILE_TOO_LARGE')
    expect(await codeOf(() => resolveLocalFile(resolve(bigFile), [], 1024))).toBe('FILE_ACCESS_DENIED')
  })

  it('assigns useful media types and has a safe fallback', () => {
    expect(mediaTypeForPath('report.PDF')).toBe('application/pdf')
    expect(mediaTypeForPath('report.unknown')).toBe('application/octet-stream')
  })
})
