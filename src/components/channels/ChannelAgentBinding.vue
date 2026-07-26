<script setup lang="ts">
/**
 * ChannelAgentBinding —「通道 → 接待智能体」绑定控件（活页面入口）。
 *
 * 评审定论（[[project_im_binding_centralize_orphan_20260628]]）：**纯接待模型**——渠道只绑一个
 * 智能体（Agent），模型 100% 跟随接待者、渠道层只读、不另设模型。要给渠道特定模型 → 绑一个钉了
 * 该模型的 Agent（含「＋新建 Agent」）。本组件挂进活的 ConnectionChannelCards 卡片 = 真正可达入口。
 *
 * 单一可见性边界：列给用户选的 Agent 一律经 userVisibleAgents() 过滤匿名 @im/*（AP-108 根治）。
 * 历史遗留 @im/* 一次性回收：纯接待模型不再创建 @im/*，但旧版可能残留 → 挂载时兜底注销无规则
 * 引用者，失败 warn 不静默（AP-110）。
 */
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { Plus, Pencil } from 'lucide-vue-next'
import {
  getAgents,
  getRules,
  getRoles,
  registerAgent,
  unregisterAgent,
  addRule,
  deleteRule,
} from '@/api/agents'
import type { AgentConfig, AgentRole, AgentRule } from '@/types'
import type { IMInstance } from '@/api/im-channels'
import {
  isChannelDefaultAgent,
  resolveEffectiveModel,
  userVisibleAgents,
} from '@/utils/imChannelBinding'
import { useSettingsStore } from '@/stores/settings'
import SearchInput from '@/components/common/SearchInput.vue'

const props = defineProps<{ instance: IMInstance }>()
const emit = defineEmits<{ changed: [] }>()

const { t } = useI18n()
const router = useRouter()
// 防御：本控件被多处 mount（每张渠道卡一份）。缺 pinia 的隔离父测试 / store 未就绪时不应令其崩溃
// 而带垮整张卡（生产恒有 pinia/router）。store 取不到 → 退化为空模型列表 + 全局默认空，不抛。
let settingsStore: ReturnType<typeof useSettingsStore> | null = null
try { settingsStore = useSettingsStore() } catch { settingsStore = null }
const availableModels = computed(() => settingsStore?.availableModels ?? [])

// AP-110：同名匿名 Agent 一次会话只回收一次，避免多张卡并发回收同一孤儿时重复 unregister + 误报。
const reclaimedNames = new Set<string>()

const agentsList = ref<AgentConfig[]>([])
const rolesList = ref<AgentRole[]>([])
const routingRules = ref<AgentRule[]>([])
const errorMsg = ref('')

/** 可选 Agent：注册 Agent（经单一边界剔除匿名 @im/*）+ 未注册角色。 */
const agentOptions = computed<AgentConfig[]>(() => {
  const visible = userVisibleAgents(agentsList.value)
  const registered = new Set(visible.map((a) => a.name))
  const fromRoles: AgentConfig[] = rolesList.value
    .filter((r) => !registered.has(r.name))
    .map((r) => ({ name: r.name, display_name: r.title || r.name, model: '', provider: '' }))
  return [...visible, ...fromRoles]
})

async function loadAgentData() {
  try {
    const [agentsRes, rulesRes, rolesRes] = await Promise.all([getAgents(), getRules(), getRoles()])
    agentsList.value = agentsRes.agents || []
    routingRules.value = rulesRes.rules || []
    rolesList.value = rolesRes.roles || []
  } catch { /* non-critical */ }
}

/** AP-110 历史遗留回收：注销「无任何路由规则引用」的孤儿匿名 @im/* Agent（旧版渠道默认模型残留）；失败 warn 不静默。 */
async function reclaimOrphanChannelAgents() {
  const referenced = new Set(routingRules.value.map((r) => r.agent_name))
  const orphans = agentsList.value.filter(
    (a) => isChannelDefaultAgent(a.name) && !referenced.has(a.name) && !reclaimedNames.has(a.name),
  )
  for (const o of orphans) {
    reclaimedNames.add(o.name)
    try {
      await unregisterAgent(o.name)
    } catch (e) {
      console.warn(`[ChannelAgentBinding] 回收孤儿频道默认 Agent ${o.name} 失败`, e)
    }
  }
}

/**
 * 绑定粒度=instance 级（BUG-20260703 D1）：本实例的 instance 级规则优先，遗留
 * platform 级规则（instance_id=''，旧版恒写空串）兜底显示/生效——运行时 router 对
 * instance 级匹配得分（35）也高于 platform 级（10），两端解析顺序一致。
 */
function instanceScopedRule(): AgentRule | undefined {
  return routingRules.value.find(
    (r) => r.platform === props.instance.type && r.instance_id === props.instance.name
      && !r.user_id && !r.chat_id,
  )
}

