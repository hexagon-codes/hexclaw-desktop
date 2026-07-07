<script setup lang="ts">
import { onMounted, ref, computed, watch, nextTick, type Component } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import {
  Bot, Plus, X, Pencil, Trash2, ChevronDown, ChevronUp, LibraryBig, MessageSquare,
  Headset, PenLine, Code, Languages, BarChart3, Mail, Database, BookOpen, FileText, Search,
} from 'lucide-vue-next'
import logoUrl from '@/assets/logo.png'
import { useAgentsStore } from '@/stores/agents'
import { useSettingsStore } from '@/stores/settings'
import { getAgents, getRules, registerAgent, unregisterAgent, updateAgent } from '@/api/agents'
import { getSkills } from '@/api/skills'
import { getAssistantSoul, updateAssistantSoul } from '@/api/assistant'
import AgentSkillPicker from '@/components/agents/AgentSkillPicker.vue'
import SoulStructuredEditor from '@/components/agents/SoulStructuredEditor.vue'
import type { AgentConfig, AgentRule } from '@/types'
import { logger } from '@/utils/logger'
import { userVisibleAgents } from '@/utils/imChannelBinding'
import { useToast } from '@/composables/useToast'
import PageToolbar from '@/components/common/PageToolbar.vue'
import HcSelect from '@/components/common/HcSelect.vue'
import { PROVIDER_LOGOS } from '@/config/providers'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'

const { t } = useI18n()
const router = useRouter()
const route = useRoute()
const agentsStore = useAgentsStore()
const settingsStore = useSettingsStore()
const toast = useToast()

const searchQuery = ref('')
const errorMsg = ref('')

/** 默认助理「小蟹」展示名（跟随 chat.botName） */
const defaultAssistantName = computed(() => t('agents.defaultAssistantName', '小蟹 · 默认助理'))

// ── 默认助理「小蟹」人设(SOUL) 编辑器 ─────────────────────────────
// 读写 ~/.hexclaw/SOUL.md（后端 GET/PUT /api/v1/assistant/soul）：
// 空 = 恢复引擎内置默认人设；非空 = 自定义，引擎每轮读取，保存即时生效。
const showSoulEditor = ref(false)
const soulText = ref('')             // 编辑中的自定义人设
const soulDefaultPrompt = ref('')    // 引擎内置默认（供预览 / 恢复默认）
const soulIsCustom = ref(false)      // 当前是否已自定义
const soulLoading = ref(false)       // 拉取中
const soulSaving = ref(false)        // 保存中
const soulLoadError = ref(false)     // 引擎降级 / 拉取失败

/** 打开人设(SOUL)编辑弹层并拉取当前人设；引擎未连接则优雅降级（仍可打开，保存时报错）。 */
async function openSoulEditor() {
  showSoulEditor.value = true
  soulLoading.value = true
  soulLoadError.value = false
  try {
    const data = await getAssistantSoul()
    soulText.value = data.system_prompt ?? ''
    soulDefaultPrompt.value = data.default_prompt ?? ''
    soulIsCustom.value = !!data.is_custom
  } catch (err) {
    logger.warn('加载人设(SOUL)失败（引擎可能未连接）', err)
    soulLoadError.value = true
    soulText.value = ''
    soulDefaultPrompt.value = ''
    soulIsCustom.value = false
  } finally {
    soulLoading.value = false
  }
}

function closeSoulEditor() {
  showSoulEditor.value = false
}

/** 保存人设(SOUL)；空内容 = 删除 SOUL.md 恢复内置默认。 */
async function saveSoul() {
  if (soulSaving.value) return
  soulSaving.value = true
  try {
    const data = await updateAssistantSoul(soulText.value.trim())
    soulText.value = data.system_prompt ?? ''
    soulIsCustom.value = !!data.is_custom
    if (data.default_prompt) soulDefaultPrompt.value = data.default_prompt
    toast.success(
      soulIsCustom.value
        ? t('agents.soul.saved', '人设已保存，下一轮对话即时生效')
        : t('agents.soul.restored', '已恢复内置默认人设'),
    )
    showSoulEditor.value = false
  } catch (err) {
    logger.error('保存人设(SOUL)失败', err)
    toast.error(t('agents.soul.saveFailed', '保存人设失败，请确认引擎已连接'))
  } finally {
    soulSaving.value = false
  }
}

/** 清空输入 = 恢复内置默认（仍需点保存写入）。 */
function clearSoulToDefault() {
  soulText.value = ''
}

/** 第一步「空白新建」→ 第二步空表单 */
function startFromBlank() {
  resetAddAgentDialog()
  selectedTemplateName.value = ''
  addStep.value = 2
}

/** 第一步「从模板库开始」→ 关弹窗，交给唯一货架（模板库 tab）。
 *  模板库卡片再经 useLibraryTemplate 重开弹窗到第二步——避免第一步内嵌第二份列表。 */
function startFromLibrary() {
  closeAddAgentDialog()
  activeTab.value = 'templates'
}

/** Agent 绑定的「通道·任务」标签（通道来自路由规则，缺省回退说明） */
function getAgentBindings(agentName: string): string[] {
  return getAgentDeployedPlatforms(agentName)
}

// Agent 路由
const agents = ref<AgentConfig[]>([])
const defaultAgent = ref('')
const agentsLoading = ref(false)
const registering = ref(false)
const editing = ref(false)
const showAddAgent = ref(false)
const showAddAdvanced = ref(false)
// 新建弹窗两步：1=选择起点（空白/模板），2=填表单
const addStep = ref<1 | 2>(1)
const selectedTemplateName = ref('')
// 套用模板时记住其「专长」，在第二步只读展示——厚数据可见，不静默蒸发
const selectedTemplateExpertise = ref<string[]>([])
const newAgent = ref<AgentConfig>({ name: '', display_name: '', model: '', provider: '' })
// 新建 Agent 的人设(SOUL)：纯文本，写回 system_prompt。
const newAgentSoul = computed({
  get: () => newAgent.value.system_prompt ?? '',
  set: (v: string) => {
    newAgent.value.system_prompt = v
  },
})

// Edit agent modal
const showEditAgent = ref(false)
const editingAgent = ref<AgentConfig>({ name: '', display_name: '', model: '', provider: '' })
// BUG-20260703 D3：打开弹窗时的 LLM 配置快照——editFormValid「未真改就不校验」的基准。
const editingOriginal = ref<{ provider: string; model: string }>({ provider: '', model: '' })
// 打开弹窗给 editingAgent 赋值会触发 provider watch；挡掉这一次 sync，防止失效
// provider 的存量 model 在打开瞬间被清空。
let suppressEditProviderSync = false

// 注销确认
const showUnregisterConfirm = ref(false)
const unregisteringName = ref('')

// 路由规则只读加载，仅用于派生"已部署平台"徽章；管理 UI 在 Channels 页
const rules = ref<AgentRule[]>([])
const rulesLoading = ref(false)
const unregistering = ref(false)

/** Agent → deployed platform names (derived from existing routing rules) */
function getAgentDeployedPlatforms(agentName: string): string[] {
  return [...new Set(
    rules.value
      .filter((r) => r.agent_name === agentName && r.platform)
      .map((r) => r.platform),
  )]
}

onMounted(async () => {
  await Promise.all([agentsStore.loadRoles(), loadAgents(), loadRules(), settingsStore.loadConfig()])

  // Handle query params from IM page navigation: ?edit=agentName
  const editQuery = route.query.edit as string | undefined
  if (editQuery) {
    const agent = agents.value.find((a) => a.name === editQuery)
    if (agent) openEditAgent(agent)
    // Clean up query params
    router.replace({ path: route.path })
  }
  // ?create=1 来自「通道与账号 →＋新建 Agent」快捷入口：直接打开既有新建弹窗（复用，不另造 UI）
  if (route.query.create) {
    openAddAgentDialog()
    router.replace({ path: route.path })
  }
})

async function loadAgents() {
  agentsLoading.value = true
  errorMsg.value = ''
  try {
    const res = await getAgents()
    // 经单一可见性边界 userVisibleAgents 剔除匿名「频道默认模型」Agent（@im/*）——它们由 IM 频道绑定自动管理，非用户管理对象。
    agents.value = userVisibleAgents(res.agents || [])
    defaultAgent.value = res.default || ''
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('agents.loadAgentsFailed')
    logger.error('加载 Agents 失败:', e)
  } finally {
    agentsLoading.value = false
  }
}

async function loadRules() {
  rulesLoading.value = true
  try {
    const res = await getRules()
    rules.value = res.rules || []
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('agents.loadRulesFailed')
    logger.error('加载路由规则失败:', e)
  } finally {
    rulesLoading.value = false
  }
}

/** 一键进入与该智能体的会话（BUG-20260703 问题1）：复用 ChatView 既有
 *  `/chat?role=<name>` 机制——进入即把收件人锁定到该 Agent（pinned_agent 全链闭环）。
 *  role 用内部 name 作后端收件人键；roleTitle 带显示名，让会话标题呈现人看得懂的
 *  display_name 而非英文 name（BUG-20260704，对齐 WelcomeView）。 */
function enterAgentChat(name: string) {
  const cfg = agents.value.find((a) => a.name === name)
  const roleTitle = cfg?.display_name?.trim() || name
  router.push({ path: '/chat', query: { role: name, roleTitle } })
}

// ── 原型对齐批次（BUG-20260703 拍板落地）：头像 / 温度预设 / 模型真值 / SOUL 起草与
//    专注编辑 / 创建弹窗高级区同构 / 创建并开始对话 ─────────────────────────────

