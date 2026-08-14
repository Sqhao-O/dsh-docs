export interface LimitedText {
  readonly text: string
  readonly originalChars: number
  readonly returnedChars: number
  readonly truncated: boolean
}

const TRUNCATION_NOTICE = '\n\n> Document parsed successfully, but output was truncated.\n'

function safeCut(text: string, offset: number): number {
  if (offset <= 0) return 0
  if (offset >= text.length) return text.length
  const previous = text.charCodeAt(offset - 1)
  const current = text.charCodeAt(offset)
  return previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff
    ? offset - 1
    : offset
}

/**
 * Keep a bounded document result readable. Prefer a Markdown heading boundary,
 * then a line boundary, and never split a UTF-16 surrogate pair.
 */
export function limitText(text: string, maxChars: number): LimitedText {
  if (!Number.isSafeInteger(maxChars) || maxChars < TRUNCATION_NOTICE.length + 16) {
    throw new RangeError('maxChars must leave room for a truncation notice')
  }
  if (text.length <= maxChars) {
    return { text, originalChars: text.length, returnedChars: text.length, truncated: false }
  }
  const budget = maxChars - TRUNCATION_NOTICE.length
  let cut = budget
  const headingBoundary = text.lastIndexOf('\n#', budget)
  if (headingBoundary > Math.floor(budget * 0.55)) {
    cut = headingBoundary
  } else {
    const lineBoundary = text.lastIndexOf('\n', budget)
    if (lineBoundary > Math.floor(budget * 0.8)) cut = lineBoundary
  }
  const prefix = text.slice(0, safeCut(text, cut)).trimEnd()
  const limited = `${prefix}${TRUNCATION_NOTICE}`
  return {
    text: limited,
    originalChars: text.length,
    returnedChars: limited.length,
    truncated: true
  }
}