function legacyPlatformRule(): AgentRule | undefined {
  return routingRules.value.find(
    (r) => r.platform === props.instance.type && !r.instance_id && !r.user_id && !r.chat_id,
  )
}

function getBoundAgent(): AgentConfig | undefined {
  const rule = instanceScopedRule() ?? legacyPlatformRule()
  if (!rule) return undefined
  return agentsList.value.find((a) => a.name === rule.agent_name)
}

const globalDefaultModel = computed(() => settingsStore?.config?.llm?.defaultModel ?? '')

function modelDisplayName(modelId: string): string {
  if (!modelId) return ''
  const hit = availableModels.value.find((m) => m.modelId === modelId)
  return hit?.modelName || modelId
}

function effectiveModel() {
  return resolveEffectiveModel(getBoundAgent(), globalDefaultModel.value)
}

function effectiveModelSourceLabel(): string {
  const eff = effectiveModel()
  if (eff.source === 'agent') return t('imChannels.modelSourceAgent', { name: eff.agentLabel ?? '' })
  // 绑了命名 Agent 但它没钉模型 → 保留 Agent 关联 + 明示跟随全局（不裸显「全局默认」）。
  if (eff.agentLabel) return `${eff.agentLabel} · ${t('imChannels.followGlobal', '跟随全局默认')}`
  // BUG-20260704 默认助理接待同理保留接待者身份（原型 app.html:1620「小蟹 · 跟随全局默认」）。
  return `${t('chat.botName', '小蟹')} · ${t('imChannels.followGlobal', '跟随全局默认')}`
}

/**
 * 切本实例的 instance 级路由规则到 agentName（空=解绑回默认助理）。先增后删避免无规则
 * 空窗；旧的 instance 级规则与遗留 platform 级规则一并清（重选即完成 platform→instance
 * 迁移）+ 回收旧匿名 Agent。
 *
 * BUG-20260703 D2：目标已是本实例的 instance 级绑定且无遗留可迁移 → 无操作短路。
 * 此前先 addRule（upsert 命中同一行，id 不变）再 deleteRule(existing.id)，等于把刚写的
 * 绑定自己删掉——重选已绑 Agent 反而解绑。
 */
async function applyInstanceRule(agentName: string) {
  const scoped = instanceScopedRule()
  const legacy = legacyPlatformRule()
  if (agentName && scoped?.agent_name === agentName && !legacy) return
  if (!agentName && !scoped && !legacy) return
  if (agentName) {
    await addRule({ platform: props.instance.type, agent_name: agentName, instance_id: props.instance.name, user_id: '', chat_id: '', priority: 0 })
  }
  for (const existing of [scoped, legacy]) {
    if (!existing) continue
    // upsert 与新绑定同一行（platform+instance_id+agent 相同唯一键）→ 跳过，防自抵消。
    if (agentName && existing.instance_id === props.instance.name && existing.agent_name === agentName) continue
    await deleteRule(existing.id)
    // 切走后旧的匿名「频道默认」Agent（历史遗留）不再被任何规则引用 → 注销，免堆积孤儿。
    if (isChannelDefaultAgent(existing.agent_name) && existing.agent_name !== agentName) {
      const stillReferenced = routingRules.value.some(
        (r) => r.id !== existing.id && r.agent_name === existing.agent_name,
      )
      if (!stillReferenced) {
        try {
          await unregisterAgent(existing.agent_name)
        } catch (e) {
          // 不静默吞错（AP-110）：清理失败仅 warn；遗留孤儿由 reclaimOrphanChannelAgents 兜底。
          console.warn(`[ChannelAgentBinding] 清理孤儿频道默认 Agent ${existing.agent_name} 失败`, e)
        }
      }
    }
  }
}

async function bindAgentToInstance(agentName: string) {
  try {
    if (agentName) {
      const isRegistered = agentsList.value.some((a) => a.name === agentName)
      if (!isRegistered) {
        const role = rolesList.value.find((r) => r.name === agentName)
        await registerAgent({
          name: agentName,
          display_name: role?.title || agentName,
          model: '',
          provider: '',
          system_prompt: role?.goal || '',
        } as AgentConfig)
      }
    }
    await applyInstanceRule(agentName)
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('imChannels.bindFailed', '绑定 Agent 失败')
  }
  await loadAgentData()
  emit('changed')
}

// ─── Agent 下拉（可搜索）─────────────────────────
const dropdownOpen = ref(false)
const dropdownFlip = ref(false)
const searchQuery = ref('')
const searchInputRef = ref<InstanceType<typeof SearchInput> | null>(null)
const rootRef = ref<HTMLElement | null>(null)

