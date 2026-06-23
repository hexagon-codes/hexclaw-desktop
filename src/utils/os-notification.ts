import { logger } from './logger'

/**
 * 发送系统级桌面通知（Tauri notification 插件）。
 *
 * - 非 Tauri 环境（浏览器 dev / 测试）：动态 import 失败 → 静默无操作，不抛错。
 * - 权限未授予时按需申请一次；用户拒绝则放弃。
 * - 调用方负责决定「何时」发（一般仅在 app 失焦时），本函数只负责「怎么发」。
 */
export async function sendOsNotification(title: string, body?: string): Promise<void> {
  try {
    const mod = await import('@tauri-apps/plugin-notification')
    let granted = await mod.isPermissionGranted()
    if (!granted) {
      const perm = await mod.requestPermission()
      granted = perm === 'granted'
    }
    if (granted) {
      mod.sendNotification(body ? { title, body } : { title })
    }
  } catch (e) {
    logger.debug('[osNotification] 跳过（非 Tauri 环境或权限不可用）:', e)
  }
}
