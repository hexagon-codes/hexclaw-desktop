/**
 * skillBridge -- @mention Skill 调用桥接层。
 *
 * 纯函数模块，不创建 class，不维护状态（仅模块级单例 registry）。
 * 职责：
 * - 解析消息开头的 @skillName 语法
 * - 按名称匹配 Skill
 * - 执行 Skill 并封装结果
 */

import type { Ref } from 'vue'
import type { ChatMessage, SkillMeta, Task } from '@/types'
import { SkillRegistry } from './skillRegistry'
import { parseSkillScripts, executeScript } from './skillExecutor'
import type { ScriptResult } from './skillExecutor'
import { SkillLoader } from './skillLoader'
import { executeChatTask, registerChatTask } from './runtimeBridge'
import { buildAssistantMessage } from '@/utils/buildAssistantMessage'
import { getRuntimeServices } from './runtime/runtimeServices'
import { useRuntimeStore } from '@/stores/runtime'
import { useTaskStore } from '@/stores/tasks'
import { DEFAULT_ALLOWED_CAPABILITIES } from '@/types/capability'
import { BaseDirectory, resourceDir } from '@tauri-apps/api/path'
import { readTextFile } from '@tauri-apps/plugin-fs'
import { getCommandRegistry } from './commandRegistry'
import { getAgentRegistry, type AgentDefinition } from './agentRegistry'
import { invokeAgent, invokeAgentBySkill } from './agentExecutor'
import type { SkillCommand, SkillAgent, SkillHook } from '@/types/skill'
import { getHookRegistry, type HookDefinition, type HookEvent } from './hookRegistry'
import { executeHooksForEvent } from './hookExecutor'
import { buildSkillMeta } from '@/utils/skillMeta'

// ── Types ────────────────────────────────────────

interface SkillExecuteParams {
  createId: () => string
  messages: Ref<ChatMessage[]>
  sending: Ref<boolean>
  draftSending: Ref<boolean>
  handleSendError: (
    errorValue: unknown,
    sessionId: string | null | undefined,
    sending: Ref<boolean>,
    draftSending: Ref<boolean>,
  ) => void
}

// ── 模块级单例（lazy） ────────────────────────────

let _registry: SkillRegistry | undefined

function getRegistry(): SkillRegistry {
  if (!_registry) _registry = new SkillRegistry()
  return _registry
}

// ── 正则 ─────────────────────────────────────────

const SKILL_INVOCATION_RE = /^@(\S+)\s*(.*)/
const COMMAND_TRIGGER_RE = /^\/(\S+)\s*(.*)/
const AGENT_TRIGGER_RE = /^@agent\s+(\S+)\s*(.*)/

// ── 内部辅助 ─────────────────────────────────────

/**
 * 解析命令触发语法。
 *
 * @param text - 用户输入的原始消息
 * @returns 解析成功返回 { trigger, commandInput }，否则返回 null
 */
function parseCommandTrigger(
  text: string,
): { trigger: string; commandInput: string } | null {
  const match = text.match(COMMAND_TRIGGER_RE)
  if (!match) return null
  return { trigger: `/${match[1]}`, commandInput: match[2] }
}

/**
 * 解析 agent 触发语法（@agent agentName input）。
 *
 * @param text - 用户输入的原始消息
 * @returns 解析成功返回 { agentName, agentInput }，否则返回 null
 */
function parseAgentTrigger(
  text: string,
): { agentName: string; agentInput: string } | null {
  const match = text.match(AGENT_TRIGGER_RE)
  if (!match) return null
  return { agentName: match[1], agentInput: match[2] }
}

/**
 * 从 skill.json 读取 commands 数组并注册到 CommandRegistry。
 *
 * @param skillId — skill ID
 * @param baseDir — 读取基础目录
 */
async function registerSkillCommands(
  skillId: string,
  baseDir: BaseDirectory,
): Promise<void> {
  try {
    const raw = await readTextFile(`skills/${skillId}/skill.json`, { baseDir })
    const parsed = JSON.parse(raw)
    const commands: SkillCommand[] = Array.isArray(parsed.commands) ? parsed.commands : []
    if (commands.length > 0) {
      getCommandRegistry().registerCommands(skillId, commands)
      console.info(`[skillBridge] 注册 ${commands.length} 个命令: ${skillId}`)
    }
  } catch {
    // skill.json 读取失败 — 静默处理，命令注册是可选的
  }
}

/**
 * 从 skill.json 读取 agents 数组并注册到 AgentRegistry。
 *
 * @param skillId — skill ID
 * @param baseDir — 读取基础目录
 */