/** 头像候选（emoji，存 AgentConfig.metadata.avatar——后端 map[string]string 契约 B1 已锁） */
const AVATAR_CHOICES = ['🦀', '🤖', '🎓', '📊', '✉️', '🌐', '✨']
const newAgentAvatar = ref('🦀')
const editAvatar = ref('')

/** SOUL 快速起草骨架（创建/编辑共用；比结构化编辑器更轻的零白屏起点） */
const SOUL_DRAFTS: Record<string, string> = {
  expert: '你是〔领域〕的严谨专家。身份：〔一句话〕；语气：专业、克制、结论先行；专长：〔列 2-3 项〕；边界：不确定就说不确定，不编造，超出能力时明确说明。',
  warm: '你是亲切的日常助手。身份：〔一句话〕；语气：温和友好、多用短句、适度 emoji；专长：〔列 2-3 项〕；边界：涉及健康、财务等重要决策时提醒用户核实。',
  creative: '你是创意伙伴。身份：〔一句话〕；语气：活泼、有网感、敢发散；专长：头脑风暴、文案与标题；边界：事实性内容标注「需核实」。',
}

/** 温度预设锚点（0~2 对普通用户无意义；空串=跟随模型默认，保持 P2-4 三态语义） */
const TEMP_PRESETS = [
  { v: '', labelKey: 'agents.tempFollow' },
  { v: '0.2', labelKey: 'agents.tempPrecise' },
  { v: '0.7', labelKey: 'agents.tempBalanced' },
  { v: '1.2', labelKey: 'agents.tempCreative' },
] as const

/** 全局默认模型真值（「跟随全局默认」的空态必须能回答"现在到底用什么模型"） */
const resolvedGlobalDefaultModel = computed(() => {
  const id = settingsStore.config?.llm?.defaultProviderId ?? ''
  if (!id) return ''
  const m = settingsStore.availableModels.find((mm) => mm.providerKey === id)
  return m?.modelId ?? ''
})

// 创建弹窗高级区（与编辑弹窗同构；同一套三态/校验语义）
const newAgentTemperature = ref<string | number>('')
const newAgentMaxTokens = ref<string | number>('')
const newAgentSkills = ref<string[]>([])

const newAgentTemperatureValid = computed(() => {
  const raw = advInputRaw(newAgentTemperature.value)
  if (raw === '') return true
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 && n <= 2
})

const newAgentMaxTokensValid = computed(() => {
  const raw = advInputRaw(newAgentMaxTokens.value)
  if (raw === '') return true
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0
})

/** skill 列表懒加载（两弹窗高级区共用） */
async function ensureSkillsLoaded() {
  if (skillsLoaded.value) return
  try {
    const res = await getSkills()
    availableSkills.value = (res.skills ?? []).map((s) => ({ name: s.name, description: s.description }))
    skillsLoaded.value = true
  } catch {
    availableSkills.value = [] // skill 列表拉不到只影响该选择器，不阻断其它高级项
  }
}

async function toggleAddAdvanced() {
  showAddAdvanced.value = !showAddAdvanced.value
  if (showAddAdvanced.value) await ensureSkillsLoaded()
}

/** 高级区折叠摘要（收起时一眼看到关键配置，不必展开） */
function advSummary(provider: string, model: string, temp: string | number, skills: string[]): string {
  const modelPart = provider.trim()
    ? `${provider}${model ? ' · ' + model : ''}`
    : resolvedGlobalDefaultModel.value
      ? t('agents.followGlobalWith', { model: resolvedGlobalDefaultModel.value })
      : t('agents.useGlobalDefault')
  const tempRaw = advInputRaw(temp)
  const parts = [modelPart]
  if (tempRaw !== '') parts.push(`T ${tempRaw}`)
  if (skills.length) parts.push(t('agents.skillsMounted', { n: skills.length }))
  return parts.join(' · ')
}
const addAdvSummary = computed(() =>
  advSummary(newAgent.value.provider, newAgent.value.model, newAgentTemperature.value, newAgentSkills.value))
const editAdvSummary = computed(() =>
  advSummary(editingAgent.value.provider ?? '', editingAgent.value.model ?? '', editTemperature.value, editSkills.value))

// SOUL 专注编辑（结构化编辑器）：从人设框 FLIP 放大，不关闭底层弹窗，完成回填
const soulEditorOpen = ref(false)
const soulEditorTarget = ref<'add' | 'edit'>('add')
const soulEditorRect = ref<DOMRect | null>(null)
const addSoulEl = ref<HTMLTextAreaElement | null>(null)
const editSoulEl = ref<HTMLTextAreaElement | null>(null)

function openSoulFocus(target: 'add' | 'edit') {
  soulEditorTarget.value = target
  const el = target === 'add' ? addSoulEl.value : editSoulEl.value
  soulEditorRect.value = el ? el.getBoundingClientRect() : null
  soulEditorOpen.value = true
}

const soulEditorSeed = computed(() =>
  soulEditorTarget.value === 'add' ? (newAgent.value.system_prompt ?? '') : (editingAgent.value.system_prompt ?? ''))
const soulEditorSkills = computed(() =>
  soulEditorTarget.value === 'add' ? newAgentSkills.value : editSkills.value)
const soulEditorAgentName = computed(() =>
  soulEditorTarget.value === 'add'
    ? (newAgent.value.display_name || newAgent.value.name || t('agents.newAgent'))
    : (editingAgent.value.display_name || editingAgent.value.name))

function onSoulApply(text: string) {
  if (soulEditorTarget.value === 'add') newAgent.value.system_prompt = text
  else editingAgent.value.system_prompt = text
}

function fillSoulDraft(target: 'add' | 'edit', key: string) {
  const draft = SOUL_DRAFTS[key]
  if (!draft) return
  if (target === 'add') newAgent.value.system_prompt = draft
  else editingAgent.value.system_prompt = draft
}

function openEditAgent(agent: AgentConfig) {
  errorMsg.value = ''
  // BUG-20260703 D3：打开弹窗不再跑 syncAgentModelSelection——provider 失效时它会把
  // 存量 model 当场清空（数据未保存就被动）。快照原 LLM 配置作「未真改就不校验」的
  // 比较基准；赋值触发的 provider watch 用 suppress 挡掉这一次（用户真切 provider 时
  // 联动同步照常）。
  suppressEditProviderSync = true
  editingAgent.value = { ...agent }
  editingOriginal.value = { provider: (agent.provider ?? '').trim(), model: (agent.model ?? '').trim() }
  void nextTick(() => { suppressEditProviderSync = false })
  // BUG-20260703 P2-4：高级参数种子——空串 = 未设（跟随模型默认），显式 0 是合法温度
  editTemperature.value = agent.temperature === undefined || agent.temperature === null ? '' : String(agent.temperature)
  editMaxTokens.value = agent.max_tokens ? String(agent.max_tokens) : ''
  editSkills.value = [...(agent.skills ?? [])]
  editAvatar.value = agent.metadata?.avatar ?? ''
  showEditAdvanced.value = false
  showEditAgent.value = true
}

// ── 高级参数录入（BUG-20260703 P2-4：温度/max_tokens/skills 契约三方齐备但无 UI）──
// type=number 的 v-model 会回写 number（runtime-dom looseToNumber），refs 按 string|number 收。
const showEditAdvanced = ref(false)
const editTemperature = ref<string | number>('') // '' = 未设；0 = 显式确定性采样（与后端指针三态对齐）
const editMaxTokens = ref<string | number>('')   // '' = 未设（后端 int 契约 0=未设）

/** 数字输入原文归一（number/string 双态 → trim 后字符串；空串 = 未设）。 */
function advInputRaw(v: string | number): string {
  return String(v ?? '').trim()
}
const editSkills = ref<string[]>([])
const availableSkills = ref<{ name: string; description?: string }[]>([])
const skillsLoaded = ref(false)

async function toggleEditAdvanced() {
  showEditAdvanced.value = !showEditAdvanced.value
  if (showEditAdvanced.value) await ensureSkillsLoaded()
}

const editTemperatureValid = computed(() => {
  const raw = advInputRaw(editTemperature.value)
  if (raw === '') return true
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 && n <= 2
})

const editMaxTokensValid = computed(() => {
  const raw = advInputRaw(editMaxTokens.value)
  if (raw === '') return true
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0
})

function resetAddAgentDialog() {
  newAgent.value = { name: '', display_name: '', model: '', provider: '' }
  addStep.value = 1
  selectedTemplateName.value = ''
  selectedTemplateExpertise.value = []
  newAgentAvatar.value = '🦀'
  newAgentTemperature.value = ''
  newAgentMaxTokens.value = ''
  newAgentSkills.value = []
}

function openAddAgentDialog() {
  errorMsg.value = ''
  resetAddAgentDialog()
  showAddAgent.value = true
}

function closeAddAgentDialog() {
  showAddAgent.value = false
  showAddAdvanced.value = false
  errorMsg.value = ''
  resetAddAgentDialog()
}

function closeEditAgentDialog() {
  showEditAgent.value = false
  errorMsg.value = ''
}

