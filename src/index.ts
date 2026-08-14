import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig } from './config.js'
import type { Config as PluginConfig } from './config.js'
import { DoclingHttpClient } from './docling/client.js'
import { createConvertFileTool } from './tools/convert-file.js'
import { createConvertUrlTool } from './tools/convert-url.js'
import { createExtractTool } from './tools/extract.js'
import { createHealthTool } from './tools/health.js'

export { Config } from './config.js'
export type { Config as DoclingConfig } from './config.js'
export { DoclingError } from './docling/errors.js'
export type { ConversionResult, DoclingClient, HealthResult } from './docling/types.js'

export const name = 'dsh-docling'
export const inject = ['tools']

/** Cordis entry point mounted by cordis.patch.yml. */
export function apply(ctx: Context, config: PluginConfig): void {
  const resolved = resolveConfig(config)
  const client = new DoclingHttpClient({
    ...resolved,
    log: (message, details) => {
      if (resolved.debug) ctx.logger('dsh-docling').debug(message, details)
    }
  })
  ctx.tools.register(createHealthTool(client))
  ctx.tools.register(createConvertFileTool(client, resolved))
  ctx.tools.register(createConvertUrlTool(client, resolved))
  ctx.tools.register(createExtractTool(client, resolved))
}
