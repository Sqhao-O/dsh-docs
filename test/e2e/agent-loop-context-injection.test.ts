import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import * as DshdocPlugin from '../../src/index.js'
import type { Config } from '../../src/config.js'
import { generateDocumentFixtures } from '../helpers/document-fixtures.js'

function rawConfig(values: Record<string, unknown>): Config {
  return values as unknown as Config
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } }
  ]
}

function toolCallResponse(source: string): StreamChunk[] {
  const argumentsJson = JSON.stringify({ source })
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: CallId('dshdoc-call-1'), name: 'dshdoc_extract', argumentsDelta: argumentsJson },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: CallId('dshdoc-call-1'), name: 'dshdoc_extract', arguments: argumentsJson }
    },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } }
  ]
}

/** Resolve when this exact agent reaches idle after a prompt wakes it. */
function waitForIdle(ctx: Context, agent: unknown): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }: { agent: unknown, status: string }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

describe('DSH 0.1 AgentLoop context injection', () => {
  it('feeds a real dshdoc_extract ToolResult into the next model request', async () => {
    const fixtures = await generateDocumentFixtures()
    const document = fixtures.file('pdf')
    const sentinel = fixtures.sentinels.pdf ?? (() => { throw new Error('Generated PDF fixture did not declare its sentinel') })()
    let sawToolResult = false

    class SentinelCheckingAdapter extends LlmAdapter {
      readonly requests: unknown[] = []
      private call = 0

      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
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

      override resolveModel(provider: string, model: string) {
        return Promise.resolve({ provider, id: model, name: model })
      }
    }

    const ctx = new Context()
    try {
      await ctx.plugin(LlmRuntime)
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
      await ctx.fiber.dispose()
      await fixtures.dispose()
    }
  }, 120_000)
})
