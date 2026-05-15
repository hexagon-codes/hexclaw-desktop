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
import { BaseDirectory, resourceDir } from '@tauri-apps/api/path'
import { env } from '@/config/env'
import type { SkillMeta } from '@/types'
import { deriveProjectRoot } from '@/utils/projectRoot'

export class SkillRegistry {
  private cache: Map<string, SkillMeta> = new Map()
  private initialized = false
  private officialBaseDir: BaseDirectory
  private customBaseDir: BaseDirectory
  private resolvedResourcePath: string | undefined

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

  /**
   * 从 SKILL.md 自动生成等效元数据（skill.json 不存在或损坏时的 fallback）。
   * SKILL.md 不存在时返回 null。
   */
  private async buildFallbackMeta(skillId: string, skillDir: string, source: 'official' | 'custom'): Promise<SkillMeta | null> {
    try {
      await readTextFile(`${skillDir}/SKILL.md`)
      const meta: SkillMeta = {
        skillId,
        displayName: skillId,
        version: '0.0.0',
        description: '',
        capabilities: [],
        entry: 'SKILL.md',
        path: `skills/${skillId}`,
        source,
      }
      console.info(`[SkillRegistry] skill "${skillId}" 无 skill.json，从 SKILL.md 自动生成元数据`)
      return meta
    } catch {
      return null
    }
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
        // skill.json 不存在或损坏 → 尝试从 SKILL.md 自动生成等效元数据
        const fallback = await this.buildFallbackMeta(skillId, `skills/${skillId}`, source)
        if (fallback) {
          result.set(skillId, fallback)
        } else {
          console.warn(`[SkillRegistry] 加载 skill "${skillId}" 失败:`, e)
        }
      }
    }

    return result
  }

  /**
   * 扫描两棵 skills/ 目录。
   * 先扫 Official 再扫 Custom，冲突时保留 Official 跳过 Custom。
   *
   * Fallback: 若 BaseDirectory.Resource 扫描结果为空，
   * 尝试用 resourceDir() 解析的实际路径重新扫描（dev 模式兼容）。
   */
  private async discoverSkills(): Promise<void> {
    // 1. 扫描 Official
    let officialSkills = await this.discoverFromDir(this.officialBaseDir, 'official')

    // 诊断：打印 BaseDirectory.Resource 扫描结果
    console.info(`[SkillRegistry] BaseDirectory.Resource 扫描: ${officialSkills.size} 个 skill`)

    // Fallback: BaseDirectory.Resource 在 dev 模式下可能不指向项目根
    if (officialSkills.size === 0) {
      try {
        const actualResourceDir = await resourceDir()
        if (actualResourceDir) {
          this.resolvedResourcePath = actualResourceDir
          console.info(`[SkillRegistry] resourceDir() 解析路径: ${actualResourceDir}`)
          officialSkills = await this.discoverFromPath(actualResourceDir, 'official')
          console.info(`[SkillRegistry] resourceDir fallback 扫描: ${officialSkills.size} 个 skill`)
        }
      } catch (e) {
        console.warn(`[SkillRegistry] resourceDir() 不可用:`, e)
      }
    }

    // Fallback: dev 模式下尝试从项目根目录加载 skills/
    if (officialSkills.size === 0 && env.isDev) {
      try {
        // dev 模式下 resourceDir() 通常指向 src-tauri/target/debug
        // 需要向上两级找到项目根目录
        const actualResourceDir = await resourceDir()
        if (actualResourceDir) {
          const projectRoot = deriveProjectRoot(actualResourceDir)
          console.info(`[SkillRegistry] dev 模式回退项目根: ${projectRoot}`)
          officialSkills = await this.discoverFromPath(projectRoot, 'official')
          console.info(`[SkillRegistry] 项目根 fallback 扫描: ${officialSkills.size} 个 skill`)
        }
      } catch (e) {
        console.warn(`[SkillRegistry] 项目根 fallback 失败:`, e)
      }
    }

    for (const [id, meta] of officialSkills) {
      this.cache.set(id, meta)
    }

    // 2. 扫描 Custom，冲突保留 Official
    const customSkills = await this.discoverFromDir(this.customBaseDir, 'custom')
    console.info(`[SkillRegistry] AppData 扫描: ${customSkills.size} 个 skill`)
    for (const [id, meta] of customSkills) {
      if (this.cache.has(id)) {
        console.warn(`[SkillRegistry] Custom skill "${id}" 与 Official 冲突，已忽略`)
        continue
      }
      this.cache.set(id, meta)
    }

    console.info(`[SkillRegistry] 总计注册: ${this.cache.size} 个 skill`, Array.from(this.cache.keys()))
  }

  /**
   * 从绝对路径扫描 skills/ 子目录（dev 模式 fallback）。
   * 与 discoverFromDir 逻辑相同，但使用绝对路径而非 BaseDirectory。
   */
  private async discoverFromPath(
    absolutePath: string,
    source: 'official' | 'custom',
  ): Promise<Map<string, SkillMeta>> {
    const result = new Map<string, SkillMeta>()
    let entries: { name: string; isDirectory: boolean }[]

    try {
      const dirEntries = await readDir(`${absolutePath}/skills`)
      entries = dirEntries
    } catch {
      return result
    }

    for (const entry of entries) {
      if (!entry.name || !entry.isDirectory) continue
      const skillId = this.sanitizeSkillId(entry.name)
      if (!skillId) continue

      try {
        const raw = await readTextFile(`${absolutePath}/skills/${skillId}/skill.json`)
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
        // skill.json 不存在或损坏 → 尝试从 SKILL.md 自动生成等效元数据
        const fallback = await this.buildFallbackMeta(skillId, `${absolutePath}/skills/${skillId}`, source)
        if (fallback) {
          result.set(skillId, fallback)
        } else {
          console.warn(`[SkillRegistry] 加载 skill "${skillId}" 失败:`, e)
        }
      }
    }

    return result
  }

  /**
   * 净化 skillId：阻止路径穿越。
   *
   * 设计决策：返回空字符串而非抛出错误（与 SkillLoader.sanitizeSkillId 不同）。
   * - Registry 在目录迭代场景调用，非法输入应跳过继续（返回空 → if (!skillId) continue）。
   * - Loader 在已知 skill ID 场景调用，非法输入说明存在 bug，应崩溃。
   */
  private sanitizeSkillId(id: string): string {
    const sanitized = id.toLowerCase().replace(/[^a-z0-9_-]/g, '')
    if (!sanitized || sanitized.startsWith('.') || sanitized.includes('..')) {
      return ''
    }
    return sanitized
  }
}
