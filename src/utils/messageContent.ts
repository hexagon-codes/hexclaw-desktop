/**
 * 历史脏数据清理：旧版本曾把图像 base64 直接写进消息 content，气泡会渲染整条 base64 长串。
 *
 * 收紧判据（避免误伤长英文段落 / 代码回复）：只替换
 *   1) 真正的 `data:image/...;base64,....` 图像数据 URL，或
 *   2) 600+ 连续无空白的裸 base64 run（自然语言/代码有空格换行标点，run 不会到 600）。
 * 用 String.replace 只挖掉命中的 base64 段、保留周围正文；<=800 字符直接短路（新版生成消息
 * content 恒为短文本如「已生成 N 张图像」，永不触发）。
 */
const IMAGE_B64_RE =
  /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{200,}|[A-Za-z0-9+/]{600,}={0,2}/gi

export function sanitizeMessageContent(content: string): string {
  if (!content) return ''
  if (content.length <= 800) return content
  return content.replace(IMAGE_B64_RE, '[图像数据 · 历史消息已截断]')
}
