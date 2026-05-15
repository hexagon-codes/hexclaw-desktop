/**
 * SkillLoader — Skill 文件加载器
 *
 * 职责：
 * - 读取 skill.json → meta
 * - 按需读取 SKILL.md（markdown）
 * - 按需扫描 references/ 目录（仅路径，不读文件内容）
 * - 构建 SkillPackage
 *
 * 不做：
 * - 语义解析 SKILL.md
 * - 缓存 markdown/references（Registry 只缓存 meta）
 * - SkillLayer 构建（那是 ContextLoader 的职责）
 * - Skill Match
 *
 * @see docs/agents-OS/Skill-Spec.md
 */

import { readDir, readTextFile } from '@tauri-apps/plugin-fs'
import { BaseDirectory, resourceDir } from '@tauri-apps/api/path'
import { env } from '@/config/env'
import type { SkillMeta, SkillPackage, SkillReference, SkillLayer } from '@/types'
import { estimateSize } from '@/utils/sizeEstimator'

// ─── Error Helper ─────────────────────────────────────

/** 构造带 code 的结构化错误，供 Recovery classifyFailure 识别 */
function skillError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string }
  err.code = code
  return err
}

// ─── Options ─────────────────────────────────────────

export interface SkillLoadOptions {
  /** 是否加载 SKILL.md 内容（默认 false） */
  loadMarkdown?: boolean
  /** 是否扫描 references/ 目录（默认 false） */
  loadReferences?: boolean
}

// ─── SkillLoader ─────────────────────────────────────

export class SkillLoader {
  private baseDir: BaseDirectory

  constructor(baseDir: BaseDirectory = BaseDirectory.AppData) {
    this.baseDir = baseDir
  }

  /**
   * 加载 Skill 完整数据。
   *
   * 默认只读取 skill.json（meta）。
   * 仅当对应 option 为 true 时才读取 SKILL.md / references/。
   * 每次调用都重新读取，不缓存。
   *
   * @param skillId — 目录名（允许嵌套如 builtin/summarize）
   * @param options — 控制额外加载内容
   * @throws 当 skillId 格式非法或 skill.json 不存在时
   */
  async loadSkill(skillId: string, options?: SkillLoadOptions): Promise<SkillPackage> {
    const safeId = this.sanitizeSkillId(skillId)
    const loadMarkdown = options?.loadMarkdown ?? false
    const loadReferences = options?.loadReferences ?? false

    // 诊断：打印 baseDir
    console.info(`[SkillLoader] loadSkill: skillId=${safeId}, baseDir=${this.baseDir}`)

    // ── 1. 读取 meta（必选） ──────────────────────────

    let parsed: Record<string, unknown>
    try {
      parsed = await this.loadSkillJson(safeId)
    } catch (e) {
      throw skillError('SKILL_NOT_FOUND', `skill.json 不存在: skills/${safeId} (baseDir=${this.baseDir})`)
    }

    const meta: SkillMeta = {
      skillId: safeId,
      displayName: parsed.display_name ?? parsed.name ?? safeId,
      version: parsed.version ?? '0.0.0',
      description: parsed.description ?? '',
      capabilities: Array.isArray(parsed.capabilities) ? parsed.capabilities : [],
      entry: parsed.entry ?? 'SKILL.md',
      path: `skills/${safeId}`,
      source: 'custom',
    }

    // ── 2. 读取 SKILL.md（可选） ──────────────────────

    let markdown: string | undefined
    if (loadMarkdown) {
      markdown = await this.readSkillFile(safeId, 'SKILL.md')
    }

    // ── 3. 扫描 references/（可选，只索引路径不读内容） ──

    let references: SkillReference[] = []
    if (loadReferences) {
      try {
        const refEntries = await readDir(`skills/${safeId}/references`, {
          baseDir: this.baseDir,
        })
        references = refEntries
          .filter((e) => e.isFile && e.name)
          .map((e) => ({
            relativePath: e.name!,
            absolutePath: `skills/${safeId}/references/${e.name}`,
          }))
      } catch {
        // references/ 目录不存在 — 静默处理
      }
    }

    // ── 4. 估算大小 ─────────────────────────────────────

    const estimatedSize = estimateSize({ meta, markdown, references })

    return { meta, markdown, references, estimatedSize }
  }

