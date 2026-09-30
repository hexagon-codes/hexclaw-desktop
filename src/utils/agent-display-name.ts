import { INPUT_LIMITS, inputLimitError } from './input-limits'

export const AGENT_DISPLAY_NAME_MAX_CHARACTERS = INPUT_LIMITS.displayName

export function isAgentDisplayNameValid(value: string | undefined, original?: string): boolean {
  const name = value ?? ''
  if (original !== undefined && name === original) return true
  return !inputLimitError(name, 'Display name', AGENT_DISPLAY_NAME_MAX_CHARACTERS)
}
