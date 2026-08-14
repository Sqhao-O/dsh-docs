import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config.js'
import type { DoclingClient } from '../docling/types.js'
import { asConversionResult } from '../output/render.js'
import { renderConversion } from '../output/render.js'
import { DoclingError } from '../docling/errors.js'
import { resolveLocalFile } from '../security/local-path.js'
import { CONVERSION_OUTPUT, CONVERSION_PARAMETERS, asHarnessError, convertOptions } from './shared.js'

export function createConvertFileTool(client: DoclingClient, config: Config) {
  return defineTool({
    name: 'docling_convert_file',
    description: 'Convert an allowed local PDF, Word, PowerPoint, Excel, HTML, Markdown, CSV, image, or scanned document into structured context. Use this for PDF / Word / PowerPoint / Excel / scanned documents.',
    parameters: {
      path: { type: 'string' as const, required: true, description: 'Path to a document inside allowedLocalRoots.' },
      ...CONVERSION_PARAMETERS
    },
    output: {
      schema: CONVERSION_OUTPUT,
      render: (_args, value) => [{ type: 'text' as const, text: renderConversion(asConversionResult(value)) }]
    },
    async execute(args, exec) {
      try {
        if (!config.enableLocalFiles) {
          throw new DoclingError('FILE_ACCESS_DENIED', 'Local document conversion is disabled by configuration.')
        }
        const file = await resolveLocalFile(args.path, config.allowedLocalRoots, config.maxFileBytes)
        return await client.convertFile({ file, options: convertOptions(args, config), signal: exec.signal }) as unknown as JsonValue
      } catch (error) {
        return asHarnessError(error)
      }
    },
    presentCall: args => ({ card: 'generic', title: `Convert ${args.path}`, kind: 'read', rawInput: args.path })
  })
}
