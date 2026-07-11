/**
 * solve 验算结论（verified solving · 架构 §7.1 / §8.1 / AP-5 信任即架构）。
 *
 * 验算徽章是**架构层的验证与标注**，不是"prompt 写好点"。三态诚实：
 * - agree      → ✅ 一致（有强证据时显"已程序验算"）
 * - disagree   → ⚠️ 不一致：并列双答、请家长复核，绝不只报一个装确定
 * - out_of_scope → ⛔ 超纲：已用学段内方法重解
 * - unverifiable → 无法独立验证（弱信号，不显强徽章）
 */
export type VerifyVerdict = 'agree' | 'disagree' | 'unverifiable' | 'out_of_scope'

/**
 * 证据类型（§5.3.2 强信任徽章证据门）：
 * - program_verified：code_exec 独立重算（强证据，可显"已程序验算"）
 * - model_review：模型复核（弱信号；Solver/Verifier 同源时禁显强徽章 §8.1）
 */
export type VerifyEvidence = 'program_verified' | 'model_review'

export interface VerifyResult {
  verdict: VerifyVerdict
  evidence: VerifyEvidence
  /** disagree 时并列的多个候选答案（诚实双答，AP-5） */
  answers?: string[]
  /** 约束范围描述 i18n key 或字面（范围内说明，由场景数据流入） */
  scopeNote?: string
  /** out_of_scope：检测到的越界信息（用于"已重解"提示） */
  outOfScope?: {
    /** 越界的知识点/概念 */
    detected?: string
    /** 应有层级/阶段 */
    grade?: string
  }
}

/** 徽章可显示的强证据判定（同源模型复核不显"已程序验算" · §9.3 Don'ts #11） */
export function isStrongEvidence(r: Pick<VerifyResult, 'evidence'>): boolean {
  return r.evidence === 'program_verified'
}
