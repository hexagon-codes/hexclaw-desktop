/**
 * 模型输出「失控复读」退化检测（provider 无关的兜底熔断）。
 *
 * 背景：小型/免费 reasoning 模型在深度思考 + 歧义输入下会塌缩成「短周期无限复读」，
 * 如 `0000…`、`586158615861…`，一路烧到 maxTokens（几十秒一堵墙）。这与采样参数、
 * provider 无关，是模型本身的退化模式，故在客户端流式累积处做一道纯检测熔断。
 *
 * 判据（精确、低误报）：输出尾部存在一个长度 ≤ maxPeriod 的「周期单元」被**精确连续复读**
 * 达 minRun 个字符以上。正常文本绝不会让一个 ≤12 字的单元连续精确重复 48+ 字符。
 *   - `0000…`            → 周期 1，run 极大 → 命中
 *   - `586158615861…`    → 周期 4，run 极大 → 命中
 *   - 正常中英文/代码     → 无此类长周期精确复读 → 不命中
 */
export interface DegenerationOptions {
  /** 只看尾部多少字符（性能 + 只关心"当前是否正在复读"）。默认 160。 */
  window?: number
  /** 触发所需的最小精确复读长度（字符）。默认 48。 */
  minRun?: number
  /** 复读单元的最大周期。默认 12。 */
  maxPeriod?: number
}

export function isDegenerateTail(text: string, opts: DegenerationOptions = {}): boolean {
  const window = opts.window ?? 160
  const minRun = opts.minRun ?? 48
  const maxPeriod = opts.maxPeriod ?? 12
  if (!text || text.length < minRun) return false

  // 用 code point 数组，避免把多字节/emoji 切坏（按字符比对）
  const t = Array.from(text.slice(-window))
  for (let p = 1; p <= maxPeriod; p++) {
    // 从尾部往前数：与 p 个位置前的字符精确相等的连续长度
    let run = 0
    for (let i = t.length - 1; i - p >= 0 && t[i] === t[i - p]; i--) run++
    if (run >= minRun) return true
  }
  return false
}

/** 熔断时追加给用户的中文提示（含可操作建议）。 */
export const DEGENERATION_NOTICE =
  '\n\n⚠️ 检测到模型输出异常重复，已自动中止。建议换用稳定模型（如 glm-4-flash）或关闭「深度思考」后重试。'

/**
 * 裁掉失控复读的尾部：保留进入复读前的「干净正文」+ 一小段复读样例（让用户看到发生了什么），
 * 再由调用方拼上 DEGENERATION_NOTICE。纯函数，便于单测。
 */
export function trimDegenerateTail(
  text: string,
  opts: DegenerationOptions & { sampleKeep?: number } = {},
): string {
  const maxPeriod = opts.maxPeriod ?? 12
  const sampleKeep = opts.sampleKeep ?? 24
  const chars = Array.from(text)
  // 找复读起点：从尾部找最长的「≤maxPeriod 周期精确复读」run，定位其开头
  let bestStart = chars.length
  for (let p = 1; p <= maxPeriod; p++) {
    let run = 0
    let i = chars.length - 1
    for (; i - p >= 0 && chars[i] === chars[i - p]; i--) run++
    if (run >= (opts.minRun ?? 48)) {
      // run 段起点 ≈ i - p + 1（含一个完整周期单元作为参照）
      bestStart = Math.min(bestStart, Math.max(0, i - p + 1))
    }
  }
  if (bestStart >= chars.length) return text // 未发现复读（不应到这）
  // 干净正文 + 一小段复读样例
  return chars.slice(0, bestStart + sampleKeep).join('').trimEnd()
}
