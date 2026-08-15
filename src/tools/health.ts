import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DocumentEngine } from '../engine/types.js'
import { asHarnessError } from './shared.js'

export function createHealthTool(engine: DocumentEngine) {
  return defineTool({
    name: 'dshdoc_health',
    description: 'Check whether the local document parsing engine is ready.',
    parameters: {},
    output: {
      schema: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          status: { type: 'string' as const, required: true },
          engine: { type: 'string' as const },
          runtimeVersion: { type: 'string' as const },
          ocrAvailable: { type: 'boolean' as const },
          ocrLanguages: { type: 'array' as const, items: { type: 'string' as const } },
          latencyMs: { type: 'integer' as const, required: true }
        }
      },
      render: (_args, value) => [{
        type: 'text' as const,
        text: `Local document engine: ${value.engine ?? 'unknown'}\nStatus: ${value.status}\nRuntime: ${value.runtimeVersion ?? 'unknown'}\nOCR: ${value.ocrAvailable === true ? `ready (${value.ocrLanguages?.join(', ') ?? 'local packs'})` : value.ocrAvailable === false ? 'unavailable' : 'not reported'}\nLatency: ${value.latencyMs} ms`
      }]
    },
    async execute(_args, exec) {
      try {
        return await engine.health(exec.signal)
      } catch (error) {
        return asHarnessError(error)
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Check local document engine', kind: 'read' })
  })
}
