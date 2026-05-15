/**
 * Claude Code → HexClaw Skill Importer
 *
 * 职责：
 * - 检测 Claude Code 格式的技能目录（.claude/commands/*.md, agents/*.md, hooks/*.sh）
 * - 生成 HexClaw skill.json 元数据
 * - 完整导入流程：检测 → 复制 → 转换
 *
 * 不做：
 * - 验证导入后技能的运行时兼容性
 * - 处理 Claude Code 的私有格式细节（如 prompt 模板语法）
 */

import { readDir, readTextFile, writeTextFile, mkdir, exists } from '@tauri-apps/plugin-fs'
import type { SkillCommand, SkillAgent, SkillHook } from '@/types/skill'

// ─── Types ─────────────────────────────────────────────

export interface ClaudeCodeDetection {
  isClaudeCode: boolean
  hasCommands: boolean
  hasAgents: boolean
  hasHooks: boolean
}

export interface ImportResult {
  success: boolean
  skillId: string
  warnings: string[]
}

export interface ManifestData {
  name?: string
  description?: string
  author?: string
}

// ─── Core Functions ────────────────────────────────────

/**
 * 检测目录是否为 Claude Code 格式的技能。
 *
 * Claude Code 格式特征：
 * - .claude/commands/*.md（命令定义）
 * - .claude/agents/*.md（Agent 定义）
 * - .claude/hooks/*.sh（Hook 脚本）
 */
export async function detectClaudeCodeFormat(sourceDir: string): Promise<ClaudeCodeDetection> {
  const claudeDir = `${sourceDir}/.claude`

  const [commands, agents, hooks] = await Promise.all([
    scanDir(`${claudeDir}/commands`, '.md'),
    scanDir(`${claudeDir}/agents`, '.md'),
    scanDir(`${claudeDir}/hooks`, '.sh'),
  ])

  return {
    isClaudeCode: commands.length > 0 || agents.length > 0 || hooks.length > 0,
    hasCommands: commands.length > 0,
    hasAgents: agents.length > 0,
    hasHooks: hooks.length > 0,
  }
}

/**
 * 从 Claude Code 结构自动生成 skill.json。
 *
 * 读取 .claude/commands/*.md → commands[]
 * 读取 .claude/agents/*.md → experimental.agents[]
 * 读取 .claude/hooks/*.sh → experimental.hooks[]
 */
export async function generateSkillJson(
  sourceDir: string,
  targetDir: string,
): Promise<{ skillId: string; meta: Record<string, unknown> }> {
  const dirName = sourceDir.split(/[/\\]/).pop() ?? 'imported-skill'
  const manifest = await parseManifestJson(sourceDir)

  // Scan .claude/ structure
  const claudeDir = `${sourceDir}/.claude`
  const commandFiles = await scanDir(`${claudeDir}/commands`, '.md')
  const agentFiles = await scanDir(`${claudeDir}/agents`, '.md')
  const hookFiles = await scanDir(`${claudeDir}/hooks`, '.sh')

  // Build commands
  const commands: SkillCommand[] = commandFiles.map((f) => ({
    name: f.stem,
    file: `.claude/commands/${f.name}`,
    description: `Command: ${f.stem}`,
  }))

  // Build experimental.agents
  const agents: SkillAgent[] = agentFiles.map((f) => ({
    name: f.stem,
    file: `.claude/agents/${f.name}`,
    description: `Agent: ${f.stem}`,
  }))

  // Build experimental.hooks
  const hooks: SkillHook[] = hookFiles.map((f) => ({
    name: f.stem,
    file: `.claude/hooks/${f.name}`,
    event: 'pre-task' as const,
  }))

  const skillId = manifest.name ?? dirName

  const meta: Record<string, unknown> = {
    name: skillId,
    display_name: manifest.name ?? dirName,
    version: '0.1.0',
    description: manifest.description ?? '',
    capabilities: [],
    entry: 'SKILL.md',
    commands: commands.length > 0 ? commands : undefined,
    experimental: {
      ...(agents.length > 0 ? { agents } : {}),
      ...(hooks.length > 0 ? { hooks } : {}),
    },
    _trust: { source: 'claude-code', verified: false, risk: 'medium' },
  }

  // Remove undefined experimental if empty
  if (
    meta.experimental &&
    !Array.isArray(meta.experimental.agents) &&
    !Array.isArray(meta.experimental.hooks)
  ) {
    delete meta.experimental
  }

  // Write skill.json
  const skillJsonPath = `${targetDir}/skill.json`
  await writeTextFile(skillJsonPath, JSON.stringify(meta, null, 2))

  return { skillId, meta }
}

