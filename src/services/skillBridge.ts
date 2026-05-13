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
import { SkillLoader } from './skillLoader'
import { executeChatTask, registerChatTask } from './runtimeBridge'
import { buildAssistantMessage } from '@/utils/buildAssistantMessage'
import { getRuntimeServices } from './runtime/runtimeServices'
import { useRuntimeStore } from '@/stores/runtime'
import { useTaskStore } from '@/stores/tasks'
import { DEFAULT_ALLOWED_CAPABILITIES } from '@/types/capability'
import { BaseDirectory } from '@tauri-apps/api/path'

// ── 模块级单例（lazy） ────────────────────────────

let _registry: SkillRegistry | undefined

function getRegistry(): SkillRegistry {
  if (!_registry) _registry = new SkillRegistry()
  return _registry
}

// ── 正则 ─────────────────────────────────────────

const SKILL_INVOCATION_RE = /^@(\S+)\s*(.*)/

// ── 内部辅助 ─────────────────────────────────────

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
  // 1. 检查是否为 skill invocation
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
      type: 'chat',
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
    const skillPkg = await skillLoader.loadSkill(skillMeta.skillId, {
      loadMarkdown: true,
      loadReferences: false,
    })
    await runtime.loadSkillLayerForTask(taskId, skillPkg)

    // 3.3 执行
    const result = await executeChatTask(taskId)
    const assistantMsg = buildAssistantMessage(result.content, {
      id: params.createId(),
    })
    params.messages.value.push(assistantMsg)
    return assistantMsg
  } catch (e) {
    params.handleSendError(e, null, params.sending, params.draftSending)
    return null
  }
}
