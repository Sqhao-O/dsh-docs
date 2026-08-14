import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config.js'
import type { DoclingClient } from '../docling/types.js'
import { asConversionResult, renderConversion } from '../output/render.js'
import { DoclingError } from '../docling/errors.js'
import { resolveLocalFile } from '../security/local-path.js'
import { validateRemoteUrl } from '../security/url.js'
import { CONVERSION_OUTPUT, CONVERSION_PARAMETERS, asHarnessError, convertOptions } from './shared.js'

function isHttpSource(source: string): boolean {
  return /^https?:\/\//i.test(source)
}

export function createExtractTool(client: DoclingClient, config: Config) {
  return defineTool({
    name: 'docling_extract',
    description: 'Preferred high-level document tool. Extract structured context from an allowed local file or approved public document URL. Auto-detects http/https URLs; otherwise treats source as a local path.',
    parameters: {
      source: { type: 'string' as const, required: true, description: 'Local document path or public document URL.' },
      source_type: {
        type: 'string' as const,
        enum: ['auto', 'file', 'url'],
        description: 'Source interpretation. Defaults to auto.'
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
          if (!config.enableRemoteUrls) {
            throw new DoclingError('UNSUPPORTED_URL', 'Remote document conversion is disabled by configuration.')
          }
          const url = await validateRemoteUrl(args.source, { allowPrivateUrls: config.allowPrivateUrls })
          return await client.convertUrl({ url: url.toString(), options, signal: exec.signal }) as unknown as JsonValue
        }
        if (!config.enableLocalFiles) {
          throw new DoclingError('FILE_ACCESS_DENIED', 'Local document conversion is disabled by configuration.')
        }
        const file = await resolveLocalFile(args.source, config.allowedLocalRoots, config.maxFileBytes)
        return await client.convertFile({ file, options, signal: exec.signal }) as unknown as JsonValue
      } catch (error) {
        return asHarnessError(error)
      }
    },
    presentCall: args => ({ card: 'generic', title: `Extract ${args.source}`, kind: 'read', rawInput: args.source })
  })
}