/**
 * 完整导入 Claude Code 格式的技能到 HexClaw 格式。
 *
 * 流程：检测 → 复制 SKILL.md → 生成 skill.json → 复制 references/
 */
export async function importClaudeCodeSkill(
  sourceDir: string,
  targetDir: string,
): Promise<ImportResult> {
  const warnings: string[] = []

  // 1. 检测格式
  const detection = await detectClaudeCodeFormat(sourceDir)
  if (!detection.isClaudeCode) {
    return { success: false, skillId: '', warnings: ['目录不是 Claude Code 格式'] }
  }

  // 2. 确保目标目录存在
  await mkdir(targetDir, { recursive: true })

  // 3. 复制 SKILL.md（或从 README.md 生成）
  let skillId = ''
  try {
    const readmePath = `${sourceDir}/README.md`
    const skillMdPath = `${sourceDir}/SKILL.md`

    if (await fileExists(skillMdPath)) {
      const content = await readTextFile(skillMdPath)
      await writeTextFile(`${targetDir}/SKILL.md`, content)
    } else if (await fileExists(readmePath)) {
      const content = await readTextFile(readmePath)
      await writeTextFile(`${targetDir}/SKILL.md`, content)
      warnings.push('SKILL.md 不存在，已从 README.md 生成')
    } else {
      warnings.push('未找到 SKILL.md 或 README.md')
    }
  } catch (e) {
    warnings.push(`复制 SKILL.md 失败: ${e instanceof Error ? e.message : String(e)}`)
  }

  // 4. 生成 skill.json
  try {
    const result = await generateSkillJson(sourceDir, targetDir)
    skillId = result.skillId
  } catch (e) {
    return {
      success: false,
      skillId,
      warnings: [...warnings, `生成 skill.json 失败: ${e instanceof Error ? e.message : String(e)}`],
    }
  }

  // 5. 复制 references/ 目录（如有）
  const refsDir = `${sourceDir}/references`
  if (await fileExists(refsDir)) {
    try {
      const targetRefsDir = `${targetDir}/references`
      await mkdir(targetRefsDir, { recursive: true })
      const entries = await readDir(refsDir)
      for (const entry of entries) {
        if (entry.isFile && entry.name) {
          const content = await readTextFile(`${refsDir}/${entry.name}`)
          await writeTextFile(`${targetRefsDir}/${entry.name}`, content)
        }
      }
    } catch (e) {
      warnings.push(`复制 references/ 失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return { success: true, skillId, warnings }
}

/**
 * 读取 manifest.json（如有），提取技能元数据。
 */
export async function parseManifestJson(sourceDir: string): Promise<ManifestData> {
  const manifestPath = `${sourceDir}/manifest.json`
  if (!(await fileExists(manifestPath))) {
    return {}
  }

  try {
    const raw = await readTextFile(manifestPath)
    const data = JSON.parse(raw) as Record<string, unknown>
    return {
      name: typeof data.name === 'string' ? data.name : undefined,
      description: typeof data.description === 'string' ? data.description : undefined,
      author: typeof data.author === 'string' ? data.author : undefined,
    }
  } catch {
    return {}
  }
}

// ─── Internal Helpers ──────────────────────────────────

interface DirEntry {
  name: string
  stem: string
}

/** 扫描目录，返回匹配后缀的文件列表 */
async function scanDir(dirPath: string, suffix: string): Promise<DirEntry[]> {
  try {
    const entries = await readDir(dirPath)
    return entries
      .filter((e) => e.isFile && e.name?.endsWith(suffix))
      .map((e) => ({
        name: e.name!,
        stem: e.name!.replace(suffix, ''),
      }))
  } catch {
    return []
  }
}

/** 检查文件是否存在 */
async function fileExists(path: string): Promise<boolean> {
  try {
    return await exists(path)
  } catch {
    return false
  }
}
