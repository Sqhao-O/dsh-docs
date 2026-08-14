import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config.js'
import type { DoclingClient } from '../docling/types.js'
import { asConversionResult, renderConversion } from '../output/render.js'
import { DoclingError } from '../docling/errors.js'
import { validateRemoteUrl } from '../security/url.js'
import { CONVERSION_OUTPUT, CONVERSION_PARAMETERS, asHarnessError, convertOptions } from './shared.js'

export function createConvertUrlTool(client: DoclingClient, config: Config) {
  return defineTool({
    name: 'docling_convert_url',
    description: 'Convert an approved HTTP or HTTPS document URL into structured context. Blocks local and private-network targets by default.',
    parameters: {
      url: { type: 'string' as const, required: true, description: 'Public http or https URL for a document.' },
      ...CONVERSION_PARAMETERS
    },
    output: {
      schema: CONVERSION_OUTPUT,
      render: (_args, value) => [{ type: 'text' as const, text: renderConversion(asConversionResult(value)) }]
    },
    async execute(args, exec) {
      try {
        if (!config.enableRemoteUrls) {
          throw new DoclingError('UNSUPPORTED_URL', 'Remote document conversion is disabled by configuration.')
        }
        const url = await validateRemoteUrl(args.url, { allowPrivateUrls: config.allowPrivateUrls })
        return await client.convertUrl({ url: url.toString(), options: convertOptions(args, config), signal: exec.signal }) as unknown as JsonValue
      } catch (error) {
        return asHarnessError(error)
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Convert document URL', kind: 'read', rawInput: args.url })
  })
}
