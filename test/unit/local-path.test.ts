import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join, parse, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { DoclingError } from '../../src/docling/errors.js'
import { mediaTypeForPath, resolveLocalFile } from '../../src/security/local-path.js'

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

  it('rejects a path outside the allowed root and a traversal escape', async () => {
    const { root, outside } = await sandbox()
    const file = join(outside, 'private.md')
    await writeFile(file, 'secret')
    expect(await codeOf(() => resolveLocalFile(file, [root], 1024))).toBe('FILE_ACCESS_DENIED')
    expect(await codeOf(() => resolveLocalFile(join(root, '..', 'outside', 'private.md'), [root], 1024))).toBe('FILE_ACCESS_DENIED')
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
