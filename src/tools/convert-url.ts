import { defineTool } from '@deepseek-ai/dsh-tools'
import { asConversionResult, renderConversion } from '../output/render.js'
import { DoclingError } from '../docling/errors.js'
import { CONVERSION_OUTPUT, CONVERSION_PARAMETERS, asHarnessError } from './shared.js'

export function createConvertUrlTool() {
  return defineTool({
    name: 'docling_convert_url',
    description: 'Reserved compatibility tool. The local document engine accepts only authorized file bytes; download a document into an allowed local root, then use docling_extract.',
    parameters: {
      url: { type: 'string' as const, required: true, description: 'Public http or https URL for a document.' },
      ...CONVERSION_PARAMETERS
    },
    output: {
      schema: CONVERSION_OUTPUT,
      render: (_args, value) => [{ type: 'text' as const, text: renderConversion(asConversionResult(value)) }]
    },
    async execute() {
      try {
        throw new DoclingError('UNSUPPORTED_URL', 'Remote document URLs are not supported by the local-only engine. Download the file into allowedLocalRoots, then use docling_extract.')
      } catch (error) {
        return asHarnessError(error)
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Remote document URLs are unavailable', kind: 'read', rawInput: args.url })
  })
}
