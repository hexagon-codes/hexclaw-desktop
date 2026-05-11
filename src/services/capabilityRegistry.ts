/**
 * CapabilityRegistry — Capability 声明式注册表
 *
 * 职责：
 * - 维护内置 Capability 列表
 * - 提供存在性检查（hasCapability）
 * - Lazy init（同 SkillRegistry 模式）
 *
 * 不做：
 * - Policy 验证（那是 CapabilityValidator 的职责）
 * - 动态注册/注销
 * - 文件扫描
 * - Dependency DAG
 *
 * @see docs/agents-OS/Capability-Spec.md
 */

import type { CapabilityName, CapabilityDescriptor } from '@/types/capability'
import { BUILTIN_CAPABILITIES, BUILTIN_CAPABILITY_NAMES } from '@/types/capability'

export class CapabilityRegistry {
  private registry: Map<CapabilityName, CapabilityDescriptor> = new Map()
  private initialized = false

  // ── Lazy Init ────────────────────────────────────────

  private ensureInitialized(): void {
    if (this.initialized) return
    this.registerBuiltinCapabilities()
    this.initialized = true
  }

  private registerBuiltinCapabilities(): void {
    for (const cap of BUILTIN_CAPABILITIES) {
      this.registry.set(cap.name, cap)
    }
  }

  // ── 查询接口 ─────────────────────────────────────────

  /** Capability 是否存在 */
  hasCapability(name: CapabilityName): boolean {
    this.ensureInitialized()
    return BUILTIN_CAPABILITY_NAMES.has(name) || this.registry.has(name)
  }

  /** 获取 Capability 描述信息 */
  getCapability(name: CapabilityName): CapabilityDescriptor | undefined {
    this.ensureInitialized()
    return this.registry.get(name)
  }

  /** 获取所有已注册 Capability */
  getAllCapabilities(): CapabilityDescriptor[] {
    this.ensureInitialized()
    return Array.from(this.registry.values())
  }

  /** 已注册 Capability 数量 */
  get size(): number {
    this.ensureInitialized()
    return this.registry.size
  }
}
