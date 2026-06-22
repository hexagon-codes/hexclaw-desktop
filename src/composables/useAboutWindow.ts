import { useRouter } from 'vue-router'
import { invoke } from '@tauri-apps/api/core'

/**
 * 打开「关于」窗口的统一入口。
 *
 * 所有版本号入口（侧栏引擎版本 / 设置应用版本 / 未来其它）都复用此 composable，
 * 最终都打开同一个 `/about`（AboutView）——单一关于页，无内容复制：
 *   - Tauri 环境：调用 `open_about` 命令，复用 macOS 菜单同一套独立关于窗口（已开则聚焦）。
 *   - 非 Tauri（浏览器 dev / 命令缺失）：回退应用内路由到 /about，保证 dev 下可达。
 */
export function useAboutWindow() {
  const router = useRouter()
  return async function openAbout(): Promise<void> {
    try {
      await invoke('open_about')
    } catch {
      await router.push('/about')
    }
  }
}
