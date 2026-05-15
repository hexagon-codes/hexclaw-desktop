/**
 * hookExecutor -- 执行 Skill 生命周期 Hook。
 *
 * 纯函数模块，不创建 class。
 * 职责：
 * - 读取 hook .sh 脚本文件
 * - 通过 Tauri sandbox 执行
 * - 聚合执行结果
 *
 * 设计约束：
 * - Hook 执行是非阻塞的（fire-and-forget with logging）
 * - 不阻断主流程，失败仅 log warn
 */

import { readTextFile } from '@tauri-apps/plugin-fs'
import { BaseDirectory, resourceDir } from '@tauri-apps/api/path'
import { invoke } from '@tauri-apps/api/core'
import { env } from '@/config/env'
import { deriveProjectRoot } from '@/utils/projectRoot'
import type { HookDefinition } from './hookRegistry'

// ── Types ─────────────────────────────────────────

export interface HookResult {
  skillId: string
  hookName: string
  success: boolean
  output: string
  error?: string
}

export interface HookExecuteContext {
  /** 传递给 hook 的上下文环境变量 */
  [key: string]: string
}

// ── 常量 ─────────────────────────────────────────

const DEFAULT_HOOK_TIMEOUT = 5000

// ── 辅助函数 ─────────────────────────────────────

/**
 * 读取 hook 脚本文件内容。
 *
 * 先尝试 Resource 目录，dev 模式下回退到项目根目录。
 */
async function readHookScript(
  skillId: string,
  scriptPath: string,
): Promise<string | undefined> {
  // 安全：验证路径防穿越
  if (scriptPath.includes('..') || scriptPath.startsWith('/') || scriptPath.startsWith('\\')) {
    console.warn(`[hookExecutor] 非法脚本路径: ${scriptPath}`)
    return undefined
  }

  try {
    return await readTextFile(`skills/${skillId}/${scriptPath}`, { baseDir: BaseDirectory.Resource })
  } catch {
    // dev 模式 fallback
    if (env.isDev) {
      try {
        const actualDir = await resourceDir()
        if (actualDir) {
          return await readTextFile(`${deriveProjectRoot(actualDir)}/skills/${skillId}/${scriptPath}`)
        }
      } catch {
        // fallback 失败
      }
    }
    return undefined
  }
}

/**
 * 构建 hook 执行的环境变量。
 */
function buildHookEnv(
  hook: HookDefinition,
  context?: HookExecuteContext,
): string {
  const envVars: Record<string, string> = {
    HOOK_SKILL_ID: hook.skillId,
    HOOK_EVENT: hook.event,
    HOOK_NAME: hook.hookName,
    ...(context ?? {}),
  }
  return JSON.stringify(envVars)
}

// ── 导出函数 ─────────────────────────────────────

/**
 * 执行单个 hook 脚本。
 *
 * @param hook — Hook 定义
 * @param context — 可选上下文环境变量
 * @returns 执行结果
 */
export async function executeHook(
  hook: HookDefinition,
  context?: HookExecuteContext,
): Promise<HookResult> {
  const timeout = hook.timeout ?? DEFAULT_HOOK_TIMEOUT

  // 读取脚本文件
  const scriptContent = await readHookScript(hook.skillId, hook.scriptPath)
  if (!scriptContent) {
    return {
      skillId: hook.skillId,
      hookName: hook.hookName,
      success: false,
      output: '',
      error: `Script not found: skills/${hook.skillId}/${hook.scriptPath}`,
    }
  }

  // 通过 sandbox 执行
  try {
    const envJson = buildHookEnv(hook, context)
    const result = await invoke<{
      exit_code?: number
      stdout?: string
      stderr?: string
      timed_out?: boolean
    }>('skill_execute_script', {
      skillId: hook.skillId,
      scriptName: hook.hookName,
      input: scriptContent,
      envVars: envJson,
    })

    const success = (result.exit_code ?? 1) === 0
    if (!success) {
      console.warn(
        `[hookExecutor] hook "${hook.hookName}" exit code ${result.exit_code}: ${result.stderr ?? ''}`,
      )
    }

    return {
      skillId: hook.skillId,
      hookName: hook.hookName,
      success,
      output: result.stdout ?? '',
      error: result.stderr || undefined,
    }
  } catch (error) {
    console.warn(
      `[hookExecutor] hook "${hook.hookName}" invoke error:`,
      error,
    )
    return {
      skillId: hook.skillId,
      hookName: hook.hookName,
      success: false,
      output: '',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * 执行指定事件的所有 hooks。
 *
 * 非阻塞设计：fire-and-forget，失败不阻断主流程。
 *
 * @param hooks — 待执行的 hooks 列表
 * @param context — 可选上下文环境变量
 * @returns 所有 hook 的执行结果
 */
export async function executeHooksForEvent(
  hooks: HookDefinition[],
  context?: HookExecuteContext,
): Promise<HookResult[]> {
  if (!hooks.length) return []

  // 并行执行所有 hooks
  const results = await Promise.allSettled(
    hooks.map((hook) => executeHook(hook, context)),
  )

  return results.map((r) =>
    r.status === 'fulfilled'
      ? r.value
      : {
          skillId: 'unknown',
          hookName: 'unknown',
          success: false,
          output: '',
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        },
  )
}
