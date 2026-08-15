import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig } from './config.js'
import type { Config as PluginConfig } from './config.js'
import { createDocumentEngine } from './engine/create.js'
import { createConvertFileTool } from './tools/convert-file.js'
import { createConvertUrlTool } from './tools/convert-url.js'
import { createExtractTool } from './tools/extract.js'
import { createHealthTool } from './tools/health.js'

export { Config } from './config.js'
export type { Config as DshdocConfig } from './config.js'
export { DshdocError } from './dshdoc/errors.js'
export type { ConversionResult, DocumentEngine, HealthResult } from './engine/types.js'

export const name = 'dsh-doc'
export const inject = ['tools']

/** Cordis entry point mounted by cordis.patch.yml. */
export function apply(ctx: Context, config: PluginConfig): void {
  const resolved = resolveConfig(config)
  const engine = createDocumentEngine(resolved, {
    ...(resolved.debug ? {
      log: (message, details) => ctx.logger('dsh-doc').debug(message, details)
    } : {})
  })
  ctx.tools.register(createHealthTool(engine))
  ctx.tools.register(createConvertFileTool(engine, resolved))
  ctx.tools.register(createConvertUrlTool())
  ctx.tools.register(createExtractTool(engine, resolved))
}