async function registerSkillAgents(
  skillId: string,
  baseDir: BaseDirectory,
): Promise<void> {
  try {
    const raw = await readTextFile(`skills/${skillId}/skill.json`, { baseDir })
    const parsed = JSON.parse(raw)
    const rawAgents: SkillAgent[] = Array.isArray(parsed.agents) ? parsed.agents : []
    if (rawAgents.length > 0) {
      const agents: AgentDefinition[] = rawAgents.map((a) => ({
        skillId,
        agentName: a.name,
        description: a.description ?? '',
        mdPath: a.file,
        model: a.model,
        tools: a.tools,
      }))
      getAgentRegistry().registerAgents(skillId, agents)
      console.info(`[skillBridge] 注册 ${agents.length} 个代理: ${skillId}`)
    }
  } catch {
    // skill.json 读取失败 — 静默处理，代理注册是可选的
  }
}

/**
 * 从 skill.json 读取 experimental.hooks 数组并注册到 HookRegistry。
 *
 * @param skillId — skill ID
 * @param baseDir — 读取基础目录
 */
async function registerSkillHooks(
  skillId: string,
  baseDir: BaseDirectory,
): Promise<void> {
  try {
    const raw = await readTextFile(`skills/${skillId}/skill.json`, { baseDir })
    const parsed = JSON.parse(raw)
    const experimental = parsed.experimental
    if (!experimental || typeof experimental !== 'object') return

    const rawHooks: SkillHook[] = Array.isArray(experimental.hooks) ? experimental.hooks : []
    if (rawHooks.length === 0) return

    const hooks: HookDefinition[] = rawHooks
      .filter((h) => h.name && h.file && h.event)
      .map((h) => ({
        skillId,
        hookName: h.name,
        event: h.event as HookEvent,
        scriptPath: h.file,
        timeout: 5000,
      }))

    if (hooks.length > 0) {
      getHookRegistry().registerHooks(skillId, hooks)
      console.info(`[skillBridge] 注册 ${hooks.length} 个 hook: ${skillId}`)
    }
  } catch {
    // skill.json 读取失败 — 静默处理，hook 注册是可选的
  }
}

/**
 * 触发指定事件的 hooks（fire-and-forget）。
 *
 * 非阻塞：仅 log 结果，不阻断主流程。
 */
async function fireHooks(
  event: HookEvent,
  skillId: string,
  context?: Record<string, string>,
): Promise<void> {
  const hooks = getHookRegistry().getHooksForEvent(event)
    .filter((h) => h.skillId === skillId)
  if (!hooks.length) return

  try {
    const results = await executeHooksForEvent(hooks, context)
    for (const r of results) {
      if (!r.success) {
        console.warn(`[skillBridge] hook "${r.hookName}" 失败: ${r.error}`)
      }
    }
  } catch {
    // hook 执行异常 — 静默处理，不阻断主流程
  }
}

/**
 * 检查 skill 声明的 capabilities 是否在默认允许列表中。
 * 验证失败会阻断执行，由调用方的 catch 处理。
 */
function checkSkillCapabilities(capabilities: string[]): boolean {
  const { capabilityRegistry, capabilityValidator } = getRuntimeServices()
  const result = capabilityValidator.validate(
    capabilities,
    { allowedCapabilities: DEFAULT_ALLOWED_CAPABILITIES, deniedCapabilities: [] },
    (cap) => capabilityRegistry.hasCapability(cap),
  )
  return result.valid
}

/**
 * 从已解析的 skill.json 构建 SkillPackage（仅用于 resourceDir fallback）。
 * 复用 SkillLoader 相同的 meta 构建逻辑，避免内联重复。
 */
function buildFallbackPackage(
  skillId: string,
  parsed: Record<string, unknown>,
  markdown: string | undefined,
) {
  return {
    meta: buildSkillMeta(skillId, parsed, 'official'),
    markdown,
    references: [],
    estimatedSize: 0,
  }
}

// ── 导出函数 ─────────────────────────────────────

/**
 * 检测消息开头是否为 @mention 语法。
 *
 * @param text - 用户输入的原始消息
 * @returns 解析成功返回 { skillName, skillInput }，否则返回 null
 */
export function parseSkillInvocation(
  text: string,
): { skillName: string; skillInput: string } | null {
  const match = text.match(SKILL_INVOCATION_RE)
  if (!match) return null
  return { skillName: match[1], skillInput: match[2] }
}

/**
 * 按 skillId 或 displayName 精确匹配（忽略大小写）。
 *
 * @param skillName - 用户输入的 skill 名称
 * @param registry - SkillRegistry 实例
 * @returns 匹配到的 SkillMeta，未匹配返回 undefined
 */
