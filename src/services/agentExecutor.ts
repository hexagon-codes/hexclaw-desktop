/**
 * agentExecutor — Skill sub-agent 执行器。
 *
 * 职责：
 * - 查找并加载子代理定义
 * - 读取 agents/*.md 作为系统提示
 * - 通过 runtimeBridge 执行代理任务
 */

import { BaseDirectory, resourceDir } from '@tauri-apps/api/path'
import { readTextFile } from '@tauri-apps/plugin-fs'
import { getAgentRegistry, type AgentDefinition } from './agentRegistry'
import { executeChatTask, registerChatTask } from './runtimeBridge'
import { useRuntimeStore } from '@/stores/runtime'
import { useTaskStore } from '@/stores/tasks'
import type { Task } from '@/types'
import { buildSkillMeta } from '@/utils/skillMeta'

// ─── Types ─────────────────────────────────────────────

export interface AgentInvokeResult {
  content: string
  agentName: string
  skillId: string
  elapsed: number
}

export interface AgentInvokeOptions {
  createId: () => string
  /** 覆盖代理的 maxTurns 限制 */
  maxTurns?: number
  /** 额外上下文追加到用户输入 */
  context?: string
}

// ─── 内部辅助 ─────────────────────────────────────────

/**
 * 加载 agents/*.md 文件内容。
 *
 * 尝试顺序：BaseDirectory.Resource → resourceDir() fallback → BaseDirectory.AppData
 */
async function loadAgentMarkdown(
  skillId: string,
  mdPath: string,
): Promise<string | undefined> {
  // 尝试 Resource 目录
  try {
    return await readTextFile(`skills/${skillId}/${mdPath}`, {
      baseDir: BaseDirectory.Resource,
    })
  } catch {
    // 继续 fallback
  }

  // 尝试 resourceDir() 实际路径
  try {
    const actualDir = await resourceDir()
    return await readTextFile(`${actualDir}/skills/${skillId}/${mdPath}`)
  } catch {
    // 继续 fallback
  }

  // 尝试 AppData 目录
  try {
    return await readTextFile(`skills/${skillId}/${mdPath}`, {
      baseDir: BaseDirectory.AppData,
    })
  } catch {
    return undefined
  }
}

// ─── 导出函数 ─────────────────────────────────────────

/**
 * 按名称调用子代理。
 *
 * @param agentName — 代理名称
 * @param input — 用户输入
 * @param options — 调用选项
 * @returns 代理执行结果
 * @throws 代理未找到或执行失败
 */
export async function invokeAgent(
  agentName: string,
  input: string,
  options: AgentInvokeOptions,
): Promise<AgentInvokeResult> {
  const registry = getAgentRegistry()
  const agent = registry.findAgent(agentName)
  if (!agent) {
    throw new Error(`Agent "${agentName}" not found in registry`)
  }

  return invokeAgentWithDef(agent, input, options)
}

/**
 * 按 skillId 调用子代理。
 *
 * - 若 skill 只有一个代理，直接调用
 * - 若有多个，返回代理列表供调用方选择
 *
 * @param skillId — skill ID
 * @param input — 用户输入
 * @param options — 调用选项
 * @returns 执行结果或多代理列表
 */
export async function invokeAgentBySkill(
  skillId: string,
  input: string,
  options: AgentInvokeOptions,
): Promise<AgentInvokeResult | AgentDefinition[]> {
  const registry = getAgentRegistry()
  const agents = registry.findAgentBySkill(skillId)

  if (agents.length === 0) {
    throw new Error(`No agents registered for skill "${skillId}"`)
  }

  if (agents.length === 1) {
    return invokeAgentWithDef(agents[0], input, options)
  }

  // 多代理 — 返回列表供选择
  return agents
}

// ─── 内部执行 ─────────────────────────────────────────

/**
 * 使用 AgentDefinition 执行代理。
 */
async function invokeAgentWithDef(
  agent: AgentDefinition,
  input: string,
  options: AgentInvokeOptions,
): Promise<AgentInvokeResult> {
  const startTime = Date.now()

  // 1. 加载 agents/*.md 作为系统提示
  const markdown = await loadAgentMarkdown(agent.skillId, agent.mdPath)

  // 2. 构建完整输入（系统提示 + 用户输入）
  const fullInput = markdown
    ? `[System Prompt]\n${markdown}\n\n[User Input]\n${input}`
    : input

  // 3. 创建 Task
  const taskId = options.createId()
  const task: Task = {
    id: taskId,
    type: 'skill',
    status: 'running',
    input: { type: 'chat', payload: { text: fullInput } },
  }
  const taskStore = useTaskStore()
  taskStore.enqueue(task)
  registerChatTask(task)

  // 4. 注入 SkillPackage 到 Runtime
  const runtime = useRuntimeStore()
  const skillPkg = {
    meta: buildSkillMeta(agent.skillId, {
      display_name: agent.agentName,
      description: agent.description,
      capabilities: agent.tools,
      entry: agent.mdPath,
    }, 'official'),
    markdown,
    references: [],
    estimatedSize: 0,
  }
  await runtime.loadSkillLayerForTask(taskId, skillPkg)

  // 5. 执行
  const result = await executeChatTask(taskId)

  return {
    content: result.content,
    agentName: agent.agentName,
    skillId: agent.skillId,
    elapsed: Date.now() - startTime,
  }
}
