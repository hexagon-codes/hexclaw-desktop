/**
 * CapabilityValidator — Capability Policy 验证器
 *
 * 职责：
 * - 验证 Skill 的 capability 声明是否符合 System Policy
 *
 * 规则链（按顺序）：
 * 1. 未知 cap → warn + 从有效列表移除（静默降级）
 * 2. 不在 allowedCapabilities → warn
 * 3. 在 deniedCapabilities → warn
 *
 * 验证不阻断注入（Phase 4 策略）。
 *
 * 不做：
 * - Capability 存在性检查（那是 Registry 的职责）
 * - 阻断注入
 * - Capability auto-inference
 * - Dependency DAG
 *
 * @see docs/agents-OS/Capability-Spec.md
 */

import type { CapabilityName } from '@/types/capability'

export interface CapabilityValidationResult {
  /** 是否全部通过（无 unknown / unauthorized / denied） */
  valid: boolean
  /** 未在 Registry 中注册的 cap */
  unknownCaps: CapabilityName[]
  /** 不在 allowedCapabilities 中的 cap */
  unauthorizedCaps: CapabilityName[]
  /** 在 deniedCapabilities 中的 cap */
  deniedCaps: CapabilityName[]
  /** 实际生效的 cap 列表（unknown 已被移除） */
  effectiveCaps: CapabilityName[]
  /** 警告信息列表 */
  warnings: string[]
}

export class CapabilityValidator {
  /**
   * 验证 Skill Capability 是否符合 System Policy。
   *
   * @param skillCaps — Skill 声明的 capability 列表
   * @param policy — System Layer policy
   * @param registry — CapabilityRegistry（存在性检查）
   */
  validate(
    skillCaps: CapabilityName[],
    policy: {
      allowedCapabilities: CapabilityName[]
      deniedCapabilities: CapabilityName[]
    },
    hasCapability: (name: CapabilityName) => boolean,
  ): CapabilityValidationResult {
    const unknownCaps: CapabilityName[] = []
    const unauthorizedCaps: CapabilityName[] = []
    const deniedCaps: CapabilityName[] = []
    const warnings: string[] = []

    const effectiveCaps: CapabilityName[] = []

    for (const cap of skillCaps) {
      // 1. 未知 cap 检查
      if (!hasCapability(cap)) {
        unknownCaps.push(cap)
        warnings.push(`未知 capability "${cap}"，已从有效列表移除`)
        continue // 未知 cap 不进入 effective
      }

      // 2. 越权检查（不在 allowed 中）
      if (!policy.allowedCapabilities.includes(cap)) {
        unauthorizedCaps.push(cap)
        warnings.push(`Capability "${cap}" 不在 allowedCapabilities 中`)
      }

      // 3. 拒绝列表检查
      if (policy.deniedCapabilities.includes(cap)) {
        deniedCaps.push(cap)
        warnings.push(`Capability "${cap}" 在 deniedCapabilities 中`)
      }

      effectiveCaps.push(cap)
    }

    return {
      valid: unknownCaps.length === 0 && unauthorizedCaps.length === 0 && deniedCaps.length === 0,
      unknownCaps,
      unauthorizedCaps,
      deniedCaps,
      effectiveCaps,
      warnings,
    }
  }
}