async function handleEditAgent() {
  if (editing.value) return
  if (!editFormValid.value) return
  errorMsg.value = ''
  editing.value = true
  try {
    await updateAgent(editingAgent.value.name, {
      display_name: editingAgent.value.display_name,
      provider: editingAgent.value.provider,
      model: editingAgent.value.model,
      // 人设(SOUL)：编辑时一并透传，否则注册后无法二次修改（BUG-20260625 §3-1）。
      system_prompt: editingAgent.value.system_prompt ?? '',
      // 高级参数（BUG-20260703 P2-4）：温度三态——空输入=null 清除回「跟随模型默认」，
      // 显式 0 如实下发（确定性采样）；max_tokens 空=0=未设（int 契约）；skills 全量覆盖。
      temperature: advInputRaw(editTemperature.value) === '' ? null : Number(advInputRaw(editTemperature.value)),
      max_tokens: advInputRaw(editMaxTokens.value) === '' ? 0 : Math.trunc(Number(advInputRaw(editMaxTokens.value))),
      skills: [...editSkills.value],
      // 头像（原型对齐批次）：合并进原 metadata（后端 map 整体覆盖语义），未选不动原值。
      ...(editAvatar.value
        ? { metadata: { ...(editingAgent.value.metadata ?? {}), avatar: editAvatar.value } }
        : {}),
    })
    closeEditAgentDialog()
    await loadAgents()
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('agents.editAgentFailed')
    logger.error('编辑 Agent 失败:', e)
  } finally {
    editing.value = false
  }
}

const filteredAgents = computed(() => {
  if (!searchQuery.value) return agents.value
  const q = searchQuery.value.toLowerCase()
  return agents.value.filter(
    (a) =>
      (a.display_name ?? '').toLowerCase().includes(q) ||
      a.name.toLowerCase().includes(q) ||
      a.model.toLowerCase().includes(q),
  )
})

// ── 二级 tab：我的智能体 / 模板库 ──
type AgentTab = 'mine' | 'templates'
const activeTab = ref<AgentTab>('mine')

/**
 * 模板库 = 唯一的智能体模板货架（单一真相源）。原后端 6 个 role（assistant/researcher/
 * writer/coder/translator/analyst）在场景化命名下已被这批模板覆盖，其中「通用助手」即
 * 原 assistant 角色的场景化落点；弹窗第一步不再另列一份角色货架（见 startFromLibrary）。
 * name/desc/soul/exp 走 i18n；exp 用「·」分隔的专长串，第二步只读展示。
 */
interface AgentTemplate {
  key: string
  slug: string
  icon: Component
  name: string
  desc: string
  soul: string
  expertise: string[]
}
const splitExp = (s: string): string[] => s.split('·').map((x) => x.trim()).filter(Boolean)
const AGENT_TEMPLATES = computed<AgentTemplate[]>(() => [
  { key: 'assistant', slug: 'general-assistant', icon: Bot, name: t('agents.tpl.assistant.name', '通用助手'), desc: t('agents.tpl.assistant.desc', '全能问答 · 友好简洁'), soul: t('agents.tpl.assistant.soul', '你是通用智能助手，全面、准确地帮助用户解决各种问题，善于理解意图、把复杂问题讲清楚，不编造不确定的信息。'), expertise: splitExp(t('agents.tpl.assistant.exp', '通用问答·任务规划·信息整理')) },
  { key: 'support', slug: 'support-agent', icon: Headset, name: t('agents.tpl.support.name', '客服助手'), desc: t('agents.tpl.support.desc', 'IM 群答疑 · 耐心专业'), soul: t('agents.tpl.support.soul', '你是 IM 群里的客服助手，耐心、专业地解答用户疑问，遇到不确定的问题先澄清再回答，不编造信息。'), expertise: splitExp(t('agents.tpl.support.exp', '问题排查·话术应答·工单流转')) },
  { key: 'content', slug: 'content-writer', icon: PenLine, name: t('agents.tpl.content.name', '内容创作'), desc: t('agents.tpl.content.desc', '社媒文案 · 活泼有网感'), soul: t('agents.tpl.content.soul', '你是内容创作助手，擅长写小红书、公众号等社媒文案，语气活泼、有网感、会用 emoji，并能给出标题与话题标签建议。'), expertise: splitExp(t('agents.tpl.content.exp', '社媒文案·标题优化·话题标签')) },
  { key: 'code', slug: 'coding-buddy', icon: Code, name: t('agents.tpl.code.name', '编程搭子'), desc: t('agents.tpl.code.desc', '读写代码 · 简洁可运行'), soul: t('agents.tpl.code.soul', '你是编程搭子，能读写代码、解释实现、执行命令，回答简洁，优先给出可运行的最小方案。'), expertise: splitExp(t('agents.tpl.code.exp', '读写代码·调试排错·命令执行')) },
  { key: 'translate', slug: 'translator', icon: Languages, name: t('agents.tpl.translate.name', '翻译官'), desc: t('agents.tpl.translate.desc', '多语种互译 · 信达雅'), soul: t('agents.tpl.translate.soul', '你是专业翻译官，在中、英等多语种之间互译，做到信、达、雅，保留专有名词与代码不译，必要时附注解。'), expertise: splitExp(t('agents.tpl.translate.exp', '多语种互译·术语保留·译注说明')) },
  { key: 'report', slug: 'daily-report', icon: BarChart3, name: t('agents.tpl.report.name', '日报助理'), desc: t('agents.tpl.report.desc', '定时日报 · 简洁理性'), soul: t('agents.tpl.report.soul', '你是日报分析助理，把零散信息整理成结构清晰、简洁理性的日报，突出关键指标与异常，给出可执行建议。'), expertise: splitExp(t('agents.tpl.report.exp', '信息归纳·指标提炼·异常提示')) },
  { key: 'email', slug: 'email-assistant', icon: Mail, name: t('agents.tpl.email.name', '邮件助理'), desc: t('agents.tpl.email.desc', '邮件收发 · 正式礼貌'), soul: t('agents.tpl.email.soul', '你是邮件助理，帮用户起草、回复邮件，语气正式礼貌、条理清楚，按收件人身份调整措辞。'), expertise: splitExp(t('agents.tpl.email.exp', '邮件起草·礼貌措辞·收发管理')) },
  { key: 'data', slug: 'data-analyst', icon: Database, name: t('agents.tpl.data.name', '数据分析师'), desc: t('agents.tpl.data.desc', 'SQL · 报表 · 洞察'), soul: t('agents.tpl.data.soul', '你是数据分析师，能写 SQL、解读报表、发现趋势与异常，结论先行并用数据支撑，避免主观臆断。'), expertise: splitExp(t('agents.tpl.data.exp', 'SQL·报表解读·趋势洞察')) },
  { key: 'kb', slug: 'kb-qa', icon: BookOpen, name: t('agents.tpl.kb.name', '知识库问答'), desc: t('agents.tpl.kb.desc', '知识库检索 · 引用严谨'), soul: t('agents.tpl.kb.soul', '你是知识库问答助手，基于检索到的资料作答，严格引用来源，资料不足时明确说“未找到”，不编造。'), expertise: splitExp(t('agents.tpl.kb.exp', '知识库检索·来源引用·严谨作答')) },
  { key: 'meeting', slug: 'meeting-notes', icon: FileText, name: t('agents.tpl.meeting.name', '会议纪要'), desc: t('agents.tpl.meeting.desc', '录音纪要 · 结构化'), soul: t('agents.tpl.meeting.soul', '你是会议纪要助手，把录音或讨论整理成结构化纪要：议题、结论、待办（含负责人与截止），措辞中立。'), expertise: splitExp(t('agents.tpl.meeting.exp', '结构化纪要·待办提取·中立措辞')) },
  { key: 'research', slug: 'research-assistant', icon: Search, name: t('agents.tpl.research.name', '研究助理'), desc: t('agents.tpl.research.desc', '资料检索 · 综述引用'), soul: t('agents.tpl.research.soul', '你是研究助理，擅长检索资料、归纳综述、对比观点，给出带引用的结论，区分事实与推测。'), expertise: splitExp(t('agents.tpl.research.exp', '资料检索·综述归纳·引用标注')) },
])

// 二级 tab 进顶部栏（PageToolbar #tabs 槽），用 SegmentedControl，与其它页一致（对齐原型 tbar .seg）
const agentTabs = computed(() => [
  { key: 'mine', label: t('agents.tabMine', '我的智能体') },
  { key: 'templates', label: t('agents.tabTemplates', '模板库') },
])

const filteredTemplates = computed(() => {
  if (!searchQuery.value) return AGENT_TEMPLATES.value
  const q = searchQuery.value.toLowerCase()
  return AGENT_TEMPLATES.value.filter(
    (tpl) => tpl.name.toLowerCase().includes(q) || tpl.desc.toLowerCase().includes(q),
  )
})

/** 模板库卡片 → 预填新建表单并直接进第二步（与角色模板入口同样的 nextTick 时序）。 */
async function useLibraryTemplate(tpl: AgentTemplate) {
  errorMsg.value = ''
  showAddAgent.value = true
  // 等 showAddAgent watcher 的 reset 跑完，再写入预填值（否则会被清空）
  await nextTick()
  newAgent.value.name = tpl.slug
  newAgent.value.display_name = tpl.name
  newAgent.value.description = tpl.desc
  newAgent.value.system_prompt = tpl.soul
  selectedTemplateName.value = tpl.name
  selectedTemplateExpertise.value = tpl.expertise
  addStep.value = 2
}

const runtimeBackedProviders = computed(() =>
  (settingsStore.runtimeProviders ?? []).filter((provider) => provider.enabled),
)

const runtimeProviderOptions = computed(() =>
  runtimeBackedProviders.value.map((provider) => ({
    key: provider.backendKey || provider.name || provider.id,
    label: provider.name,
    // 服务商 logo（对齐设置页选择器）：按 provider.type 取内置 logo，未知类型回退 custom。
    icon: PROVIDER_LOGOS[provider.type] ?? PROVIDER_LOGOS.custom,
  })),
)

function modelsForProvider(providerKey: string) {
  const modelMap = new Map<string, { id: string; name: string }>()
  for (const model of settingsStore.availableModels) {
    if (model.providerKey !== providerKey) continue
    if (!modelMap.has(model.modelId)) {
      modelMap.set(model.modelId, {
        id: model.modelId,
        name: model.modelName,
      })
    }
  }
  return [...modelMap.values()]
}

