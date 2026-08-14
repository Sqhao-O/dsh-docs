import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DoclingClient } from '../docling/types.js'

export function createHealthTool(client: DoclingClient) {
  return defineTool({
    name: 'docling_health',
    description: 'Check whether the configured Docling Serve instance is reachable and ready.',
    parameters: {},
    output: {
      schema: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          status: { type: 'string' as const, required: true },
          baseUrl: { type: 'string' as const, required: true },
          latencyMs: { type: 'integer' as const, required: true }
        }
      },
      render: (_args, value) => [{
        type: 'text' as const,
        text: `Docling status: ${value.status}\nBase URL: ${value.baseUrl}\nLatency: ${value.latencyMs} ms`
      }]
    },
    execute: (_args, exec) => client.health(exec.signal),
    presentCall: () => ({ card: 'generic', title: 'Check Docling health', kind: 'read' })
  })
}
