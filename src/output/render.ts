import type { ConversionResult, JsonValue } from '../engine/types.js'

function resultContent(result: ConversionResult): string {
  if (result.markdown !== undefined) return result.markdown
  if (result.text !== undefined) return result.text
  if (result.json !== undefined) return JSON.stringify(result.json, null, 2)
  return ''
}

function documentLabel(result: ConversionResult): string {
  return result.source.name
}

/** Format the bounded canonical result into concise native Tool Result text. */
export function renderConversion(result: ConversionResult): string {
  const lines = [
    `Document: ${documentLabel(result)}`,
    `Format: ${result.metadata.detectedFormat ?? result.format}`,
    'Parsed successfully',
    ...result.metadata.pages === undefined ? [] : [`Pages: ${result.metadata.pages}`],
    `Truncated: ${result.stats.truncated}`,
    ...result.stats.truncated
      ? [`Output: ${result.stats.returnedChars}/${result.stats.outputChars} characters returned`]
      : []
  ]
  return `${lines.join('\n')}\n\n${resultContent(result)}`.trimEnd()
}

/** The `json` schema DSL has already guaranteed the value is JSON; tools use this narrow bridge for rendering. */
export function asConversionResult(value: JsonValue): ConversionResult {
  return value as unknown as ConversionResult
}