function syncAgentModelSelection(agent: AgentConfig) {
  const models = modelsForProvider(agent.provider)
  if (!models.length) {
    agent.model = ''
    return
  }
  if (!models.some((model) => model.id === agent.model)) {
    agent.model = models[0]!.id
  }
}

// HcSelect 选项投影（替代原生 <select>，value 一律 string）
const newAgentProviderOptions = computed(() => [
  { value: '', label: t('agents.useGlobalDefault') },
  ...runtimeProviderOptions.value.map((p) => ({ value: p.key, label: p.label, icon: p.icon })),
])
const newAgentModelOptions = computed(() => [
  { value: '', label: t('settings.llm.models') },
  ...modelsForProvider(newAgent.value.provider).map((m) => ({ value: m.id, label: m.name })),
])
const editAgentProviderOptions = computed(() => {
  // 始终带「使用全局默认」(value:'') 占位——否则走全局默认(provider='')的 agent 编辑时
  // HcSelect 的 v-model='' 无匹配项 → 下拉空白显示异常（bug 2026-06-22）。
  const opts: { value: string; label: string; icon?: string }[] = [
    { value: '', label: t('agents.useGlobalDefault') },
    ...runtimeProviderOptions.value.map((p) => ({ value: p.key, label: p.label, icon: p.icon })),
  ]
  const cur = editingAgent.value.provider
  // 当前 provider 不在 runtime 列表时，补一个 "(invalid)" 选项保持选中态
  if (cur && !runtimeProviderOptions.value.some((p) => p.key === cur)) {
    opts.push({ value: cur, label: `${cur} (invalid)` })
  }
  return opts
})
const editAgentModelOptions = computed(() => {
  const models = modelsForProvider(editingAgent.value.provider)
  // 同理始终带 value:'' 占位，空 model 才有可匹配项（不空白）。
  const opts = [
    { value: '', label: t('settings.llm.models') },
    ...models.map((m) => ({ value: m.id, label: m.name })),
  ]
  const cur = editingAgent.value.model
  if (cur && !models.some((m) => m.id === cur)) {
    opts.push({ value: cur, label: `${cur} (invalid)` })
  }
  return opts
})

watch(() => newAgent.value.provider, () => {
  syncAgentModelSelection(newAgent.value)
})

watch(() => editingAgent.value.provider, () => {
  if (suppressEditProviderSync) return
  syncAgentModelSelection(editingAgent.value)
})

watch(showAddAgent, (isOpen, wasOpen) => {
  if (isOpen || wasOpen) {
    errorMsg.value = ''
  }
  if (!isOpen && wasOpen) {
    resetAddAgentDialog()
  }
  if (isOpen && !wasOpen) {
    resetAddAgentDialog()
  }
})

const registerFormValid = computed(() => {
  if (newAgent.value.name.trim() === '') return false
  const hasProvider = newAgent.value.provider.trim() !== ''
  const hasModel = newAgent.value.model.trim() !== ''
  // Both empty → use global default LLM (valid)
  if (!hasProvider && !hasModel) return true
  // Both set → validate model exists under provider
  if (hasProvider && hasModel) {
    return modelsForProvider(newAgent.value.provider).some((m) => m.id === newAgent.value.model)
  }
  // Only one set → invalid (backend requires both or neither)
  return false
})

const editFormValid = computed(() => {
  if (editingAgent.value.name.trim() === '') return false
  // 高级参数合法域（BUG-20260703 P2-4）：温度 [0,2] / max_tokens 非负整数
  if (!editTemperatureValid.value || !editMaxTokensValid.value) return false
  const provider = editingAgent.value.provider.trim()
  const model = editingAgent.value.model.trim()
  // BUG-20260703 D3：LLM 配置与打开快照一致（未真改）→ 有效。失效 provider 不连坐
  // 锁死人设编辑；后端对称放宽（handleUpdateAgent 未改不校验），真改时校验不放松。
  if (provider === editingOriginal.value.provider && model === editingOriginal.value.model) return true
  const hasProvider = provider !== ''
  const hasModel = model !== ''
  if (!hasProvider && !hasModel) return true
  if (hasProvider && hasModel) {
    return modelsForProvider(provider).some((m) => m.id === model)
  }
  return false
})

async function handleRegisterAgent(andChat = false) {
  if (registering.value) return
  if (runtimeProviderOptions.value.length === 0) {
    errorMsg.value = t('agents.noRuntimeProviders', '当前没有可用的运行时模型，请先在设置中应用至少一个服务商')
    return
  }
  if (!registerFormValid.value || !newAgentTemperatureValid.value || !newAgentMaxTokensValid.value) {
    errorMsg.value = t('agents.formIncomplete', '请完善必填字段')
    return
  }
  errorMsg.value = ''
  if (agents.value.some((a) => a.name === newAgent.value.name.trim())) {
    errorMsg.value = t('agents.duplicateName', { name: newAgent.value.name.trim() })
    return
  }
  registering.value = true
  try {
    // 原型对齐批次：创建与编辑同构——高级参数/挂载 Skill/头像 创建时即可配齐。
    const tempRaw = advInputRaw(newAgentTemperature.value)
    const tokenRaw = advInputRaw(newAgentMaxTokens.value)
    const payload: AgentConfig = {
      ...newAgent.value,
      ...(tempRaw !== '' ? { temperature: Number(tempRaw) } : {}),
      ...(tokenRaw !== '' ? { max_tokens: Math.trunc(Number(tokenRaw)) } : {}),
      ...(newAgentSkills.value.length ? { skills: [...newAgentSkills.value] } : {}),
      ...(newAgentAvatar.value
        ? { metadata: { ...(newAgent.value.metadata ?? {}), avatar: newAgentAvatar.value } }
        : {}),
    }
    const createdName = payload.name.trim()
    await registerAgent(payload)
    closeAddAgentDialog()
    await loadAgents()
    // 创建并开始对话（增长主动线）：直达与新智能体的第一句对话。
    if (andChat && createdName) enterAgentChat(createdName)
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('agents.registerAgentFailed')
    logger.error('注册 Agent 失败:', e)
  } finally {
    registering.value = false
  }
}

function confirmUnregister(name: string) {
  unregisteringName.value = name
  showUnregisterConfirm.value = true
}