  /**
   * 加载指定层的 Skill 数据。
   *
   * 从 skill.json 的 layers 数组中找到匹配 layerId 的层，
   * 读取该层的 file 内容作为 markdown。
   * 无 layers 声明时回退到 loadSkill() 默认行为。
   *
   * @param skillId — 目录名
   * @param layerId — 层 ID（如 'base', 'advanced'）
   * @param options — 控制额外加载内容
   */
  async loadSkillLayer(skillId: string, layerId: string, options?: SkillLoadOptions): Promise<SkillPackage> {
    const safeId = this.sanitizeSkillId(skillId)
    const parsed = await this.loadSkillJson(safeId)
    const layers = Array.isArray(parsed.layers) ? parsed.layers : []

    // 无 layers 声明 → 回退到默认行为
    if (layers.length === 0) {
      return this.loadSkill(safeId, options)
    }

    const layer = layers.find((l: SkillLayer) => l.id === layerId)
    if (!layer) {
      throw skillError('SKILL_LAYER_NOT_FOUND', `layer "${layerId}" 不存在: skills/${safeId}`)
    }

    // 读取 layer 指定的文件内容
    let markdown: string | undefined
    if (options?.loadMarkdown !== false) {
      markdown = await this.readSkillFile(safeId, layer.file)
    }

    const meta = this.buildMeta(safeId, parsed)
    const references = options?.loadReferences ? await this.loadReferences(safeId) : []
    const estimatedSize = estimateSize({ meta, markdown, references })

    return { meta, markdown, references, estimatedSize }
  }

  /**
   * 按 trigger 匹配加载 Skill 层。
   *
   * 遍历 skill.json 的 layers 数组，找到 trigger 匹配的层并加载。
   * 无匹配时回退到 trigger='always' 的层，再无则回退到 loadSkill()。
   *
   * @param skillId — 目录名
   * @param trigger — 触发词（如 'user-deep-dive'）
   * @param options — 控制额外加载内容
   */
  async loadSkillByTrigger(skillId: string, trigger: string, options?: SkillLoadOptions): Promise<SkillPackage> {
    const safeId = this.sanitizeSkillId(skillId)
    const parsed = await this.loadSkillJson(safeId)
    const layers = Array.isArray(parsed.layers) ? parsed.layers : []

    // 无 layers 声明 → 回退到默认行为
    if (layers.length === 0) {
      return this.loadSkill(safeId, options)
    }

    // 精确匹配 trigger
    const matchedLayer = layers.find((l: SkillLayer) => l.trigger === trigger)
    if (matchedLayer) {
      return this.loadSkillLayer(safeId, matchedLayer.id, options)
    }

    // 回退到 'always' 层
    const alwaysLayer = layers.find((l: SkillLayer) => l.trigger === 'always')
    if (alwaysLayer) {
      return this.loadSkillLayer(safeId, alwaysLayer.id, options)
    }

    // 回退到 loadSkill()
    return this.loadSkill(safeId, options)
  }

  // ── 内部辅助 ─────────────────────────────────────────

  /**
   * 读取并解析 skill.json，返回 parsed 对象。
   * 先尝试 baseDir，dev 模式下回退到项目根目录。
   */
  private async loadSkillJson(skillId: string): Promise<Record<string, unknown>> {
    const raw = await this.readSkillJson(skillId)
    try {
      return JSON.parse(raw)
    } catch {
      throw skillError('SKILL_PARSE_ERROR', `skill.json JSON 解析失败: skills/${skillId}`)
    }
  }

