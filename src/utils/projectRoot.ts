/**
 * projectRoot — 从 Tauri resourceDir() 推导项目根目录
 *
 * Tauri resourceDir() 在 dev 模式下通常指向 src-tauri/target/debug，
 * 需要向上两级找到项目根目录。生产模式下直接返回 resourceDir 本身。
 */

/**
 * 从 Tauri resourceDir() 解析的绝对路径推导项目根目录。
 *
 * dev 模式下 resourceDir() 通常指向 src-tauri/target/{debug|release}，
 * 此函数剥离这些构建路径返回实际项目根。
 *
 * @param resourceDirPath — resourceDir() 返回的绝对路径
 * @param hasSrcTauri — 路径是否包含 src/tauri 前缀（默认 true）
 * @returns 项目根目录绝对路径
 */
export function deriveProjectRoot(resourceDirPath: string, hasSrcTauri = true): string {
  if (hasSrcTauri) {
    return resourceDirPath
      .replace(/[/\\]src[/\\]tauri[/\\]target[/\\].*$/, '')
      .replace(/[/\\]target[/\\].*$/, '')
  }
  return resourceDirPath.replace(/[/\\]target[/\\].*$/, '')
}
