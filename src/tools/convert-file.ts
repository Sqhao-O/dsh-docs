import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from '../config.js'
import type { DocumentEngine, JsonValue } from '../engine/types.js'
import { asConversionResult } from '../output/render.js'
import { renderConversion } from '../output/render.js'
import { DshdocError } from '../dshdoc/errors.js'
import { CONVERSION_OUTPUT, CONVERSION_PARAMETERS, asHarnessError, convertOptions, resolveToolFile } from './shared.js'

export function createConvertFileTool(engine: DocumentEngine, config: Config, ctx?: Context) {
  return defineTool({
    name: 'dshdoc_convert_file',
    description: 'Convert an allowed local PDF, Word, PowerPoint, Excel, HTML, Markdown, CSV, image, or scanned document into structured context. Use this for PDF / Word / PowerPoint / Excel / scanned documents.',
    parameters: {
      path: { type: 'string' as const, required: true, description: 'Path to a document inside the session workspace or allowedLocalRoots.' },
      ...CONVERSION_PARAMETERS
    },
    output: {
      schema: CONVERSION_OUTPUT,
      render: (_args, value) => [{ type: 'text' as const, text: renderConversion(asConversionResult(value)) }]
    },
    async execute(args, exec) {
      try {
        if (!config.enableLocalFiles) {
          throw new DshdocError('FILE_ACCESS_DENIED', 'Local document conversion is disabled by configuration.')
        }
        const file = await resolveToolFile(args.path, config, exec, ctx)
        return await engine.convertFile({ file, options: convertOptions(args, config), signal: exec.signal }) as unknown as JsonValue
      } catch (error) {
        return asHarnessError(error)
      }
    },
    presentCall: args => ({ card: 'generic', title: `Convert ${args.path}`, kind: 'read', rawInput: args.path })
  })
}
