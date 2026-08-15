import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as DshdocPlugin from '../../src/index.js'
import type { Config } from '../../src/config.js'
import { generateDocumentFixtures } from '../helpers/document-fixtures.js'

const dshRuntimeRoot = process.env.DSH_RUNTIME_ROOT
  ?? (process.env.APPDATA === undefined
    ? undefined
    : join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh'))
const dshPackagesRoot = dshRuntimeRoot === undefined
  ? undefined
  : join(dshRuntimeRoot, 'node_modules', '@deepseek-ai')
const hasLocalDshAgentLoop = dshPackagesRoot !== undefined
  && existsSync(join(dshPackagesRoot, 'dsh-agent-loop', 'lib', 'index.js'))

interface RuntimeContext {
  plugin(plugin: unknown, config?: unknown): Promise<unknown>
  llm: { registerAdapter(providers: string[], adapter: unknown): void }
  tools: unknown
  agentLoop: { create(id: string, options: object): { followup(message: unknown): void } }
  on(event: 'agent/status', listener: (payload: { agent: unknown, status: string }) => void): () => void
}

function rawConfig(values: Record<string, unknown>): Config {
  return values as unknown as Config
}

function dshModule(name: string): string {
  if (dshPackagesRoot === undefined) throw new Error('DSH runtime root is unavailable')
  return pathToFileURL(join(dshPackagesRoot, name, 'lib', 'index.js')).href
}

function textResponse(text: string): object[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } }
  ]
}

function toolCallResponse(source: string): object[] {
  const argumentsJson = JSON.stringify({ source })
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: 'dshdoc-call-1', name: 'dshdoc_extract', argumentsDelta: argumentsJson },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: 'dshdoc-call-1', name: 'dshdoc_extract', arguments: argumentsJson }
    },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } }
  ]
}

/** Resolve when this exact agent reaches idle after a prompt wakes it. */
function waitForIdle(ctx: Pick<RuntimeContext, 'on'>, agent: unknown): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }: { agent: unknown, status: string }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

const localDshIt = hasLocalDshAgentLoop ? it : it.skip

describe('locally installed DSH AgentLoop context injection', () => {
  localDshIt('feeds a real dshdoc_extract ToolResult into the next model request', async () => {
    const [cordis, llm, session, systemPrompt, tools, agentRegistry, agentLoop] = await Promise.all([
      import(dshModule('cordis')),
      import(dshModule('dsh-llm')),
      import(dshModule('dsh-session')),
      import(dshModule('dsh-system-prompt')),
      import(dshModule('dsh-tools')),
      import(dshModule('dsh-agent')),
      import(dshModule('dsh-agent-loop'))
    ])
    const Context = cordis.Context as new () => RuntimeContext
    const LlmAdapter = llm.LlmAdapter as new () => {
      stream(options: unknown): AsyncIterable<object>
      resolveModel(provider: string, model: string): Promise<object>
    }
    const createUserMessage = llm.createUserMessage as (message: object) => unknown
    const SessionId = session.SessionId as (id: string) => string
    const SessionStore = session.default
    const SystemPrompt = systemPrompt.default
    const ToolRuntime = tools.default
    const AgentRegistry = agentRegistry.default
    const AgentLoop = agentLoop.default
    const fixtures = await generateDocumentFixtures()
    const document = fixtures.file('pdf')
    const sentinel = fixtures.sentinels.pdf ?? (() => { throw new Error('Generated PDF fixture did not declare its sentinel') })()
    let sawToolResult = false

    class SentinelCheckingAdapter extends LlmAdapter {
      readonly requests: unknown[] = []
      private call = 0

      override async *stream(options: { messages: readonly { content: readonly { type: string, content?: readonly { type: string, text?: string }[] }[] }[] }): AsyncIterable<object> {
        this.requests.push(options)
        const current = this.call++
        if (current === 0) {
          yield* toolCallResponse(document)
          return
        }
        const toolResultTexts = options.messages
          .flatMap(message => message.content)
          .filter(block => block.type === 'tool-result')
          .flatMap(block => block.content ?? [])
          .filter(block => block.type === 'text')
          .map(block => block.text ?? '')
        sawToolResult = toolResultTexts.some(text => text.includes(sentinel))
        if (!sawToolResult) throw new Error('next model request did not contain the Dshdoc ToolResult sentinel')
        yield* textResponse(`Confirmed ${sentinel}`)
      }

      override resolveModel(provider: string, model: string): Promise<object> {
        return Promise.resolve({ provider, id: model, name: model })
      }
    }

    const ctx = new Context()
    try {
      await ctx.plugin(llm.default)
      await ctx.plugin(SessionStore)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(DshdocPlugin, rawConfig({
        engine: 'node',
        allowedLocalRoots: [fixtures.directory],
        defaultOcr: false,
        maxOutputChars: 4_096
      }))

      const adapter = new SentinelCheckingAdapter()
      ctx.llm.registerAdapter(['mock'], adapter)
      const agent = ctx.agentLoop.create(SessionId('dshdoc-context-injection'), { provider: 'mock', model: 'mock' })
      const idle = waitForIdle(ctx, agent)
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'Extract the document and report its unique marker.' }],
        source: { kind: 'user' }
      }))
      await idle

      expect(adapter.requests).toHaveLength(2)
      expect(sawToolResult).toBe(true)
    } finally {
      await fixtures.dispose()
    }
  }, 120_000)
})