export async function resolveSkillByName(
  skillName: string,
  registry: SkillRegistry,
): Promise<SkillMeta | undefined> {
  const skills = await registry.getAllSkills()
  const lower = skillName.toLowerCase()
  return skills.find(
    (s) => s.skillId.toLowerCase() === lower
      || s.displayName.toLowerCase() === lower,
  )
}

// ── tryExecuteSkill 子函数 ──────────────────────

/**
 * 处理命令触发（/command 语法）。
 *
 * 返回值：ChatMessage 表示执行成功，null 表示执行失败，undefined 表示未匹配。
 */
async function handleCommandTrigger(
  text: string,
  params: SkillExecuteParams,
): Promise<ChatMessage | null | undefined> {
  const cmdTrigger = parseCommandTrigger(text)
  if (!cmdTrigger) return undefined

  const commandRegistry = getCommandRegistry()
  const cmdDef = commandRegistry.findCommand(cmdTrigger.trigger)
  if (!cmdDef) return undefined

  try {
    const taskId = params.createId()

    const task: Task = {
      id: taskId,
      type: 'skill',
      status: 'running',
      input: { type: 'chat', payload: { text: cmdTrigger.commandInput } },
    }
    const taskStore = useTaskStore()
    taskStore.enqueue(task)
    registerChatTask(task)

    const baseDir = cmdDef.source === 'skill-package'
      ? BaseDirectory.Resource
      : BaseDirectory.AppData

    // 读取命令 .md 内容
    const mdPath = `skills/${cmdDef.skillId}/${cmdDef.mdPath}`
    let markdown: string | undefined
    try {
      markdown = await readTextFile(mdPath, { baseDir })
    } catch {
      try {
        const actualDir = await resourceDir()
        markdown = await readTextFile(`${actualDir}/${mdPath}`)
      } catch {
        // fallback 失败
      }
    }

    const runtime = useRuntimeStore()
    const skillPkg = {
      meta: buildSkillMeta(cmdDef.skillId, {
        display_name: cmdDef.commandName,
        description: cmdDef.description,
        entry: cmdDef.mdPath,
      }),
      markdown,
      references: [],
      estimatedSize: 0,
    }
    await runtime.loadSkillLayerForTask(taskId, skillPkg)

    const taskCreatedAt = Date.now()
    const result = await executeChatTask(taskId)
    const assistantMsg = buildAssistantMessage(result.content, {
      id: params.createId(),
      metadata: {
        taskId,
        skillId: cmdDef.skillId,
        skillName: cmdDef.commandName,
        runtimeStatus: 'completed',
        elapsed: Date.now() - taskCreatedAt,
      },
    })
    params.messages.value.push(assistantMsg)
    return assistantMsg
  } catch (e) {
    params.handleSendError(e, null, params.sending, params.draftSending)
    return null
  }
}

/**
 * 处理 agent 触发（@agent agentName input）。
 *
 * 返回值：ChatMessage 表示执行成功，null 表示执行失败，undefined 表示未匹配。
 */
async function handleAgentTrigger(
  text: string,
  params: SkillExecuteParams,
): Promise<ChatMessage | null | undefined> {
  const agentTrigger = parseAgentTrigger(text)
  if (!agentTrigger) return undefined

  try {
    const agentRegistry = getAgentRegistry()
    const agent = agentRegistry.findAgent(agentTrigger.agentName)
    if (!agent) return undefined

    const result = await invokeAgent(agentTrigger.agentName, agentTrigger.agentInput, {
      createId: params.createId,
    })
    const assistantMsg = buildAssistantMessage(result.content, {
      id: params.createId(),
      metadata: {
        skillId: result.skillId,
        skillName: result.agentName,
        runtimeStatus: 'completed',
        elapsed: result.elapsed,
      },
    })
    params.messages.value.push(assistantMsg)
    return assistantMsg
  } catch (e) {
    params.handleSendError(e, null, params.sending, params.draftSending)
    return null
  }
}

/**
 * 处理 skill invocation（@skillName input）。
 *
 * 返回值：ChatMessage 表示执行成功，null 表示执行失败，undefined 表示未匹配。
 */
