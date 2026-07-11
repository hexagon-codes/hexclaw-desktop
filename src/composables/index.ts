/** Composables 统一入口 */

// ─── UI 交互 ─────────────────────────────────────────
export { useTheme } from './useTheme'
export { useShortcuts } from './useShortcuts'
export { useToast } from './useToast'

// ─── Chat ────────────────────────────────────────────
export { useConversationAutomation } from './useConversationAutomation'
export { useChatSend } from './useChatSend'
export { useChatActions } from './useChatActions'
export { useCronCompileLabel } from './useCronCompileLabel'

// ─── 语音 ────────────────────────────────────────────
export { useVoice } from './useVoice'

// ─── Tauri 桌面能力 ─────────────────────────────────
export { useAutoUpdate } from './useAutoUpdate'
