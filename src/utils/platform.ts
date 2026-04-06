/** 平台检测工具 — 单一来源 */

/** 检测是否运行在 Tauri 桌面环境中（与 @tauri-apps/api/core 保持一致） */
export function isTauri(): boolean {
  return !!(globalThis as Record<string, unknown>).isTauri
}

/** 动态获取用户 home 目录，兼容 Windows / Linux / macOS */
export async function resolveUserHome(): Promise<string | null> {
  if (isTauri()) {
    try {
      const { homeDir } = await import('@tauri-apps/api/path')
      return await homeDir()
    } catch {
      // Tauri path API 不可用时降级
    }
  }
  return null
}