async function handleSkillInvocation(
  text: string,
  params: SkillExecuteParams,
): Promise<ChatMessage | null | undefined> {
  const invocation = parseSkillInvocation(text)
  if (!invocation) return undefined

  const registry = getRegistry()
  const skillMeta = await resolveSkillByName(invocation.skillName, registry)
  if (!skillMeta) return undefined

  // Capability 预检
  if (!checkSkillCapabilities(skillMeta.capabilities ?? [])) {
    throw new Error(`Skill "${skillMeta.displayName}" 缺少所需权限`)
  }

  try {
    const taskId = params.createId()

    const task: Task = {
      id: taskId,
      type: 'skill',
      status: 'running',
      input: { type: 'chat', payload: { text: invocation.skillInput } },
    }
    const taskStore = useTaskStore()
    taskStore.enqueue(task)
    registerChatTask(task)

    // 加载 SKILL.md → 注入 SkillLayer
    const runtime = useRuntimeStore()
    const baseDir = skillMeta.source === 'official'
      ? BaseDirectory.Resource
      : BaseDirectory.AppData
    const skillLoader = new SkillLoader(baseDir)

    const inferredTrigger = invocation.skillInput.trim().split(/\s+/)[0]?.toLowerCase() || 'always'

    let skillPkg = await skillLoader.loadSkillByTrigger(skillMeta.skillId, inferredTrigger, {
      loadMarkdown: true,
      loadReferences: false,
    })
    // Fallback: BaseDirectory.Resource 在 dev 模式下可能不指向项目根
    if (!skillPkg.markdown && baseDir === BaseDirectory.Resource) {
      try {
        const actualDir = await resourceDir()
        const raw = await readTextFile(`${actualDir}/skills/${skillMeta.skillId}/skill.json`)
        const parsed = JSON.parse(raw)
        const md = await readTextFile(`${actualDir}/skills/${skillMeta.skillId}/SKILL.md`).catch(() => undefined)
        skillPkg = buildFallbackPackage(skillMeta.skillId, parsed, md)
        console.info(`[skillBridge] resourceDir fallback 成功: ${actualDir}/skills/${skillMeta.skillId}`)
      } catch {
        console.warn(`[skillBridge] Resource dir SKILL.md 为空，回退 AppData: ${skillMeta.skillId}`)
        const fallbackLoader = new SkillLoader(BaseDirectory.AppData)
        skillPkg = await fallbackLoader.loadSkill(skillMeta.skillId, {
          loadMarkdown: true,
          loadReferences: false,
        })
      }
    }
    await runtime.loadSkillLayerForTask(taskId, skillPkg)

    await registerSkillCommands(skillMeta.skillId, baseDir)
    await registerSkillAgents(skillMeta.skillId, baseDir)
    await registerSkillHooks(skillMeta.skillId, baseDir)

    fireHooks('on-load', skillMeta.skillId, { TASK_ID: taskId })
    fireHooks('on-execute', skillMeta.skillId, { TASK_ID: taskId })

    const taskCreatedAt = Date.now()
    const result = await executeChatTask(taskId)
    const assistantMsg = buildAssistantMessage(result.content, {
      id: params.createId(),
      metadata: {
        taskId,
        skillId: skillMeta.skillId,
        skillName: skillMeta.displayName,
        runtimeStatus: 'completed',
        elapsed: Date.now() - taskCreatedAt,
      },
    })
    params.messages.value.push(assistantMsg)
    return assistantMsg
  } catch (e) {
    fireHooks('on-error', skillMeta.skillId, {
      ERROR: e instanceof Error ? e.message : String(e),
    })
    params.handleSendError(e, null, params.sending, params.draftSending)
    return null
  }
}

// ── 主入口 ──────────────────────────────────────

/**
 * 主入口 -- 尝试将消息解析为 Skill invocation 并执行。
 *
 * 返回值语义：
 * - undefined -> 不是 skill invocation，让正常 chat 流程继续
 * - null      -> skill invocation 执行失败（已调用 handleSendError）
 * - ChatMessage -> skill invocation 执行成功
 */
export async function tryExecuteSkill(
  text: string,
  params: SkillExecuteParams,
): Promise<ChatMessage | null | undefined> {
  return handleCommandTrigger(text, params)
    ?? handleAgentTrigger(text, params)
    ?? handleSkillInvocation(text, params)
}

/**
 * 执行指定 Skill 的命名脚本。
 *
 * 先从 SkillMeta 的 experimental.scripts 解析目标脚本，
 * 若不存在则抛出错误。
 */
export async function executeSkillScript(
  skillMeta: SkillMeta,
  scriptName: string,
  input?: string,
): Promise<ScriptResult> {
  const scripts = parseSkillScripts(skillMeta)
  const target = scripts.find((s) => s.name === scriptName)
  if (!target) {
    throw new Error(`Script "${scriptName}" not found in skill "${skillMeta.skillId}"`)
  }
  return executeScript(skillMeta.skillId, scriptName, input)
}
