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
    capabilityRegistry,
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
    meta: {
      skillId,
      displayName: parsed.display_name ?? parsed.name ?? skillId,
      version: parsed.version ?? '0.0.0',
      description: parsed.description ?? '',
      capabilities: Array.isArray(parsed.capabilities) ? parsed.capabilities : [],
      entry: parsed.entry ?? 'SKILL.md',
      path: `skills/${skillId}`,
      source: 'official' as const,
    },
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
  params: {
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
  },
): Promise<ChatMessage | null | undefined> {
  // 1. 检查是否为命令触发（/command 语法）
  const cmdTrigger = parseCommandTrigger(text)
  if (cmdTrigger) {
    const commandRegistry = getCommandRegistry()
    const cmdDef = commandRegistry.findCommand(cmdTrigger.trigger)
    if (cmdDef) {
      try {
        const taskId = params.createId()

        // 1.1 创建 Task
        const task: Task = {
          id: taskId,
          type: 'skill',
          status: 'running',
          input: { type: 'chat', payload: { text: cmdTrigger.commandInput } },
        }
        const taskStore = useTaskStore()
        taskStore.enqueue(task)
        registerChatTask(task)

        // 1.2 加载命令 .md 文件
        const baseDir = cmdDef.source === 'skill-package'
          ? BaseDirectory.Resource
          : BaseDirectory.AppData
        const skillLoader = new SkillLoader(baseDir)

        // 读取命令 .md 内容
        const mdPath = `skills/${cmdDef.skillId}/${cmdDef.mdPath}`
        let markdown: string | undefined
        try {
          markdown = await readTextFile(mdPath, { baseDir })
        } catch {
          // dev 模式 fallback
          try {
            const actualDir = await resourceDir()
            markdown = await readTextFile(`${actualDir}/${mdPath}`)
          } catch {
            // fallback 失败
          }
        }

        // 1.3 构建 SkillPackage 并注入
        const runtime = useRuntimeStore()
        const skillPkg = {
          meta: {
            skillId: cmdDef.skillId,
            displayName: cmdDef.commandName,
            version: '0.0.0',
            description: cmdDef.description,
            capabilities: [],
            entry: cmdDef.mdPath,
            path: `skills/${cmdDef.skillId}`,
            source: 'custom' as const,
          },
          markdown,
          references: [],
          estimatedSize: 0,
        }
        await runtime.loadSkillLayerForTask(taskId, skillPkg)

        // 1.4 执行
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
  }

  // 1b. 检查是否为 agent 触发（@agent agentName input）
  const agentTrigger = parseAgentTrigger(text)
  if (agentTrigger) {
    try {
      const agentRegistry = getAgentRegistry()
      const agent = agentRegistry.findAgent(agentTrigger.agentName)
      if (agent) {
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
      }
    } catch (e) {
      params.handleSendError(e, null, params.sending, params.draftSending)
      return null
    }
  }

  // 2. 检查是否为 skill invocation（@mention 语法）
  const invocation = parseSkillInvocation(text)
  if (!invocation) return undefined

  // 2. 按名称匹配 Skill
  const registry = getRegistry()
  const skillMeta = await resolveSkillByName(invocation.skillName, registry)
  if (!skillMeta) return undefined

  // 2.1 Capability 预检
  if (!checkSkillCapabilities(skillMeta.capabilities ?? [])) {
    throw new Error(`Skill "${skillMeta.displayName}" 缺少所需权限`)
  }

  // 3. 执行 Skill
  try {
    const taskId = params.createId()

    // 3.1 创建 Task（携带 skill input text）
    const task: Task = {
      id: taskId,
      type: 'skill',
      status: 'running',
      input: { type: 'chat', payload: { text: invocation.skillInput } },
    }
    const taskStore = useTaskStore()
    taskStore.enqueue(task)
    registerChatTask(task)

    // 3.2 加载 SKILL.md → 注入 SkillLayer
    const runtime = useRuntimeStore()
    const baseDir = skillMeta.source === 'official'
      ? BaseDirectory.Resource
      : BaseDirectory.AppData
    const skillLoader = new SkillLoader(baseDir)

    // 推断 trigger：从用户输入文本提取关键词匹配 triggers 数组
    const inferredTrigger = invocation.skillInput.trim().split(/\s+/)[0]?.toLowerCase() || 'always'

    let skillPkg = await skillLoader.loadSkillByTrigger(skillMeta.skillId, inferredTrigger, {
      loadMarkdown: true,
      loadReferences: false,
    })
    // Fallback: BaseDirectory.Resource 在 dev 模式下可能不指向项目根，
    // 尝试用 resourceDir() 解析的实际路径重新加载
    if (!skillPkg.markdown && baseDir === BaseDirectory.Resource) {
      try {
        const actualDir = await resourceDir()
        const raw = await readTextFile(`${actualDir}/skills/${skillMeta.skillId}/skill.json`)
        const parsed = JSON.parse(raw)
        const md = await readTextFile(`${actualDir}/skills/${skillMeta.skillId}/SKILL.md`).catch(() => undefined)
        skillPkg = buildFallbackPackage(skillMeta.skillId, parsed, md)
        console.info(`[skillBridge] resourceDir fallback 成功: ${actualDir}/skills/${skillMeta.skillId}`)
      } catch {
        // resourceDir fallback 失败，尝试 AppData
        console.warn(`[skillBridge] Resource dir SKILL.md 为空，回退 AppData: ${skillMeta.skillId}`)
        const fallbackLoader = new SkillLoader(BaseDirectory.AppData)
        skillPkg = await fallbackLoader.loadSkill(skillMeta.skillId, {
          loadMarkdown: true,
          loadReferences: false,
        })
      }
    }
    await runtime.loadSkillLayerForTask(taskId, skillPkg)

    // 3.2.1 自动注册 skill 关联的命令
    await registerSkillCommands(skillMeta.skillId, baseDir)

    // 3.2.2 自动注册 skill 关联的子代理
    await registerSkillAgents(skillMeta.skillId, baseDir)

    // 3.2.3 自动注册 skill 关联的 lifecycle hooks
    await registerSkillHooks(skillMeta.skillId, baseDir)

    // 3.2.4 触发 on-load hooks（fire-and-forget）
    fireHooks('on-load', skillMeta.skillId, { TASK_ID: taskId })

    // 3.3 执行
    // 3.3.1 触发 on-execute hooks（fire-and-forget）
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
    // 触发 on-error hooks（fire-and-forget）
    fireHooks('on-error', skillMeta.skillId, {
      ERROR: e instanceof Error ? e.message : String(e),
    })
    params.handleSendError(e, null, params.sending, params.draftSending)
    return null
  }
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
