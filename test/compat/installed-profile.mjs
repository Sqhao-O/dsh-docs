// Run with a separate npm prefix containing the DSH CLI and a packed plugin.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const [prefix, archive] = process.argv.slice(2)
const host = createRequire(resolve(prefix, 'package.json'))
const cliPackage = host.resolve('@deepseek-ai/dsh/package.json')
const { bin } = JSON.parse(await readFile(cliPackage, 'utf8'))
const { default: ToolRuntime } = await import(pathToFileURL(host.resolve('@deepseek-ai/dsh-tools')))
const useBatchExecutor = typeof ToolRuntime.prototype.setExecutor === 'function'
const home = await mkdtemp(join(tmpdir(), 'dsh-doc-profile-'))
const profile = 'doc-test'
const dir = join(home, 'profiles', profile)
const marker = 'DSH profile extraction succeeded'
process.env.DSH_HOME = home

try {
  const { initProfile } = await import(pathToFileURL(host.resolve('@deepseek-ai/dsh-app-boot')))
  initProfile(dir, [])
  execFileSync(process.execPath, [resolve(dirname(cliPackage), bin.dsh),
    'plugin', '--profile', profile, 'add', resolve(archive)], { stdio: 'inherit', timeout: 120_000 })
  await writeFile(join(dir, 'document.md'), marker)
  await writeFile(join(dir, 'cordis.patch.yml'), JSON.stringify([
    { insert: [
      { name: '@deepseek-ai/dsh-system-prompt' },
      { name: '@deepseek-ai/dsh-tools' },
      ...(useBatchExecutor ? [{ name: '@deepseek-ai/dsh-tool-executor-native' }] : [])
    ] },
    { id: 'dsh-doc', config: { engine: 'node', allowedLocalRoots: [dir] } }
  ]))
  const { runProfile } = await import(pathToFileURL(host.resolve('@deepseek-ai/dsh/profile-boot')))
  const { createLaunchEnvironmentSnapshot } = await import(pathToFileURL(host.resolve('@deepseek-ai/dsh-launch-environment')))
  const { ctx, shutdown } = await runProfile({
    profile, environment: createLaunchEnvironmentSnapshot([]), patchFiles: [], args: []
  })
  try {
    async function call(name, args) {
      const signal = new globalThis.AbortController().signal
      if (!useBatchExecutor) return ctx.tools.execute({ callId: name, name, arguments: args, signal })
      const batch = await ctx.tools.execute({
        calls: [{ type: 'tool-call', id: name, name, arguments: JSON.stringify(args) }], signal
      })
      return batch.results[0].result
    }
    const health = await call('dshdoc_health', {})
    assert.equal(health.value?.status, 'ready', JSON.stringify(health))
    for (const [name, field] of [['dshdoc_extract', 'source'], ['dshdoc_convert_file', 'path']]) {
      const result = await call(name, { [field]: join(dir, 'document.md') })
      assert.equal(result.isError, false, JSON.stringify(result))
      assert.ok(result.content[0].text.includes(marker))
    }
    const remote = await call('dshdoc_convert_url', { url: 'https://example.com/document.pdf' })
    assert.equal(remote.error?.info?.code, 'UNSUPPORTED_URL', JSON.stringify(remote))
  } finally {
    await shutdown.shutdown(0)
  }
} finally {
  await rm(home, { recursive: true, force: true })
}