const filteredAgentOptions = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return agentOptions.value
  return agentOptions.value.filter(
    (a) => a.name.toLowerCase().includes(q) || (a.display_name ?? '').toLowerCase().includes(q),
  )
})

function toggleDropdown(event?: MouseEvent) {
  if (dropdownOpen.value) {
    dropdownOpen.value = false
    searchQuery.value = ''
  } else {
    dropdownOpen.value = true
    searchQuery.value = ''
    const trigger = event?.currentTarget as HTMLElement | undefined
    if (trigger) {
      const rect = trigger.getBoundingClientRect()
      dropdownFlip.value = window.innerHeight - rect.bottom < 220
    } else {
      dropdownFlip.value = false
    }
    nextTick(() => searchInputRef.value?.focus())
  }
}

function closeDropdown() {
  dropdownOpen.value = false
  searchQuery.value = ''
}

async function selectAgent(agentName: string) {
  closeDropdown()
  await bindAgentToInstance(agentName)
}

function navigateToEditAgent(agentName: string) {
  router?.push({ path: '/agents', query: { tab: 'agents', edit: agentName } })
}

function createNewAgent() {
  closeDropdown()
  router?.push({ path: '/agents', query: { tab: 'agents', create: '1' } })
}

// 派生显示：绑定的命名 Agent（匿名 @im/* 视为「无命名绑定」=默认助理接待）。
const boundNamedAgent = computed(() => {
  const b = getBoundAgent()
  return b && !isChannelDefaultAgent(b.name) ? b : undefined
})

function handleClickOutside(e: MouseEvent) {
  if (!dropdownOpen.value) return
  if (rootRef.value && rootRef.value.contains(e.target as Node)) return
  closeDropdown()
}

