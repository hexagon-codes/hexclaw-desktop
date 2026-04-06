/**
 * 从文本中提取 <think>/<thinking> 标签内容。
 * 某些模型（如智谱 glm-z1-airx）会在 content 中直接返回思考过程，
 * 需要前端兜底解析，将其拆分到 reasoning 字段。
 *
 * 安全策略：仅匹配文本开头的标签（reasoning 模型总是在开头输出 think 块），
 * 避免误匹配正文或代码中出现的 <think> 字面量。
 */
export function extractThinkTags(text: string): { content: string; reasoning: string } {
  // 匹配开头的 <think> 或 <thinking>（允许前导空白）
  const match = text.match(/^\s*<(think(?:ing)?)>/)
  if (!match) return { content: text, reasoning: '' }

  const tag = match[1] // "think" 或 "thinking"
  const openTag = `<${tag}>`
  const closeTag = `</${tag}>`
  const startIdx = text.indexOf(openTag)
  const endIdx = text.indexOf(closeTag, startIdx)

  if (endIdx === -1) {
    // 尚未收到闭合标签（流式中），全部视为 reasoning
    return { content: '', reasoning: text.slice(startIdx + openTag.length) }
  }
  const reasoning = text.slice(startIdx + openTag.length, endIdx).trim()
  const content = text.slice(endIdx + closeTag.length).trim()
  return { content, reasoning }
}