async function handleUnregisterAgent() {
  if (unregistering.value) return
  if (!unregisteringName.value) return
  errorMsg.value = ''
  if (unregisteringName.value === defaultAgent.value) {
    errorMsg.value = t('agents.cannotDeleteDefault', { name: unregisteringName.value })
    showUnregisterConfirm.value = false
    unregisteringName.value = ''
    return
  }
  unregistering.value = true
  try {
    await unregisterAgent(unregisteringName.value)
    agents.value = agents.value.filter((a) => a.name !== unregisteringName.value)
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('agents.unregisterAgentFailed')
    logger.error('注销 Agent 失败:', e)
  } finally {
    unregistering.value = false
    showUnregisterConfirm.value = false
    unregisteringName.value = ''
  }
}
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <PageToolbar :search-placeholder="t('agents.searchPlaceholder')" @search="v => searchQuery = v">
      <template #tabs>
        <SegmentedControl v-model="activeTab" :segments="agentTabs" />
      </template>
      <template #actions>
        <!-- 「新建智能体」主操作常驻工具栏（打开两步弹窗：选择起点 → 表单） -->
        <button
          class="hc-btn hc-btn-primary"
          @click="openAddAgentDialog"
        >
          <Plus :size="14" />
          {{ t('agents.newAgent') }}
        </button>
      </template>
    </PageToolbar>

    <!-- Error alert -->
    <div
      v-if="errorMsg"
      class="mx-6 mt-2 px-4 py-2 rounded-lg text-sm flex items-center justify-between"
      style="background: #ef444420; color: #ef4444;"
    >
      <span>{{ errorMsg }}</span>
      <button class="text-xs underline ml-4" @click="errorMsg = ''">{{ t('common.close') }}</button>
    </div>

    <div class="flex-1 overflow-y-auto p-6">
      <!-- ── 我的智能体：小蟹默认助理 hero + 专属智能体 roster ── -->
      <template v-if="activeTab === 'mine'">
      <LoadingState v-if="agentsLoading" />

      <template v-else>
          <div>
            <!-- 默认助理「小蟹」hero 卡：跟随全局默认 + 智能路由 + 人设(SOUL) -->
            <div class="hc-cxcard hc-cxcard--hero mb-4">
              <div class="hc-cxtop">
                <div class="hc-cxlogo hc-cxlogo--brand">
                  <img :src="logoUrl" alt="" width="38" height="38" />
                </div>
                <div class="min-w-0">
                  <div class="hc-cxnm flex items-center gap-2 flex-wrap">
                    {{ defaultAssistantName }}
                    <span class="hc-tag">{{ t('agents.defaultAssistantTag') }}</span>
                  </div>
                  <div class="hc-cxmeta">{{ t('agents.defaultAssistantMeta') }}</div>
                </div>
                <div class="flex-1"></div>
                <span class="hc-pill hc-pill--green">{{ t('agents.default') }}</span>
              </div>
              <div class="hc-crow">
                <button class="hc-btn" @click="openSoulEditor">
                  <Pencil :size="13" />
                  {{ t('agents.editSoul') }}
                </button>
                <span class="hc-tag">{{ t('agents.followSettingsRouting') }}</span>
              </div>
            </div>

            <!-- 专属智能体 section -->
            <div class="hc-cxsec">
              <h2>{{ t('agents.dedicatedAgents') }}</h2>
              <span class="hc-note">{{ t('agents.dedicatedAgentsNote') }}</span>
            </div>

            <div class="hc-cxcards">
              <!-- roster：替换型智能体卡（独立人设、通道/任务绑定） -->
              <div
                v-for="agent in filteredAgents"
                :key="agent.name"
                class="hc-cxcard"
              >
                <div class="hc-cxtop">
                  <div class="hc-cxlogo">
                    <span v-if="agent.metadata?.avatar" class="text-[20px] leading-none">{{ agent.metadata.avatar }}</span>
                    <Bot v-else :size="20" />
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="hc-cxnm flex items-center gap-2 flex-wrap">
                      {{ agent.display_name || agent.name }}
                      <!-- BUG-20260703 问题4：router 自动兜底（第一个注册者）≠ 小蟹「默认助理」。
                           徽章按真实语义命名，title 讲清桌面聊天不受它影响，消除双「默认」撞车。 -->
                      <span
                        v-if="agent.name === defaultAgent"
                        class="hc-pill hc-pill--green"
                        data-testid="agent-im-fallback-badge"
                        :title="t('agents.imFallbackTitle')"
                      >{{ t('agents.imFallback') }}</span>
                    </div>
                    <div class="hc-cxmeta truncate">{{ agent.description || t('agents.noDesc') }}</div>
                  </div>
                </div>

                <!-- 绑定标签行（通道 / 任务） -->
                <div v-if="getAgentBindings(agent.name).length" class="hc-crow">
                  <span
                    v-for="b in getAgentBindings(agent.name)"
                    :key="b"
                    class="hc-tag"
                  >
                    {{ b }}
                  </span>
                </div>

                <!-- 操作行：进入对话 + 编辑 + 停用（对齐原型；停用=注销，功能接线保留） -->
                <div class="hc-crow">
                  <!-- BUG-20260703 问题1：每张卡一键进会话（复用 /chat?role= 的收件人锁定机制），
                       不再只有 K12 卡能直达、其余智能体只能靠 @ 召唤。 -->
                  <button
                    class="hc-btn hc-btn-primary"
                    :data-testid="`agent-enter-chat-${agent.name}`"
                    @click="enterAgentChat(agent.name)"
                  >
                    <MessageSquare :size="13" />
                    {{ t('agents.enterChat') }}
                  </button>
                  <button class="hc-btn" @click="openEditAgent(agent)">
                    <Pencil :size="13" />
                    {{ t('common.edit') }}
                  </button>
                  <button
                    v-if="agent.name !== defaultAgent"
                    class="hc-btn hc-btn--danger"
                    @click="confirmUnregister(agent.name)"
                  >
                    <Trash2 :size="13" />
                    {{ t('agents.delete', '删除') }}
                  </button>
                </div>
              </div>
            </div>
          </div>
      </template>
      </template>

      <!-- ── 模板库：10 个常用预设，点击预填并进入新建第二步 ── -->
      <template v-else>
        <div class="hc-cxsec">
          <h2>{{ t('agents.tabTemplates', '模板库') }}</h2>
          <span class="hc-note">{{ t('agents.templatesNote', '套用模板快速建专才（各自独立人设）') }}</span>
        </div>
        <div v-if="filteredTemplates.length === 0" class="hc-tpl-empty">
          {{ t('agents.noTemplateMatch', '没有匹配的模板') }}
        </div>
        <div v-else class="hc-cxcards">
          <button
            v-for="tpl in filteredTemplates"
            :key="tpl.key"
            type="button"
            class="hc-cxcard hc-tplcard"
            @click="useLibraryTemplate(tpl)"
          >
            <div class="hc-cxtop">
              <div class="hc-cxlogo"><component :is="tpl.icon" :size="20" /></div>
              <div class="min-w-0 flex-1">
                <div class="hc-cxnm">{{ tpl.name }}</div>
                <div class="hc-cxmeta truncate">{{ tpl.desc }}</div>
              </div>
            </div>
            <div class="hc-crow">
              <span class="hc-tag hc-tag--accent">{{ t('agents.useTemplate', '使用此模板') }}</span>
            </div>
          </button>
        </div>
      </template>

    </div>

    <!-- 注册 Agent 对话框 -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="showAddAgent" class="fixed inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-sm" @click.self="closeAddAgentDialog">
          <div
            class="w-full rounded-2xl border flex flex-col overflow-hidden max-h-[88vh] max-w-md"
            :style="{ background: 'var(--hc-bg-elevated)', borderColor: 'var(--hc-border)' }"
          >
            <div class="flex items-center justify-between px-5 py-4 border-b" :style="{ borderColor: 'var(--hc-border)' }">
              <h2 class="text-[15px] font-semibold m-0" :style="{ color: 'var(--hc-text-primary)' }">
                {{ addStep === 2 && selectedTemplateName ? selectedTemplateName : t('agents.newAgent') }}
              </h2>
              <button class="p-1 rounded-md hover:bg-white/5" :style="{ color: 'var(--hc-text-muted)' }" @click="closeAddAgentDialog">
                <X :size="17" />
              </button>
            </div>

            <!-- 第一步：选择起点（空白新建 / 从模板库开始）——不再内嵌第二份模板货架 -->
            <template v-if="addStep === 1">
              <div class="p-5 flex flex-col gap-3.5">
                <div class="text-[13px]" :style="{ color: 'var(--hc-text-secondary)' }">
                  {{ t('agents.chooseStartTitle', '选择起点') }}
                </div>
                <div class="hc-startgrid">
                  <!-- 空白新建 -->
                  <button type="button" class="hc-startcard" data-testid="start-blank" @click="startFromBlank">
                    <div class="hc-startcard__icon"><Plus :size="18" /></div>
                    <div class="hc-startcard__nm">{{ t('agents.startBlank', '空白新建') }}</div>
                    <div class="hc-startcard__meta">{{ t('agents.startBlankMeta', '从零开始配置') }}</div>
                  </button>
                  <!-- 从模板库开始：唯一货架的入口，点击切到模板库 tab 挑模板 -->
                  <button type="button" class="hc-startcard" data-testid="start-from-library" @click="startFromLibrary">
                    <div class="hc-startcard__icon"><LibraryBig :size="18" /></div>
                    <div class="hc-startcard__nm">{{ t('agents.startFromLibrary', '从模板库开始') }}</div>
                    <div class="hc-startcard__meta">{{ t('agents.startFromLibraryMeta', '挑一个常用模板预填') }}</div>
                  </button>
                </div>
              </div>
              <div class="flex items-center justify-end gap-2 px-5 py-3.5 border-t" :style="{ borderColor: 'var(--hc-border)' }">
                <button class="px-3 py-1.5 rounded-lg text-sm font-medium" :style="{ color: 'var(--hc-text-secondary)', background: 'var(--hc-bg-hover)' }" @click="closeAddAgentDialog">
                  {{ t('common.cancel') }}
                </button>
              </div>
            </template>

            <!-- 第二步：表单（原型对齐：基本信息展开 + 模型与参数/Skill 折叠，创建/编辑同构） -->
            <template v-else>
              <div class="p-5 flex flex-col gap-3.5 overflow-y-auto min-h-0 flex-1">
                <!-- 套用模板时展示其专长：厚数据可见，不在进表单时静默蒸发 -->
                <div v-if="selectedTemplateExpertise.length" class="hc-tplexp" data-testid="template-expertise">
                  <span class="hc-tplexp__label">{{ t('agents.templateExpertiseLabel', '此模板擅长') }}</span>
                  <span v-for="exp in selectedTemplateExpertise" :key="exp" class="hc-tplexp__chip">{{ exp }}</span>
                </div>
                <div class="flex flex-col gap-1.5">
                  <label class="text-[13px] font-medium" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('agents.avatarLabel', '头像') }}</label>
                  <div class="flex flex-wrap gap-2">
                    <button
                      v-for="e in AVATAR_CHOICES"
                      :key="e"
                      type="button"
                      class="w-[34px] h-[34px] rounded-[10px] grid place-items-center text-[17px] border transition-transform hover:scale-105"
                      :data-testid="`agent-avatar-pick-${e}`"
                      :style="{
                        cursor: 'pointer',
                        background: newAgentAvatar === e ? 'var(--hc-accent-subtle)' : 'var(--hc-bg-input)',
                        borderColor: newAgentAvatar === e ? 'var(--hc-accent)' : 'var(--hc-border)',
                      }"
                      @click="newAgentAvatar = e"
                    >{{ e }}</button>
                  </div>
                </div>
                <div class="flex flex-col gap-1.5">
                  <label class="text-[13px] font-medium" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('agents.name') }}</label>
                  <input v-model="newAgent.name" type="text" class="rounded-lg border px-3 py-2 text-sm outline-none" :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }" placeholder="agent-name" />
                  <span class="text-[11.5px] leading-snug" :style="{ color: 'var(--hc-text-muted)' }">{{ t('agents.nameHint') }}</span>
                </div>
                <div class="flex flex-col gap-1.5">
                  <label class="text-[13px] font-medium" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('agents.displayName') }}</label>
                  <input v-model="newAgent.display_name" type="text" class="rounded-lg border px-3 py-2 text-sm outline-none" :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }" placeholder="My Agent" />
                  <span class="text-[11.5px] leading-snug" :style="{ color: 'var(--hc-text-muted)' }">{{ t('agents.displayNameHint') }}</span>
                </div>
                <!-- 人设(SOUL)：自然语言（去 mono，RTL 铁律）+ 快速起草骨架 + 字数 + 专注编辑 -->
                <div class="flex flex-col gap-1.5">
                  <label class="text-[13px] font-medium" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('agents.soulField', '人设（SOUL）') }}</label>
                  <textarea
                    ref="addSoulEl"
                    v-model="newAgentSoul"
                    rows="5"
                    :placeholder="t('agents.soulFieldPh', '描述该智能体的身份、语气、专长与边界。留空 = 使用全局默认人设。')"
                    class="rounded-lg border px-3 py-2 text-sm outline-none resize-y leading-relaxed"
                    :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
                  ></textarea>
                  <div class="flex items-center gap-1.5 flex-wrap">
                    <span class="text-[11.5px]" :style="{ color: 'var(--hc-text-muted)' }">{{ t('agents.soulQuickDraft', '快速起草：') }}</span>
                    <button
                      v-for="(_, key) in SOUL_DRAFTS"
                      :key="key"
                      type="button"
                      class="text-[11.5px] px-2 py-1 rounded-lg border"
                      :data-testid="`agent-soul-draft-${key}`"
                      :style="{ cursor: 'pointer', background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-secondary)' }"
                      @click="fillSoulDraft('add', key as string)"
                    >{{ t(`agents.soulDraft.${key}`) }}</button>
                    <button
                      type="button"
                      class="text-[11.5px] px-2 py-1 rounded-lg border inline-flex items-center gap-1"
                      data-testid="agent-soul-focus-add"
                      :style="{ cursor: 'pointer', background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-secondary)' }"
                      @click="openSoulFocus('add')"
                    >{{ t('agents.focusEdit', '专注编辑 ⤢') }}</button>
                    <span class="text-[11px] ml-auto" :style="{ color: 'var(--hc-text-muted)' }">{{ t('agents.soulCharCount', { n: (newAgentSoul || '').length }) }}</span>
                  </div>
                </div>
                <!-- 模型与参数 + 挂载 Skill：进阶折叠（有合理默认，多数人不必展开） -->
                <button
                  type="button"
                  class="flex items-center gap-1.5 text-xs font-medium mt-1"
                  :style="{ color: 'var(--hc-text-muted)' }"
                  data-testid="agent-add-adv-toggle"
                  @click="toggleAddAdvanced"
                >
                  <ChevronDown v-if="!showAddAdvanced" :size="12" />
                  <ChevronUp v-else :size="12" />
                  {{ t('agents.advSection', '模型与参数 · Skill') }}
                  <span class="font-normal" data-testid="agent-add-adv-summary">— {{ addAdvSummary }}</span>
                </button>
                <template v-if="showAddAdvanced">
                  <div class="flex flex-col gap-1.5">
                    <label class="text-[12px]" :style="{ color: 'var(--hc-text-muted)' }">{{ t('agents.modelPreferenceHint', '进入该智能体会话时自动切换到此模型；留空跟随全局默认。') }}</label>
                    <HcSelect v-model="newAgent.provider" :options="newAgentProviderOptions" />
                  </div>
                  <div v-if="newAgent.provider" class="flex flex-col gap-1.5">
                    <HcSelect v-model="newAgent.model" :options="newAgentModelOptions" />
                  </div>
                  <div v-else-if="resolvedGlobalDefaultModel" class="text-[12px]" data-testid="agent-add-model-follow" :style="{ color: 'var(--hc-text-muted)' }">
                    {{ t('agents.followGlobalWith', { model: resolvedGlobalDefaultModel }) }} 🔒
                  </div>
                  <div class="flex flex-col gap-1.5">
                    <label class="text-[12px] font-medium" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('agents.temperature', '温度 (temperature)') }}</label>
                    <div class="flex flex-wrap gap-1.5">
                      <button
                        v-for="p in TEMP_PRESETS"
                        :key="p.v"
                        type="button"
                        class="px-2.5 py-1 rounded-lg text-[12px] border"
                        :data-testid="`agent-add-temp-preset-${p.v || 'follow'}`"
                        :style="{
                          cursor: 'pointer',
                          background: advInputRaw(newAgentTemperature) === p.v ? 'var(--hc-accent-subtle)' : 'var(--hc-bg-input)',
                          borderColor: advInputRaw(newAgentTemperature) === p.v ? 'var(--hc-accent)' : 'var(--hc-border)',
                          color: advInputRaw(newAgentTemperature) === p.v ? 'var(--hc-accent)' : 'var(--hc-text-secondary)',
                        }"
                        @click="newAgentTemperature = p.v"
                      >{{ t(p.labelKey) }}{{ p.v ? ` ${p.v}` : '' }}</button>
                    </div>
                    <input
                      v-model="newAgentTemperature"
                      type="number"
                      min="0"
                      max="2"
                      step="0.1"
                      class="rounded-lg border px-3 py-2 text-sm outline-none"
                      :style="{ background: 'var(--hc-bg-input)', borderColor: newAgentTemperatureValid ? 'var(--hc-border)' : 'var(--hc-error)', color: 'var(--hc-text-primary)' }"
                      :placeholder="t('agents.temperaturePlaceholder', '留空跟随模型默认；0 = 确定性')"
                    />
                    <span v-if="!newAgentTemperatureValid" class="text-[11px]" :style="{ color: 'var(--hc-error)' }">{{ t('agents.temperatureRange', '温度须在 0 ~ 2 之间') }}</span>
                  </div>
                  <div class="flex flex-col gap-1.5">
                    <label class="text-[12px] font-medium" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('agents.maxTokens', '最大输出 token') }}</label>
                    <input
                      v-model="newAgentMaxTokens"
                      type="number"
                      min="0"
                      step="1"
                      class="rounded-lg border px-3 py-2 text-sm outline-none"
                      :style="{ background: 'var(--hc-bg-input)', borderColor: newAgentMaxTokensValid ? 'var(--hc-border)' : 'var(--hc-error)', color: 'var(--hc-text-primary)' }"
                      :placeholder="t('agents.maxTokensPlaceholder', '留空跟随模型默认')"
                    />
                  </div>
                  <AgentSkillPicker v-model="newAgentSkills" :available="availableSkills" />
                </template>
              </div>
              <div class="flex items-center justify-between gap-2 px-5 py-3.5 border-t flex-shrink-0" :style="{ borderColor: 'var(--hc-border)' }">
                <button class="px-3 py-1.5 rounded-lg text-sm font-medium" :style="{ color: 'var(--hc-text-secondary)', background: 'var(--hc-bg-hover)' }" @click="addStep = 1">
                  {{ t('common.back', '上一步') }}
                </button>
                <div class="flex items-center gap-2">
                  <!-- 「仅创建」降级为次按钮；主 CTA=创建并开始对话（一个弹窗一个主行动） -->
                  <button
                    class="px-3 py-1.5 rounded-lg text-sm font-medium"
                    :style="{ color: 'var(--hc-text-secondary)', background: 'var(--hc-bg-hover)', opacity: !registerFormValid ? 0.4 : 1 }"
                    :disabled="!registerFormValid"
                    data-testid="agent-create-only"
                    @click="handleRegisterAgent(false)"
                  >
                    {{ t('agents.createOnly', '仅创建') }}
                  </button>
                  <button
                    class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium text-white"
                    :style="{ background: 'var(--hc-accent)', opacity: !registerFormValid ? 0.4 : 1 }"
                    :disabled="!registerFormValid"
                    data-testid="agent-create-and-chat"
                    @click="handleRegisterAgent(true)"
                  >
                    <Plus :size="14" />
                    {{ t('agents.createAndChat', '创建并开始对话') }}
                  </button>
                </div>
              </div>
            </template>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- 编辑 Agent 路由对话框 -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="showEditAgent" class="fixed inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-sm" @click.self="closeEditAgentDialog">
          <!-- 原型对齐：max-h + 头尾固定 + 中段独立滚动（修「保存按钮不可达」P0）；
               基本信息展开，服务商/模型并入「模型与参数 · Skill」折叠区（与创建同构） -->
          <div
            class="w-full max-w-md rounded-2xl border flex flex-col overflow-hidden max-h-[85vh]"
            :style="{ background: 'var(--hc-bg-elevated)', borderColor: 'var(--hc-border)' }"
          >
            <div class="flex items-center justify-between px-5 py-4 border-b flex-shrink-0" :style="{ borderColor: 'var(--hc-border)' }">
              <h2 class="text-[15px] font-semibold m-0" :style="{ color: 'var(--hc-text-primary)' }">{{ t('agents.editAgent') }}</h2>
              <button class="p-1 rounded-md hover:bg-white/5" :style="{ color: 'var(--hc-text-muted)' }" @click="closeEditAgentDialog">
                <X :size="17" />
              </button>
            </div>
            <div class="p-5 flex flex-col gap-3.5 overflow-y-auto min-h-0 flex-1">
              <div class="flex flex-col gap-1.5">
                <label class="text-[13px] font-medium" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('agents.avatarLabel', '头像') }}</label>
                <div class="flex flex-wrap gap-2">
                  <button
                    v-for="e in AVATAR_CHOICES"
                    :key="e"
                    type="button"
                    class="w-[34px] h-[34px] rounded-[10px] grid place-items-center text-[17px] border transition-transform hover:scale-105"
                    :style="{
                      cursor: 'pointer',
                      background: editAvatar === e ? 'var(--hc-accent-subtle)' : 'var(--hc-bg-input)',
                      borderColor: editAvatar === e ? 'var(--hc-accent)' : 'var(--hc-border)',
                    }"
                    @click="editAvatar = e"
                  >{{ e }}</button>
                </div>
              </div>
              <div class="flex flex-col gap-1.5">
                <label class="text-[13px] font-medium" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('agents.name') }}</label>
                <input :value="editingAgent.name" type="text" disabled class="rounded-lg border px-3 py-2 text-sm outline-none opacity-60" :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }" />
                <span class="text-[11.5px] leading-snug" :style="{ color: 'var(--hc-text-muted)' }">{{ t('agents.nameHint') }}</span>
              </div>
              <div class="flex flex-col gap-1.5">
                <label class="text-[13px] font-medium" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('agents.displayName') }}</label>
                <input v-model="editingAgent.display_name" type="text" class="rounded-lg border px-3 py-2 text-sm outline-none" :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }" />
                <span class="text-[11.5px] leading-snug" :style="{ color: 'var(--hc-text-muted)' }">{{ t('agents.displayNameHint') }}</span>
              </div>
              <div class="flex flex-col gap-1.5">
                <label class="text-[13px] font-medium" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('agents.systemPrompt', '人设(SOUL)') }}</label>
                <textarea
                  ref="editSoulEl"
                  v-model="editingAgent.system_prompt"
                  rows="5"
                  class="rounded-lg border px-3 py-2 text-sm outline-none resize-y leading-relaxed"
                  :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
                  :placeholder="t('agents.systemPromptPlaceholder', '定义该 Agent 的角色与行为，留空则用默认人设')"
                ></textarea>
                <div class="flex items-center gap-1.5 flex-wrap">
                  <span class="text-[11.5px]" :style="{ color: 'var(--hc-text-muted)' }">{{ t('agents.soulQuickDraft', '快速起草：') }}</span>
                  <button
                    v-for="(_, key) in SOUL_DRAFTS"
                    :key="key"
                    type="button"
                    class="text-[11.5px] px-2 py-1 rounded-lg border"
                    :style="{ cursor: 'pointer', background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-secondary)' }"
                    @click="fillSoulDraft('edit', key as string)"
                  >{{ t(`agents.soulDraft.${key}`) }}</button>
                  <button
                    type="button"
                    class="text-[11.5px] px-2 py-1 rounded-lg border inline-flex items-center gap-1"
                    data-testid="agent-soul-focus-edit"
                    :style="{ cursor: 'pointer', background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-secondary)' }"
                    @click="openSoulFocus('edit')"
                  >{{ t('agents.focusEdit', '专注编辑 ⤢') }}</button>
                  <span class="text-[11px] ml-auto" :style="{ color: 'var(--hc-text-muted)' }">{{ t('agents.soulCharCount', { n: (editingAgent.system_prompt || '').length }) }}</span>
                </div>
              </div>

              <!-- 模型与参数 + 挂载 Skill（P2-4 契约保留：agent-adv-* testid 不变） -->
              <div class="flex flex-col gap-2">
                <button
                  type="button"
                  class="flex items-center gap-1.5 text-[12px] font-medium self-start"
                  :style="{ color: 'var(--hc-text-muted)', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }"
                  :aria-expanded="showEditAdvanced"
                  data-testid="agent-adv-toggle"
                  @click="toggleEditAdvanced"
                >
                  <ChevronDown v-if="!showEditAdvanced" :size="12" />
                  <ChevronUp v-else :size="12" />
                  {{ t('agents.advSection', '模型与参数 · Skill') }}
                  <span class="font-normal" data-testid="agent-adv-summary">— {{ editAdvSummary }}</span>
                </button>
                <div v-if="showEditAdvanced" class="flex flex-col gap-3 rounded-lg p-3" :style="{ background: 'var(--hc-bg-card)' }">
                  <div class="flex flex-col gap-1.5">
                    <label class="text-[13px] font-medium" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('agents.provider') }}</label>
                    <HcSelect
                      v-model="editingAgent.provider"
                      :options="editAgentProviderOptions"
                    />
                  </div>
                  <div class="flex flex-col gap-1.5">
                    <label class="text-[13px] font-medium" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('agents.model') }}</label>
                    <HcSelect
                      v-model="editingAgent.model"
                      :options="editAgentModelOptions"
                      :disabled="!editingAgent.provider"
                    />
                    <span v-if="!editingAgent.provider && resolvedGlobalDefaultModel" class="text-[11.5px]" data-testid="agent-edit-model-follow" :style="{ color: 'var(--hc-text-muted)' }">
                      {{ t('agents.followGlobalWith', { model: resolvedGlobalDefaultModel }) }} 🔒
                    </span>
                  </div>
                  <div class="flex flex-col gap-1.5">
                    <label class="text-[12px] font-medium" :style="{ color: 'var(--hc-text-secondary)' }">
                      {{ t('agents.temperature', '温度 (temperature)') }}
                    </label>
                    <div class="flex flex-wrap gap-1.5">
                      <button
                        v-for="p in TEMP_PRESETS"
                        :key="p.v"
                        type="button"
                        class="px-2.5 py-1 rounded-lg text-[12px] border"
                        :data-testid="`agent-temp-preset-${p.v || 'follow'}`"
                        :style="{
                          cursor: 'pointer',
                          background: advInputRaw(editTemperature) === p.v ? 'var(--hc-accent-subtle)' : 'var(--hc-bg-input)',
                          borderColor: advInputRaw(editTemperature) === p.v ? 'var(--hc-accent)' : 'var(--hc-border)',
                          color: advInputRaw(editTemperature) === p.v ? 'var(--hc-accent)' : 'var(--hc-text-secondary)',
                        }"
                        @click="editTemperature = p.v"
                      >{{ t(p.labelKey) }}{{ p.v ? ` ${p.v}` : '' }}</button>
                    </div>
                    <input
                      v-model="editTemperature"
                      type="number"
                      min="0"
                      max="2"
                      step="0.1"
                      data-testid="agent-adv-temperature"
                      class="rounded-lg border px-3 py-2 text-sm outline-none"
                      :style="{ background: 'var(--hc-bg-input)', borderColor: editTemperatureValid ? 'var(--hc-border)' : 'var(--hc-error)', color: 'var(--hc-text-primary)' }"
                      :placeholder="t('agents.temperaturePlaceholder', '留空跟随模型默认；0 = 确定性')"
                    />
                    <span v-if="!editTemperatureValid" class="text-[11px]" :style="{ color: 'var(--hc-error)' }">
                      {{ t('agents.temperatureRange', '温度须在 0 ~ 2 之间') }}
                    </span>
                  </div>
                  <div class="flex flex-col gap-1.5">
                    <label class="text-[12px] font-medium" :style="{ color: 'var(--hc-text-secondary)' }">
                      {{ t('agents.maxTokens', '最大输出 token') }}
                    </label>
                    <input
                      v-model="editMaxTokens"
                      type="number"
                      min="0"
                      step="1"
                      data-testid="agent-adv-maxtokens"
                      class="rounded-lg border px-3 py-2 text-sm outline-none"
                      :style="{ background: 'var(--hc-bg-input)', borderColor: editMaxTokensValid ? 'var(--hc-border)' : 'var(--hc-error)', color: 'var(--hc-text-primary)' }"
                      :placeholder="t('agents.maxTokensPlaceholder', '留空跟随模型默认')"
                    />
                  </div>
                  <AgentSkillPicker v-model="editSkills" :available="availableSkills" />
                </div>
              </div>
            </div>
            <div class="flex items-center justify-end gap-2 px-5 py-3.5 border-t flex-shrink-0" :style="{ borderColor: 'var(--hc-border)' }">
              <button class="px-3 py-1.5 rounded-lg text-sm font-medium" :style="{ color: 'var(--hc-text-secondary)', background: 'var(--hc-bg-hover)' }" @click="closeEditAgentDialog">
                {{ t('common.cancel') }}
              </button>
              <button
                class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium text-white"
                :style="{ background: 'var(--hc-accent)', opacity: !editFormValid ? 0.4 : 1 }"
                :disabled="!editFormValid"
                @click="handleEditAgent"
              >
                {{ t('common.save') }}
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- SOUL 结构化编辑器（专注编辑 ⤢，创建/编辑共用；FLIP 放大、不关底层弹窗、完成回填） -->
    <Teleport to="body">
      <SoulStructuredEditor
        v-if="soulEditorOpen"
        :model-value="soulEditorSeed"
        :agent-name="soulEditorAgentName"
        :source-rect="soulEditorRect"
        :skills="soulEditorSkills"
        @apply="onSoulApply"
        @close="soulEditorOpen = false"
      />
    </Teleport>

    <!-- 默认助理「小蟹」人设(SOUL) 编辑弹层 -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="showSoulEditor" class="fixed inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-sm p-4" @click.self="closeSoulEditor">
          <div
            class="w-full rounded-2xl border flex flex-col overflow-hidden max-w-lg"
            :style="{ background: 'var(--hc-bg-elevated)', borderColor: 'var(--hc-border)' }"
          >
            <div class="flex items-center justify-between px-5 py-4 border-b" :style="{ borderColor: 'var(--hc-border)' }">
              <div class="min-w-0">
                <h2 class="text-[15px] font-semibold m-0" :style="{ color: 'var(--hc-text-primary)' }">{{ t('agents.soul.title', '编辑人设（SOUL）') }}</h2>
                <p class="text-xs m-0 mt-0.5" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('agents.soul.subtitle', '小蟹 · 默认助理 · 存于本机 ~/.hexclaw/SOUL.md') }}</p>
              </div>
              <button class="p-1 rounded-md hover:bg-white/5" :style="{ color: 'var(--hc-text-muted)' }" @click="closeSoulEditor">
                <X :size="17" />
              </button>
            </div>
            <div class="p-5 flex flex-col gap-3">
              <div v-if="soulLoadError" class="rounded-lg border px-3 py-2 text-xs" :style="{ borderColor: 'var(--hc-amber)', color: 'var(--hc-amber)', background: 'var(--hc-bg-hover)' }">
                {{ t('agents.soul.loadError', '引擎未连接，无法读取当前人设；保存将在引擎恢复后生效。') }}
              </div>
              <div class="flex items-center justify-end">
                <span class="hc-tag" :class="soulIsCustom ? 'hc-tag--accent' : ''">
                  {{ soulIsCustom ? t('agents.soul.stateCustom', '已自定义') : t('agents.soul.stateDefault', '内置默认') }}
                </span>
              </div>
              <textarea
                v-model="soulText"
                rows="9"
                :disabled="soulLoading"
                :placeholder="t('agents.soul.placeholder', '描述小蟹的身份、语气、专长与边界。留空 = 使用引擎内置默认人设。')"
                class="rounded-lg border px-3 py-2 text-sm outline-none resize-y font-mono leading-relaxed"
                :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
              ></textarea>
              <p class="text-xs m-0" :style="{ color: 'var(--hc-text-muted)' }">
                {{ t('agents.soul.hint', '引擎每轮对话读取该文件，保存后下一轮即时生效，无需重启。') }}
              </p>
              <details v-if="soulDefaultPrompt" class="text-xs">
                <summary class="cursor-pointer select-none" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('agents.soul.viewDefault', '查看内置默认人设') }}</summary>
                <pre class="mt-2 p-3 rounded-lg whitespace-pre-wrap break-words max-h-40 overflow-auto" :style="{ background: 'var(--hc-bg-input)', color: 'var(--hc-text-secondary)' }">{{ soulDefaultPrompt }}</pre>
              </details>
            </div>
            <div class="flex items-center justify-between gap-2 px-5 py-3.5 border-t" :style="{ borderColor: 'var(--hc-border)' }">
              <button
                class="px-3 py-1.5 rounded-lg text-sm font-medium"
                :style="{ color: 'var(--hc-text-secondary)', background: 'var(--hc-bg-hover)' }"
                :disabled="!soulText.trim()"
                :class="{ 'opacity-40 cursor-not-allowed': !soulText.trim() }"
                @click="clearSoulToDefault"
              >
                {{ t('agents.soul.restoreDefault', '恢复默认') }}
              </button>
              <div class="flex items-center gap-2">
                <button class="px-3 py-1.5 rounded-lg text-sm font-medium" :style="{ color: 'var(--hc-text-secondary)', background: 'var(--hc-bg-hover)' }" @click="closeSoulEditor">
                  {{ t('common.cancel') }}
                </button>
                <button
                  class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium text-white"
                  :style="{ background: 'var(--hc-accent)', opacity: soulSaving ? 0.6 : 1 }"
                  :disabled="soulSaving"
                  @click="saveSoul"
                >
                  {{ soulSaving ? t('common.saving', '保存中…') : t('common.save') }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- 删除确认（智能体无独立停用态，删除即注销，不可恢复） -->
    <ConfirmDialog
      :open="showUnregisterConfirm"
      :danger="true"
      :title="t('agents.deleteConfirmTitle', '删除智能体')"
      :message="t('agents.deleteConfirmMessage', '确定删除该智能体？此操作不可恢复。')"
      :confirm-text="t('agents.delete', '删除')"
      @confirm="handleUnregisterAgent"
      @cancel="showUnregisterConfirm = false; unregisteringName = ''"
    />

  </div>
</template>

<style scoped>
/* ── 卡片布局（对齐原型 app.html cxcard 系列） ── */
.hc-cxsec {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin: 18px 2px 10px;
}
.hc-cxsec:first-child { margin-top: 0; }
.hc-cxsec h2 {
  font-size: 15px;
  margin: 0;
  color: var(--hc-text-primary);
}
.hc-note {
  font-size: 12px;
  color: var(--hc-text-secondary);
}

.hc-cxcards {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.hc-cxcard {
  background: var(--hc-bg-card);
  border: 0.5px solid var(--hc-border);
  border-radius: 14px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  text-align: left;
  box-shadow: var(--hc-shadow-sm);
  transition: border-color 0.15s ease-out, box-shadow 0.2s ease-out, transform 0.12s ease-out;
}
.hc-cxcard:hover {
  border-color: var(--hc-border-hl);
  box-shadow: var(--hc-shadow-md);
  transform: translateY(-2px);
}

.hc-cxcard--hero {
  border: 1px solid var(--hc-border-hl);
  background: var(--hc-accent-subtle);
  box-shadow: 0 0 0 3px var(--hc-accent-subtle);
}
.hc-cxcard--hero:hover { transform: translateY(-2px); }

.hc-cxcard--dashed {
  align-items: center;
  justify-content: center;
  flex-direction: row;
  gap: 6px;
  border-style: dashed;
  color: var(--hc-text-muted);
  min-height: 88px;
  cursor: pointer;
  background: transparent;
  font-size: 12.5px;
  box-shadow: none;
}
.hc-cxcard--dashed:hover {
  transform: none;
  box-shadow: none;
  border-color: var(--hc-accent);
  color: var(--hc-text-secondary);
}

.hc-cxtop {
  display: flex;
  align-items: center;
  gap: 12px;
}
.hc-cxlogo {
  width: 38px;
  height: 38px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  background: var(--hc-bg-input);
  color: var(--hc-text-secondary);
}
.hc-cxlogo--accent {
  background: var(--hc-accent);
  color: #fff;
}
/* 品牌吉祥物头像（对齐原型 hero：图片填满 38×38、无内边距） */
.hc-cxlogo--brand {
  overflow: hidden;
  padding: 0;
  background: #fff;
}
.hc-cxlogo--brand img {
  width: 38px;
  height: 38px;
  object-fit: cover;
}
.hc-cxnm {
  font-weight: 600;
  font-size: 14px;
  color: var(--hc-text-primary);
}
.hc-cxmeta {
  font-size: 12px;
  color: var(--hc-text-secondary);
  margin-top: 1px;
}

.hc-crow {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

/* 人设（SOUL）摘要：两行截断 */
.hc-soul {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.hc-soul__label {
  font-size: 11px;
  font-weight: 500;
  color: var(--hc-text-muted);
}
.hc-soul__text {
  font-size: 12px;
  line-height: 1.5;
  color: var(--hc-text-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* 标签 / 状态徽标 */
.hc-tag {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 6px;
  background: var(--hc-bg-active);
  color: var(--hc-text-secondary);
}
.hc-tag--accent {
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
}
.hc-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  padding: 3px 9px;
  border-radius: 7px;
}
.hc-pill::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 50%;
}
.hc-pill--green {
  background: var(--hc-accent-subtle);
  color: var(--hc-success);
}
.hc-pill--green::before { background: var(--hc-success); }

/* 卡内 hc-btn 采用原型 .btn 中性外观（非主操作） */
.hc-cxcard .hc-btn:not(.hc-btn-primary):not(.hc-btn-ghost),
.hc-cxcard--hero .hc-btn:not(.hc-btn-primary):not(.hc-btn-ghost) {
  padding: 8px 14px;
  font-size: 13px;
  border: 0.5px solid var(--hc-border);
  background: var(--hc-bg-input);
  color: var(--hc-text-primary);
}
.hc-cxcard .hc-btn:not(.hc-btn-primary):not(.hc-btn-ghost):hover,
.hc-cxcard--hero .hc-btn:not(.hc-btn-primary):not(.hc-btn-ghost):hover {
  background: var(--hc-bg-hover);
}
.hc-cxcard .hc-btn-primary,
.hc-cxcard--hero .hc-btn-primary {
  padding: 8px 14px;
}
.hc-btn--danger { color: var(--hc-error); }

/* 模板库卡片：button 复用 cxcard 外观，补 button 重置 + 指针 */
button.hc-cxcard {
  width: 100%;
  font: inherit;
  cursor: pointer;
}
.hc-tpl-empty {
  padding: 40px 0;
  text-align: center;
  font-size: 13px;
  color: var(--hc-text-muted);
}

@media (max-width: 720px) {
  .hc-cxcards { grid-template-columns: 1fr; }
}

/* ── 新建弹窗第一步「选择起点」卡片网格 ── */
.hc-startgrid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.hc-startcard {
  display: flex;
  flex-direction: column;
  gap: 4px;
  text-align: left;
  padding: 14px;
  border-radius: 12px;
  border: 0.5px solid var(--hc-border);
  background: var(--hc-bg-card);
  cursor: pointer;
  transition: border-color 0.15s ease-out, transform 0.12s ease-out, box-shadow 0.2s ease-out;
}
.hc-startcard:hover {
  border-color: var(--hc-accent);
  box-shadow: var(--hc-shadow-sm);
  transform: translateY(-1px);
}
.hc-startcard__icon {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  background: var(--hc-bg-input);
  color: var(--hc-text-secondary);
  margin-bottom: 2px;
}
.hc-startcard__nm {
  font-weight: 600;
  font-size: 13px;
  color: var(--hc-text-primary);
}
.hc-startcard__meta {
  font-size: 11.5px;
  color: var(--hc-text-secondary);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* 第二步「此模板擅长」只读专长 chips */
.hc-tplexp {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--hc-accent-subtle, rgba(95, 179, 234, 0.14));
  border: 0.5px solid var(--hc-border-hl, rgba(95, 179, 234, 0.24));
}
.hc-tplexp__label {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--hc-text-secondary);
}
.hc-tplexp__chip {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  color: var(--hc-accent);
  background: var(--hc-bg-elevated, rgba(255, 255, 255, 0.06));
  border: 0.5px solid var(--hc-border);
}

.modal-enter-active { transition: opacity 0.2s ease-out; }
.modal-leave-active { transition: opacity 0.15s ease-in; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
</style>
