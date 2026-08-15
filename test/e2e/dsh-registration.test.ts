import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import * as DshdocPlugin from '../../src/index.js'
import type { Config } from '../../src/config.js'

function rawConfig(values: Record<string, unknown>): Config {
  return values as unknown as Config
}

describe('DeepSeek Harness plugin registration', () => {
  it('loads through the actual Cordis and DSH ToolRuntime, exposes four tools, and cleans them up', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = await ctx.plugin(DshdocPlugin, rawConfig({ allowedLocalRoots: [] }))

    for (const toolName of ['dshdoc_health', 'dshdoc_convert_file', 'dshdoc_convert_url', 'dshdoc_extract']) {
      expect(ctx.tools.get(toolName)).toBeDefined()
    }

    await fiber.dispose()
    for (const toolName of ['dshdoc_health', 'dshdoc_convert_file', 'dshdoc_convert_url', 'dshdoc_extract']) {
      expect(ctx.tools.get(toolName)).toBeUndefined()
    }
  })

  it('rejects invalid plugin configuration through Cordis Config validation', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await expect(ctx.plugin(DshdocPlugin, rawConfig({ timeoutMs: 0 }))).rejects.toThrow()
  })
})
