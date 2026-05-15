/**
 * skillExecutor -- 解析并执行 Skill 实验性脚本。
 *
 * 纯函数模块，不创建 class。
 * 职责：
 * - ScriptParser: 从 SkillMeta 中解析 experimental.scripts → ScriptEntry[]
 * - SkillExecutor: 通过 Tauri invoke 执行脚本，返回 ScriptResult
 */

import { invoke } from '@tauri-apps/api/core'
import type { SkillMeta } from '@/types'
import type { SandboxMode } from '@/types/skill'

// ── Types ─────────────────────────────────────────

export interface ScriptEntry {
  name: string
  filePath: string
  sandboxMode: SandboxMode
}

export interface ScriptResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
  durationMs: number
}

// ── ScriptParser ──────────────────────────────────

/** 有效的 sandbox 值 */
const VALID_SANDBOX_MODES: ReadonlySet<string> = new Set(['restricted', 'full'])

/**
 * 从 SkillMeta 解析 experimental.scripts 为结构化 ScriptEntry[]。
 *
 * 校验规则：
 * - name / file 不能为空
 * - sandbox 必须是 'restricted' | 'full'
 *
 * 校验失败时在 console.warn 输出告警并跳过该条目（不阻断其他脚本）。
 */
export function parseSkillScripts(skillMeta: SkillMeta): ScriptEntry[] {
  const scripts = (skillMeta as Record<string, unknown>).experimental
  if (!scripts || typeof scripts !== 'object') return []

  const scriptsObj = (scripts as Record<string, unknown>).scripts
  if (!scriptsObj || typeof scriptsObj !== 'object') return []

  const entries: ScriptEntry[] = []
  for (const [name, raw] of Object.entries(scriptsObj as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') {
      console.warn(`[skillExecutor] script "${name}" is not an object, skipping`)
      continue
    }

    const { file, sandbox } = raw as Record<string, unknown>

    if (!file || typeof file !== 'string') {
      console.warn(`[skillExecutor] script "${name}" missing valid "file", skipping`)
      continue
    }

    if (!sandbox || typeof sandbox !== 'string' || !VALID_SANDBOX_MODES.has(sandbox)) {
      console.warn(`[skillExecutor] script "${name}" has invalid sandbox "${sandbox}", skipping`)
      continue
    }

    entries.push({
      name,
      filePath: file,
      sandboxMode: sandbox as SandboxMode,
    })
  }

  return entries
}

// ── SkillExecutor ─────────────────────────────────

/**
 * 执行指定 Skill 的脚本。
 *
 * 调用 Tauri command `skill_execute_script`，处理 stdout/stderr/exitCode/timeout。
 */
export async function executeScript(
  skillId: string,
  scriptName: string,
  input?: string,
): Promise<ScriptResult> {
  const startMs = Date.now()

  try {
    const result = await invoke<{
      exit_code?: number
      stdout?: string
      stderr?: string
      timed_out?: boolean
    }>('skill_execute_script', { skillId, scriptName, input })

    return {
      exitCode: result.exit_code ?? 0,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      timedOut: result.timed_out ?? false,
      durationMs: Date.now() - startMs,
    }
  } catch (error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      timedOut: false,
      durationMs: Date.now() - startMs,
    }
  }
}
