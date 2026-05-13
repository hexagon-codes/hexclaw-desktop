/**
 * SkillRegistry — Skill 元数据发现与缓存
 *
 * 职责：
 * - 扫描 skills/{skillId}/skill.json 目录
 * - 缓存 SkillMeta（全量，一次性加载）
 * - Lazy initialize：resolveSkill / getAllSkills 首次调用时自动触发 discover
 *
 * 不做：
 * - 目录监听 / 热更新
 * - SKILL.md / references 内容读取（那是 SkillLoader 的职责）
 * - Skill Match
 *
 * @see docs/agents-OS/Skill-Spec.md
 */

import { readDir, readTextFile } from '@tauri-apps/plugin-fs'
import { BaseDirectory } from '@tauri-apps/api/path'
import type { SkillMeta } from '@/types'

export class SkillRegistry {
  private cache: Map<string, SkillMeta> = new Map()
  private initialized = false
  private officialBaseDir: BaseDirectory
  private customBaseDir: BaseDirectory

  constructor(
    officialBaseDir: BaseDirectory = BaseDirectory.Resource,
    customBaseDir: BaseDirectory = BaseDirectory.AppData,
  ) {
    this.officialBaseDir = officialBaseDir
    this.customBaseDir = customBaseDir
  }

  // ── Lazy Initialize ──────────────────────────────────

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return
    await this.discoverSkills()
    this.initialized = true
  }

  // ── 查询接口 ─────────────────────────────────────────

  /** 按 skillId 查找 Skill（首次调用自动触发 discover） */
  async resolveSkill(skillId: string): Promise<SkillMeta | undefined> {
    await this.ensureInitialized()
    return this.cache.get(skillId)
  }

  /** 获取所有 Skill 列表（首次调用自动触发 discover） */
  async getAllSkills(): Promise<SkillMeta[]> {
    await this.ensureInitialized()
    return Array.from(this.cache.values())
  }

  /** 已发现 Skill 数量 */
  get size(): number {
    return this.cache.size
  }

  // ── 内部 ─────────────────────────────────────────────

  /**
   * 从指定目录扫描 skills/，读取所有 skill.json。
   * 单个 skill.json 损坏只 warn 跳过。
   * 目录不存在时静默返回空 Map。
   */
  private async discoverFromDir(
    baseDir: BaseDirectory,
    source: 'official' | 'custom',
  ): Promise<Map<string, SkillMeta>> {
    const result = new Map<string, SkillMeta>()
    let entries: { name: string; isDirectory: boolean }[]

    try {
      const dirEntries = await readDir('skills', { baseDir })
      entries = dirEntries
    } catch {
      // skills/ 目录不存在
      return result
    }

    for (const entry of entries) {
      if (!entry.name || !entry.isDirectory) continue

      const skillId = this.sanitizeSkillId(entry.name)
      if (!skillId) continue

      try {
        const raw = await readTextFile(`skills/${skillId}/skill.json`, {
          baseDir,
        })
        const parsed = JSON.parse(raw)

        const meta: SkillMeta = {
          skillId,
          displayName: parsed.display_name ?? parsed.name ?? skillId,
          version: parsed.version ?? '0.0.0',
          description: parsed.description ?? '',
          capabilities: Array.isArray(parsed.capabilities) ? parsed.capabilities : [],
          entry: parsed.entry ?? 'SKILL.md',
          path: `skills/${skillId}`,
          source,
        }

        result.set(skillId, meta)
      } catch (e) {
        console.warn(`[SkillRegistry] 加载 skill "${skillId}" 失败:`, e)
      }
    }

    return result
  }

  /**
   * 扫描两棵 skills/ 目录。
   * 先扫 Official 再扫 Custom，冲突时保留 Official 跳过 Custom。
   */
  private async discoverSkills(): Promise<void> {
    // 1. 扫描 Official
    const officialSkills = await this.discoverFromDir(this.officialBaseDir, 'official')
    for (const [id, meta] of officialSkills) {
      this.cache.set(id, meta)
    }

    // 2. 扫描 Custom，冲突保留 Official
    const customSkills = await this.discoverFromDir(this.customBaseDir, 'custom')
    for (const [id, meta] of customSkills) {
      if (this.cache.has(id)) {
        console.warn(`[SkillRegistry] Custom skill "${id}" 与 Official 冲突，已忽略`)
        continue
      }
      this.cache.set(id, meta)
    }
  }

  /** 净化 skillId：阻止路径穿越 */
  private sanitizeSkillId(id: string): string {
    const sanitized = id.toLowerCase().replace(/[^a-z0-9_-]/g, '')
    if (!sanitized || sanitized.startsWith('.') || sanitized.includes('..')) {
      return ''
    }
    return sanitized
  }
}