onMounted(() => {
  void loadAgentData().then(reclaimOrphanChannelAgents)
  document.addEventListener('mousedown', handleClickOutside, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', handleClickOutside, true)
})
</script>

<template>
  <div ref="rootRef" class="hc-cab">
    <!-- 接待智能体（唯一控件）：渠道绑 Agent = 人设+模型+工具一包；模型是 Agent 属性、渠道层只读 -->
    <div class="hc-cab__row">
      <span class="hc-cab__label">{{ t('imChannels.bindAgentLabel', '智能体') }}</span>
      <div class="hc-agent-combo" @click.stop>
        <button
          class="hc-agent-combo__trigger hc-input"
          data-governed-select="agent-binding"
          role="combobox"
          aria-haspopup="listbox"
          :aria-expanded="dropdownOpen"
          @click="toggleDropdown($event)"
        >
          <span class="hc-agent-combo__value">
            {{ boundNamedAgent
              ? (boundNamedAgent.display_name || boundNamedAgent.name)
              : t('agents.defaultAssistantName') }}
          </span>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="flex-shrink:0;opacity:.5"><path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <Transition name="dropdown">
          <div v-if="dropdownOpen" class="hc-agent-combo__dropdown" :class="{ 'hc-agent-combo__dropdown--flip': dropdownFlip }">
            <div class="hc-agent-combo__search">
              <SearchInput
                ref="searchInputRef"
                v-model="searchQuery"
                fluid
                class="hc-agent-combo__search-control"
                :placeholder="t('common.search', 'Search...')"
                @keydown="$event.key === 'Escape' && closeDropdown()"
              />
            </div>
            <div class="hc-agent-combo__list" role="listbox">
              <button
                class="hc-agent-combo__option"
                :class="{ 'hc-agent-combo__option--active': !boundNamedAgent }"
                role="option"
                :aria-selected="!boundNamedAgent"
                @click="selectAgent('')"
              >
                {{ t('agents.defaultAssistantName') }}
              </button>
              <div v-if="filteredAgentOptions.length" class="hc-agent-combo__group">
                {{ t('imChannels.agentGroup', 'Agent') }}
              </div>
              <button
                v-for="a in filteredAgentOptions"
                :key="a.name"
                class="hc-agent-combo__option"
                :class="{ 'hc-agent-combo__option--active': boundNamedAgent?.name === a.name }"
                role="option"
                :aria-selected="boundNamedAgent?.name === a.name"
                @click="selectAgent(a.name)"
              >
                {{ a.display_name || a.name }}
                <span v-if="a.model" class="hc-agent-combo__model">{{ a.model }}</span>
              </button>
              <button class="hc-agent-combo__option hc-agent-combo__option--new" @click="createNewAgent()">
                <Plus :size="12" />
                {{ t('imChannels.newAgentInline', '＋ 新建 Agent…') }}
              </button>
              <div v-if="filteredAgentOptions.length === 0 && searchQuery" class="hc-agent-combo__empty">
                {{ t('common.noResults', 'No results') }}
              </div>
            </div>
          </div>
        </Transition>
      </div>
      <button
        v-if="boundNamedAgent"
        class="hc-cab__edit"
        :title="t('common.edit')"
        @click="navigateToEditAgent(boundNamedAgent.name)"
      >
        <Pencil :size="12" />
      </button>
    </div>

    <!-- 派生模型（只读）：模型 100% 跟随接待者，渠道层不可设；技术 token 用 <bdi> 隔离（RTL 维语不被重排）-->
    <div class="hc-cab__effmodel">
      <span class="hc-cab__effmodel-label">{{ t('imChannels.modelLabel', '模型') }}</span>
      <span class="hc-cab__effmodel-badge" :class="`hc-cab__effmodel-badge--${effectiveModel().source}`">
        <bdi>{{ effectiveModel().modelId
          ? modelDisplayName(effectiveModel().modelId)
          : t('imChannels.noDefaultModel', '未配置默认模型') }}</bdi>
      </span>
      <span class="hc-cab__effmodel-source">{{ effectiveModelSourceLabel() }}</span>
    </div>

    <!-- 绑定失败提示：catch 写入 errorMsg 后 surface 给用户（不静默吞错，对齐 audit-silent-failure 纪律）。 -->
    <div v-if="errorMsg" class="hc-cab__error" role="alert">{{ errorMsg }}</div>
  </div>
</template>

<style scoped>
.hc-cab { display: flex; flex-direction: column; gap: 8px; margin: 4px 0; }
.hc-cab__row { display: flex; align-items: center; gap: 8px; }
.hc-cab__label { font-size: 12px; color: var(--hc-text-muted); flex-shrink: 0; min-width: 32px; }
.hc-agent-combo { position: relative; flex: 1; min-width: 0; }
.hc-agent-combo__trigger {
  display: flex; align-items: center; justify-content: space-between; gap: 6px;
  width: 100%; padding: 5px 9px; font-size: 13px; cursor: pointer; text-align: start;
}
.hc-agent-combo__value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hc-agent-combo__dropdown {
  position: absolute; inset-inline-start: 0; inset-inline-end: 0; top: calc(100% + 4px); z-index: 40;
  background: var(--hc-bg-elevated); border: 1px solid var(--hc-border);
  border-radius: 10px; box-shadow: var(--hc-shadow-lg, 0 8px 24px rgba(0,0,0,.18));
  max-height: 240px; overflow: auto; padding: 4px;
}
.hc-agent-combo__dropdown--flip { top: auto; bottom: calc(100% + 4px); }
.hc-agent-combo__search { padding: 4px 8px; }
.hc-agent-combo__list { display: flex; flex-direction: column; }
.hc-agent-combo__group { padding: 6px 10px 2px; font-size: 11px; color: var(--hc-text-muted); text-transform: uppercase; letter-spacing: .04em; }
.hc-agent-combo__option {
  display: flex; align-items: center; gap: 6px; justify-content: space-between;
  padding: 7px 10px; font-size: 13px; cursor: pointer; border-radius: 7px; text-align: start; width: 100%;
}
.hc-agent-combo__option:hover { background: var(--hc-bg-hover, rgba(127,127,127,.1)); }
.hc-agent-combo__option--active { background: var(--hc-accent-soft, rgba(99,102,241,.12)); font-weight: 600; }
.hc-agent-combo__option--new { color: var(--hc-accent, #6366f1); }
.hc-agent-combo__model { font-size: 11px; color: var(--hc-text-muted); }
.hc-agent-combo__empty { padding: 8px 10px; font-size: 12px; color: var(--hc-text-muted); }
.hc-cab__edit {
  flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; border: 1px solid var(--hc-border); border-radius: 7px;
  background: transparent; cursor: pointer; color: var(--hc-text-muted);
}
.hc-cab__edit:hover { color: var(--hc-text); }
.hc-cab__effmodel { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.hc-cab__effmodel-label { font-size: 12px; color: var(--hc-text-muted); min-width: 32px; }
.hc-cab__effmodel-badge {
  font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 999px;
  background: var(--hc-bg-card); border: 1px solid var(--hc-border);
}
/* 技术 token 强制 LTR 隔离：RTL（维语）下模型 ID 不被重排（与旧实现一致铁律）。 */
.hc-cab__effmodel-badge > bdi { unicode-bidi: isolate; direction: ltr; }
.hc-cab__effmodel-badge--agent { color: var(--hc-accent, #6366f1); }
.hc-cab__effmodel-badge--global { color: var(--hc-text-muted); }
.hc-cab__effmodel-source { font-size: 11px; color: var(--hc-text-muted); }
.hc-cab__error { font-size: 12px; color: var(--hc-error); margin-top: 2px; }
</style>
