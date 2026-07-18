type TranslateMessage = (path: string) => string
type HasMessage = (path: string) => boolean

/**
 * Translate a known member of an otherwise open identifier set.
 *
 * vue-i18n logs a missing-key warning before applying `t(path, fallback)`. That is correct for
 * closed product copy, but noisy and misleading for extensible identifiers such as MCP tools or
 * provider capabilities. Probe with `te` first; unknown identifiers remain readable verbatim.
 */
export function translateOpenIdentifier(
  translate: TranslateMessage,
  exists: HasMessage,
  namespace: string,
  identifier: string,
): string {
  const value = identifier.trim()
  if (!value) return ''
  const prefix = namespace.replace(/\.+$/, '')
  const path = prefix ? `${prefix}.${value}` : value
  return exists(path) ? translate(path) : value
}