  /**
   * 读取 skill.json 原始内容。
   * 先尝试 baseDir，dev 模式下回退到项目根目录。
   */
  private async readSkillJson(skillId: string): Promise<string> {
    try {
      return await readTextFile(`skills/${skillId}/skill.json`, { baseDir: this.baseDir })
    } catch {
      if (env.isDev) {
        try {
          const actualResourceDir = await resourceDir()
          if (actualResourceDir) {
            const projectRoot = actualResourceDir
              .replace(/[/\\]src[/\\]tauri[/\\]target[/\\].*$/, '')
              .replace(/[/\\]target[/\\].*$/, '')
            return await readTextFile(`${projectRoot}/skills/${skillId}/skill.json`)
          }
        } catch {
          // fallback 失败，下面统一抛错
        }
      }
      throw skillError('SKILL_NOT_FOUND', `skill.json 不存在: skills/${skillId}`)
    }
  }

  /**
   * 读取 skill 目录下的文件内容。
   * 先尝试 baseDir，dev 模式下回退到项目根目录。
   *
   * 安全：验证 fileName 防止路径穿越（如 '../../etc/passwd'）。
   */
  private async readSkillFile(skillId: string, fileName: string): Promise<string | undefined> {
    if (fileName.includes('..') || fileName.startsWith('/') || fileName.startsWith('\\')) {
      throw skillError('INVALID_PATH', `非法文件路径: skills/${skillId}/${fileName}`)
    }

    try {
      return await readTextFile(`skills/${skillId}/${fileName}`, { baseDir: this.baseDir })
    } catch {
      if (env.isDev) {
        try {
          const actualResourceDir = await resourceDir()
          if (actualResourceDir) {
            const projectRoot = actualResourceDir
              .replace(/[/\\]src[/\\]tauri[/\\]target[/\\].*$/, '')
              .replace(/[/\\]target[/\\].*$/, '')
            return await readTextFile(`${projectRoot}/skills/${skillId}/${fileName}`)
          }
        } catch {
          // fallback 失败
        }
      }
      return undefined
    }
  }

  /** 从 parsed skill.json 构建 SkillMeta */
  private buildMeta(skillId: string, parsed: Record<string, unknown>): SkillMeta {
    return {
      skillId,
      displayName: parsed.display_name ?? parsed.name ?? skillId,
      version: parsed.version ?? '0.0.0',
      description: parsed.description ?? '',
      capabilities: Array.isArray(parsed.capabilities) ? parsed.capabilities : [],
      entry: parsed.entry ?? 'SKILL.md',
      path: `skills/${skillId}`,
      source: 'custom',
    }
  }

  /** 加载 references/ 目录索引 */
  private async loadReferences(skillId: string): Promise<SkillReference[]> {
    try {
      const refEntries = await readDir(`skills/${skillId}/references`, { baseDir: this.baseDir })
      return refEntries
        .filter((e) => e.isFile && e.name)
        .map((e) => ({
          relativePath: e.name!,
          absolutePath: `skills/${skillId}/references/${e.name}`,
        }))
    } catch {
      return []
    }
  }

  /**
   * 校验并净化 skillId，阻止路径穿越。
   *
   * 设计决策：抛出错误（与 SkillRegistry.sanitizeSkillId 不同）。
   * - Loader 在已知 skill ID 场景调用，非法输入说明存在 bug，应崩溃而非静默跳过。
   * - Registry 在目录迭代场景调用，非法输入应跳过继续，返回空字符串。
   *
   * 规则：
   * - 仅允许：a-z、0-9、-、_
   * - 其余字符一律剥离
   * - 空字符串、. 开头、.. 包含 → 抛出错误
   *
   * @throws 当 skillId 非法时抛出明确错误
   */
  private sanitizeSkillId(skillId: string): string {
    if (!skillId || skillId.trim().length === 0) {
      throw skillError('SKILL_PATH_TRAVERSAL', '非法 skillId: 空字符串')
    }

    const normalized = skillId.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')

    if (!normalized || normalized.startsWith('.') || normalized.includes('..')) {
      throw skillError('SKILL_PATH_TRAVERSAL', `非法 skillId: "${skillId}"`)
    }

    return normalized
  }
}
