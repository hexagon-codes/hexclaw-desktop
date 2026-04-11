/** Composables 统一入口 */

// ─── UI 交互 ─────────────────────────────────────────
export { useTheme } from './useTheme'
export { useShortcuts } from './useShortcuts'
export { useKeyboardNav, trapFocus } from './useKeyboardNav'
export { useToast } from './useToast'

// ─── 服务 / 通信 ────────────────────────────────────
export { useSSE } from './useSSE'
export { useWebSocket } from './useWebSocket'
export { useHexclaw } from './useHexclaw'

// ─── 表单 ───────────────────────────────────────────
export { useValidation, rules } from './useValidation'
export type { ValidationRule, FieldErrors } from './useValidation'

// ─── Chat ────────────────────────────────────────────
export { useConversationAutomation } from './useConversationAutomation'
export { useChatSend } from './useChatSend'
export { useChatActions } from './useChatActions'

// ─── 语音 ────────────────────────────────────────────
export { useVoice } from './useVoice'

// ─── Tauri 桌面能力 ─────────────────────────────────
export { useAutoUpdate } from './useAutoUpdate'
