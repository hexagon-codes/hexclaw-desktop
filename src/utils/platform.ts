/** 平台检测工具 — 单一来源 */

/** 检测是否运行在 Tauri 桌面环境中（与 @tauri-apps/api/core 保持一致） */
export function isTauri(): boolean {
  return !!(globalThis as Record<string, unknown>).isTauri
}
