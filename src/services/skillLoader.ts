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
import { BaseDirectory } from '@tauri-apps/api/path'
import type { SkillMeta, SkillPackage, SkillReference } from '@/types'
import { estimateSize } from '@/utils/sizeEstimator'

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

    // ── 1. 读取 meta（必选） ──────────────────────────

    const raw = await readTextFile(`skills/${safeId}/skill.json`, {
      baseDir: this.baseDir,
    })
    const parsed = JSON.parse(raw)

    const meta: SkillMeta = {
      skillId: safeId,
      displayName: parsed.display_name ?? parsed.name ?? safeId,
      version: parsed.version ?? '0.0.0',
      description: parsed.description ?? '',
      capabilities: Array.isArray(parsed.capabilities) ? parsed.capabilities : [],
      entry: parsed.entry ?? 'SKILL.md',
      path: `skills/${safeId}`,
    }

    // ── 2. 读取 SKILL.md（可选） ──────────────────────

    let markdown: string | undefined
    if (loadMarkdown) {
      try {
        markdown = await readTextFile(`skills/${safeId}/SKILL.md`, {
          baseDir: this.baseDir,
        })
      } catch {
        // SKILL.md 不存在或不可读 — 静默处理
        markdown = undefined
      }
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

  // ── 内部辅助 ─────────────────────────────────────────

  /**
   * 校验并净化 skillId，阻止路径穿越。
   *
   * 规则：
   * - 允许：a-z、0-9、-、_、/（支持嵌套路径如 builtin/summarize）
   * - 禁止：空字符串、..、\、绝对路径（/ 开头）、连续 //
   * - 自动转小写
   *
   * @throws 当 skillId 非法时抛出明确错误
   */
  private sanitizeSkillId(skillId: string): string {
    if (!skillId || skillId.trim().length === 0) {
      throw new Error(`[SkillLoader] 非法 skillId: 空字符串`)
    }

    const normalized = skillId.trim().toLowerCase()

    // 禁止反斜杠（禁止 Windows 路径分隔符）
    if (normalized.includes('\\')) {
      throw new Error(`[SkillLoader] 非法 skillId: 禁止反斜杠 "\\"`)
    }

    // 禁止路径穿越
    if (normalized.includes('..')) {
      throw new Error(`[SkillLoader] 非法 skillId: 禁止路径穿越 ".."`)
    }

    // 禁止连续斜杠
    if (normalized.includes('//')) {
      throw new Error(`[SkillLoader] 非法 skillId: 禁止连续斜杠 "//"`)
    }

    // 禁止绝对路径（/ 开头）
    if (normalized.startsWith('/')) {
      throw new Error(`[SkillLoader] 非法 skillId: 禁止绝对路径`)
    }

    // 禁止 Windows 绝对路径（如 c:）
    if (/^[a-z]:/.test(normalized)) {
      throw new Error(`[SkillLoader] 非法 skillId: 禁止 Windows 盘符路径`)
    }

    // 仅允许 a-z 0-9 - _ /
    if (!/^[a-z0-9_/-]+$/.test(normalized)) {
      throw new Error(`[SkillLoader] 非法 skillId: 仅允许 a-z、0-9、-、_、/`)
    }

    return normalized
  }
}
