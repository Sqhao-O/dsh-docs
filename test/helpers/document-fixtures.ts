import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

export interface GeneratedDocumentFixtures {
  readonly directory: string
  readonly sentinels: Readonly<Record<string, string>>
  readonly files: Readonly<Record<string, string>>
  file(name: string): string
  dispose(): Promise<void>
}

const generator = fileURLToPath(new URL('./generate-document-fixtures.py', import.meta.url))

/** Generate parser inputs in the OS temp directory; no binary fixture enters Git. */
export async function generateDocumentFixtures(): Promise<GeneratedDocumentFixtures> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-doc-fixtures-'))
  const python = process.env.PYTHON ?? 'python'
  try {
    const { stdout } = await execFile(python, [generator, '--output', directory], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 1024 * 1024
    })
    const parsed = JSON.parse(stdout) as { directory: string, sentinels: Record<string, string>, files: Record<string, string> }
    return {
      directory: parsed.directory,
      sentinels: parsed.sentinels,
      files: parsed.files,
      file: name => join(parsed.directory, parsed.files[name] ?? (() => { throw new Error(`Unknown generated fixture: ${name}`) })()),
      dispose: () => rm(directory, { recursive: true, force: true })
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}
