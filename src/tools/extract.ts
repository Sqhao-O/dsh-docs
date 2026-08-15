import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config.js'
import type { DocumentEngine } from '../engine/types.js'
import { asConversionResult, renderConversion } from '../output/render.js'
import { DshdocError } from '../dshdoc/errors.js'
import { resolveLocalFile } from '../security/local-path.js'
import { CONVERSION_OUTPUT, CONVERSION_PARAMETERS, asHarnessError, convertOptions, effectiveLocalRoots } from './shared.js'

function isHttpSource(source: string): boolean {
  return /^https?:\/\//i.test(source)
}

export function createExtractTool(engine: DocumentEngine, config: Config) {
  return defineTool({
    name: 'dshdoc_extract',
    description: 'Preferred high-level local document tool. Extract PDF, Office, text, HTML, CSV, images, and scanned documents from an allowed local path. HTTP(S) URLs must be downloaded into an allowed local root first.',
    parameters: {
      source: { type: 'string' as const, required: true, description: 'Local document path inside the session workspace or allowedLocalRoots.' },
      source_type: {
        type: 'string' as const,
        enum: ['auto', 'file', 'url'],
        description: 'Source interpretation. URL is rejected by the local-only engine. Defaults to auto.'
      },
      ...CONVERSION_PARAMETERS
    },
    output: {
      schema: CONVERSION_OUTPUT,
      render: (_args, value) => [{ type: 'text' as const, text: renderConversion(asConversionResult(value)) }]
    },
    async execute(args, exec) {
      try {
        const type = args.source_type ?? 'auto'
        const urlInput = type === 'url' || (type === 'auto' && isHttpSource(args.source))
        const options = convertOptions(args, config)
        if (urlInput) {
          throw new DshdocError('UNSUPPORTED_URL', 'Remote document URLs are not supported by the local-only engine. Download the file into the session workspace or allowedLocalRoots, then retry.')
        }
        if (!config.enableLocalFiles) {
          throw new DshdocError('FILE_ACCESS_DENIED', 'Local document conversion is disabled by configuration.')
        }
        const cwd = exec.agent?.session.header.cwd
        const file = await resolveLocalFile(args.source, effectiveLocalRoots(config, cwd), config.maxFileBytes, cwd)
        return await engine.convertFile({ file, options, signal: exec.signal }) as unknown as JsonValue
      } catch (error) {
        return asHarnessError(error)
      }
    },
    presentCall: args => ({ card: 'generic', title: `Extract ${args.source}`, kind: 'read', rawInput: args.source })
  })
}
