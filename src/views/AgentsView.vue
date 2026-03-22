<script setup lang="ts">
import { onMounted, ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Bot, MessageSquare, Plus, Trash2, X, Users, Pencil, ChevronDown, ChevronUp, Wrench, ShieldAlert } from 'lucide-vue-next'
import { useAgentsStore } from '@/stores/agents'
import { useSettingsStore } from '@/stores/settings'
import { getAgents, getRules, addRule, deleteRule, setDefaultAgent, registerAgent, unregisterAgent, updateAgent } from '@/api/agents'
import type { AgentRole, AgentConfig, AgentRule } from '@/types'
import PageHeader from '@/components/common/PageHeader.vue'
import PageToolbar from '@/components/common/PageToolbar.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import AgentConference from '@/components/agent/AgentConference.vue'

const { t } = useI18n()
const router = useRouter()
const agentsStore = useAgentsStore()
const settingsStore = useSettingsStore()

const searchQuery = ref('')
const activeTab = ref<'roles' | 'agents' | 'rules' | 'conference'>('roles')
const errorMsg = ref('')

const agentSegments = computed(() => [
  { key: 'roles', label: t('agents.roles', 'Templates') },
  { key: 'agents', label: t('agents.registeredAgents', 'Running') },
  { key: 'rules', label: t('agents.rulesDesc', 'Rules') },
  { key: 'conference', label: t('agents.conferenceTab') },
])

// Role detail expansion
const expandedRole = ref<string | null>(null)

// Agent 路由
const agents = ref<AgentConfig[]>([])
const defaultAgent = ref('')
const agentsLoading = ref(false)
const showAddAgent = ref(false)
const newAgent = ref<AgentConfig>({ name: '', display_name: '', model: '', provider: '' })

// Edit agent modal
const showEditAgent = ref(false)
const editingAgent = ref<AgentConfig>({ name: '', display_name: '', model: '', provider: '' })

// 注销确认
const showUnregisterConfirm = ref(false)
const unregisteringName = ref('')

// 路由规则
const rules = ref<AgentRule[]>([])
const rulesLoading = ref(false)
const ruleSaving = ref(false)
const showAddRule = ref(false)
const newRule = ref<Omit<AgentRule, 'id'>>({
  platform: 'api',
  instance_id: '',
  user_id: '',
  chat_id: '',
  agent_name: '',
  priority: 0,
})
const deletingRuleId = ref<number | null>(null)

const PLATFORM_OPTIONS = ['api', 'feishu', 'dingtalk', 'telegram', 'discord']

const sortedRules = computed(() =>
  [...rules.value].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)),
)

const canAddRule = computed(() => agents.value.length > 0)

onMounted(async () => {
  await Promise.all([agentsStore.loadRoles(), loadAgents(), loadRules(), settingsStore.loadConfig()])
})

async function loadAgents() {
  agentsLoading.value = true
  errorMsg.value = ''
  try {
    const res = await getAgents()
    agents.value = res.agents || []
    defaultAgent.value = res.default || ''
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('agents.loadAgentsFailed')
    console.error('加载 Agents 失败:', e)
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
    console.error('加载路由规则失败:', e)
  } finally {
    rulesLoading.value = false
  }
}

async function handleSetDefault(name: string) {
  errorMsg.value = ''
  try {
    await setDefaultAgent(name)
    defaultAgent.value = name
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('agents.setDefaultFailed')
  }
}

async function handleAddRule() {
  if (!newRule.value.agent_name.trim()) return
  ruleSaving.value = true
  errorMsg.value = ''
  try {
    await addRule(newRule.value)
    showAddRule.value = false
    newRule.value = { platform: 'api', instance_id: '', user_id: '', chat_id: '', agent_name: '', priority: 0 }
    await loadRules()
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('agents.loadRulesFailed')
  } finally {
    ruleSaving.value = false
  }
}

async function handleDeleteRule(id: number) {
  errorMsg.value = ''
  try {
    await deleteRule(id)
    rules.value = rules.value.filter((r) => r.id !== id)
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('agents.loadRulesFailed')
  } finally {
    deletingRuleId.value = null
  }
}

function ruleSummary(rule: AgentRule): string {
  const parts: string[] = []
  if (rule.platform) parts.push(rule.platform)
  if (rule.instance_id) parts.push(rule.instance_id)
  if (rule.user_id) parts.push(`user:${rule.user_id}`)
  if (rule.chat_id) parts.push(`chat:${rule.chat_id}`)
  return parts.join(' · ') || '—'
}

function handleChat(role: AgentRole) {
  router.push({ path: '/chat', query: { role: role.name, roleTitle: role.title || role.name } })
}

function toggleRoleDetail(roleName: string) {
  expandedRole.value = expandedRole.value === roleName ? null : roleName
}

function openEditAgent(agent: AgentConfig) {
  editingAgent.value = { ...agent }
  syncAgentModelSelection(editingAgent.value)
  showEditAgent.value = true
}

async function handleEditAgent() {
  if (!editFormValid.value) return
  errorMsg.value = ''
  try {
    await updateAgent(editingAgent.value.name, {
      display_name: editingAgent.value.display_name,
      provider: editingAgent.value.provider,
      model: editingAgent.value.model,
    })
    showEditAgent.value = false
    await loadAgents()
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('agents.editAgentFailed')
    console.error('编辑 Agent 失败:', e)
  }
}

const filteredRoles = computed(() => {
  if (!searchQuery.value) return agentsStore.roles
  const q = searchQuery.value.toLowerCase()
  return agentsStore.roles.filter(
    (r) => r.name.toLowerCase().includes(q) || r.title.toLowerCase().includes(q) || r.goal.toLowerCase().includes(q),
  )
})

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

const runtimeProviderOptions = computed(() =>
  settingsStore.enabledProviders.map((provider) => ({
    key: provider.backendKey || provider.name || provider.id,
    label: provider.name,
    models: provider.models,
  })),
)

function modelsForProvider(providerKey: string) {
  return runtimeProviderOptions.value.find((provider) => provider.key === providerKey)?.models ?? []
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

watch(() => newAgent.value.provider, () => {
  syncAgentModelSelection(newAgent.value)
})

watch(() => editingAgent.value.provider, () => {
  syncAgentModelSelection(editingAgent.value)
})

const registerFormValid = computed(() => {
  const models = modelsForProvider(newAgent.value.provider)
  return (
    newAgent.value.name.trim() !== '' &&
    newAgent.value.provider.trim() !== '' &&
    newAgent.value.model.trim() !== '' &&
    models.some((model) => model.id === newAgent.value.model)
  )
})

const editFormValid = computed(() => {
  const models = modelsForProvider(editingAgent.value.provider)
  return (
    editingAgent.value.name.trim() !== '' &&
    editingAgent.value.provider.trim() !== '' &&
    editingAgent.value.model.trim() !== '' &&
    models.some((model) => model.id === editingAgent.value.model)
  )
})

async function handleRegisterAgent() {
  if (!registerFormValid.value) return
  errorMsg.value = ''
  try {
    await registerAgent(newAgent.value)
    showAddAgent.value = false
    newAgent.value = { name: '', display_name: '', model: '', provider: '' }
    await loadAgents()
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('agents.registerAgentFailed')
    console.error('注册 Agent 失败:', e)
  }
}

function confirmUnregister(name: string) {
  unregisteringName.value = name
  showUnregisterConfirm.value = true
}

async function handleUnregisterAgent() {
  if (!unregisteringName.value) return
  errorMsg.value = ''
  try {
    await unregisterAgent(unregisteringName.value)
    agents.value = agents.value.filter((a) => a.name !== unregisteringName.value)
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('agents.unregisterAgentFailed')
    console.error('注销 Agent 失败:', e)
  } finally {
    showUnregisterConfirm.value = false
    unregisteringName.value = ''
  }
}
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <PageToolbar :search-placeholder="t('agents.searchPlaceholder')" @search="v => searchQuery = v">
      <template #tabs>
        <SegmentedControl v-model="activeTab" :segments="agentSegments" />
      </template>
      <template #actions>
        <button
          v-if="activeTab === 'agents'"
          class="hc-btn hc-btn-primary"
          @click="showAddAgent = true"
        >
          <Plus :size="14" />
          {{ t('agents.registerAgent') }}
        </button>
      </template>
    </PageToolbar>

    <PageHeader
      :eyebrow="t('agents.eyebrow', 'agents')"
      :title="t('agents.title')"
      :description="t('agents.description')"
    />

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
      <!-- 角色列表 (只读) -->
      <template v-if="activeTab === 'roles'">
        <LoadingState v-if="agentsStore.loading" />

        <EmptyState
          v-else-if="agentsStore.roles.length === 0"
          :icon="Bot"
          :title="t('agents.noAgents')"
          :description="t('agents.noAgentsDesc')"
        />

        <div v-else class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <div
            v-for="role in filteredRoles"
            :key="role.name"
            class="rounded-xl border p-4 transition-colors"
            :style="{
              background: 'var(--hc-bg-card)',
              borderColor: expandedRole === role.name ? 'var(--hc-accent)' : 'var(--hc-border)',
            }"
          >
            <div class="flex items-center gap-3 mb-3 cursor-pointer" @click="toggleRoleDetail(role.name)">
              <div
                class="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
                :style="{ background: 'var(--hc-accent)', color: '#fff' }"
              >
                <Bot :size="18" />
              </div>
              <div class="min-w-0 flex-1">
                <div class="text-sm font-semibold truncate" :style="{ color: 'var(--hc-text-primary)' }">
                  {{ role.title || role.name }}
                </div>
                <div class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">{{ role.name }}</div>
              </div>
              <component
                :is="expandedRole === role.name ? ChevronUp : ChevronDown"
                :size="16"
                :style="{ color: 'var(--hc-text-muted)', flexShrink: 0 }"
              />
            </div>
            <p class="text-xs leading-relaxed line-clamp-2" :style="{ color: 'var(--hc-text-secondary)' }">
              {{ role.goal || t('agents.noDesc') }}
            </p>

            <!-- Expanded detail view -->
            <div v-if="expandedRole === role.name" class="mt-3 pt-3 border-t flex flex-col gap-2.5" :style="{ borderColor: 'var(--hc-border)' }">
              <div v-if="role.backstory">
                <div class="text-[11px] font-medium mb-1" :style="{ color: 'var(--hc-text-muted)' }">{{ t('agents.backstory') }}</div>
                <p class="text-xs leading-relaxed" :style="{ color: 'var(--hc-text-secondary)' }">{{ role.backstory }}</p>
              </div>
              <div v-if="role.expertise?.length">
                <div class="text-[11px] font-medium mb-1" :style="{ color: 'var(--hc-text-muted)' }">{{ t('agents.expertise') }}</div>
                <div class="flex flex-wrap gap-1">
                  <span
                    v-for="area in role.expertise"
                    :key="area"
                    class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px]"
                    :style="{ background: 'var(--hc-accent-subtle, rgba(99,102,241,0.1))', color: 'var(--hc-accent)' }"
                  >
                    <Wrench :size="10" />
                    {{ area }}
                  </span>
                </div>
              </div>
              <div v-if="role.tools?.length">
                <div class="text-[11px] font-medium mb-1" :style="{ color: 'var(--hc-text-muted)' }">{{ t('agents.tools') }}</div>
                <div class="flex flex-wrap gap-1">
                  <span
                    v-for="tool in role.tools"
                    :key="tool"
                    class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px]"
                    :style="{ background: 'var(--hc-accent-subtle, rgba(99,102,241,0.1))', color: 'var(--hc-accent)' }"
                  >
                    <Wrench :size="10" />
                    {{ tool }}
                  </span>
                </div>
              </div>
              <div v-if="role.constraints?.length">
                <div class="text-[11px] font-medium mb-1" :style="{ color: 'var(--hc-text-muted)' }">{{ t('agents.constraints') }}</div>
                <ul class="list-none m-0 p-0 flex flex-col gap-1">
                  <li
                    v-for="(c, ci) in role.constraints"
                    :key="ci"
                    class="flex items-start gap-1 text-[11px]"
                    :style="{ color: 'var(--hc-text-secondary)' }"
                  >
                    <ShieldAlert :size="11" class="mt-0.5 flex-shrink-0" :style="{ color: 'var(--hc-warning, #f0b429)' }" />
                    {{ c }}
                  </li>
                </ul>
              </div>
              <div v-if="!role.backstory && !role.expertise?.length && !role.tools?.length && !role.constraints?.length">
                <p class="text-[11px]" :style="{ color: 'var(--hc-text-muted)' }">{{ t('agents.noMoreDetail') }}</p>
              </div>
            </div>

            <div class="flex items-center gap-2 mt-3">
              <button
                class="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium"
                :style="{ background: 'var(--hc-accent)', color: '#fff' }"
                @click.stop="handleChat(role)"
              >
                <MessageSquare :size="12" />
                {{ t('agents.chat') }}
              </button>
            </div>
          </div>
        </div>
      </template>

      <!-- 注册的 Agent -->
      <template v-else-if="activeTab === 'agents'">
        <LoadingState v-if="agentsLoading" />

        <template v-else>
          <div class="flex items-center justify-between mb-4 max-w-2xl">
            <div class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">
              <span v-if="defaultAgent">{{ t('agents.defaultAgent') }}: <strong>{{ defaultAgent }}</strong></span>
            </div>
            <button
              class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium text-white"
              :style="{ background: 'var(--hc-accent)' }"
              @click="showAddAgent = true"
            >
              <Plus :size="14" />
              {{ t('agents.registerAgent') }}
            </button>
          </div>

          <EmptyState
            v-if="filteredAgents.length === 0 && agents.length === 0"
            :icon="Users"
            :title="t('agents.noAgentsRouting')"
            :description="t('agents.noAgentsRoutingDesc')"
          />

          <div v-else class="space-y-3 max-w-2xl">
            <div
              v-for="agent in filteredAgents"
              :key="agent.name"
              class="flex items-center gap-4 rounded-xl border p-4"
              :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
            >
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                  <span class="text-sm font-medium" :style="{ color: 'var(--hc-text-primary)' }">
                    {{ agent.display_name || agent.name }}
                  </span>
                  <span
                    v-if="agent.name === defaultAgent"
                    class="px-1.5 py-0.5 rounded text-[10px] font-medium"
                    :style="{ background: 'var(--hc-accent)', color: '#fff' }"
                  >
                    {{ t('agents.default') }}
                  </span>
                </div>
                <div class="flex items-center gap-3 mt-1 text-xs" :style="{ color: 'var(--hc-text-muted)' }">
                  <span>{{ agent.provider }}</span>
                  <span>{{ agent.model }}</span>
                </div>
              </div>
              <button
                v-if="agent.name !== defaultAgent"
                class="p-1.5 rounded-md hover:bg-white/5 transition-colors text-xs"
                :style="{ color: 'var(--hc-text-secondary)' }"
                :title="t('agents.setDefault')"
                @click="handleSetDefault(agent.name)"
              >
                {{ t('agents.setDefault') }}
              </button>
              <button
                class="p-1.5 rounded-md hover:bg-white/5 transition-colors"
                :style="{ color: 'var(--hc-text-secondary)' }"
                :title="t('common.edit')"
                @click="openEditAgent(agent)"
              >
                <Pencil :size="15" />
              </button>
              <button
                class="p-1.5 rounded-md hover:bg-white/5 transition-colors"
                :style="{ color: 'var(--hc-error)' }"
                :title="t('agents.unregister')"
                @click="confirmUnregister(agent.name)"
              >
                <Trash2 :size="16" />
              </button>
            </div>
          </div>
        </template>
      </template>

      <AgentConference
        v-else-if="activeTab === 'conference'"
        :agents="agentsStore.roles.map(r => ({ id: r.name, name: r.name, goal: r.goal?.slice(0, 80) || '' }))"
        @close="activeTab = 'roles'"
      />

      <!-- 路由规则 -->
      <template v-else-if="activeTab === 'rules'">
        <LoadingState v-if="rulesLoading" />
        <EmptyState
          v-else-if="rules.length === 0"
          :icon="Users"
          :title="t('agents.noRules')"
          :description="canAddRule ? t('agents.noRulesDesc') : t('agents.registerAgentFirst')"
        >
          <button
            v-if="canAddRule"
            class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium text-white"
            :style="{ background: 'var(--hc-accent)' }"
            @click="showAddRule = true"
          >
            <Plus :size="14" />
            {{ t('agents.addRule') }}
          </button>
        </EmptyState>
        <template v-else>
          <div class="flex justify-end mb-4 max-w-2xl">
            <button
              class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium text-white disabled:opacity-50 disabled:cursor-not-allowed"
              :style="{ background: canAddRule ? 'var(--hc-accent)' : 'var(--hc-bg-hover)' }"
              :disabled="!canAddRule"
              :title="!canAddRule ? t('agents.registerAgentFirst') : undefined"
              @click="canAddRule && (showAddRule = true)"
            >
              <Plus :size="14" />
              {{ t('agents.addRule') }}
            </button>
          </div>
          <div class="space-y-3 max-w-2xl">
            <div
              v-for="rule in sortedRules"
              :key="rule.id"
              class="flex items-center gap-4 rounded-xl border p-4"
              :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
            >
              <div class="flex-1 min-w-0">
                <div class="text-xs font-medium" :style="{ color: 'var(--hc-text-muted)' }">{{ ruleSummary(rule) }}</div>
                <div class="flex items-center gap-2 mt-1">
                  <span class="text-sm font-medium" :style="{ color: 'var(--hc-text-primary)' }">→ {{ rule.agent_name }}</span>
                  <span v-if="rule.priority" class="text-[10px] px-1.5 py-0.5 rounded" :style="{ background: 'var(--hc-bg-hover)', color: 'var(--hc-text-muted)' }">P{{ rule.priority }}</span>
                </div>
              </div>
              <button
                class="p-1.5 rounded-md hover:bg-white/5 transition-colors"
                :style="{ color: 'var(--hc-error)' }"
                :title="t('common.delete')"
                @click="deletingRuleId = rule.id"
              >
                <Trash2 :size="16" />
              </button>
            </div>
          </div>
        </template>
      </template>
    </div>

    <!-- 注册 Agent 对话框 -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="showAddAgent" class="fixed inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-sm" @click.self="showAddAgent = false">
          <div
            class="w-full max-w-md rounded-2xl border flex flex-col overflow-hidden"
            :style="{ background: 'var(--hc-bg-elevated)', borderColor: 'var(--hc-border)' }"
          >
            <div class="flex items-center justify-between px-5 py-4 border-b" :style="{ borderColor: 'var(--hc-border)' }">
              <h2 class="text-[15px] font-semibold m-0" :style="{ color: 'var(--hc-text-primary)' }">{{ t('agents.registerAgent') }}</h2>
              <button class="p-1 rounded-md hover:bg-white/5" :style="{ color: 'var(--hc-text-muted)' }" @click="showAddAgent = false">
                <X :size="17" />
              </button>
            </div>
            <div class="p-5 flex flex-col gap-3.5">
              <div class="flex flex-col gap-1.5">
                <label class="text-[13px] font-medium" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('agents.name') }}</label>
                <input v-model="newAgent.name" type="text" class="rounded-lg border px-3 py-2 text-sm outline-none" :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }" placeholder="agent-name" />
              </div>
              <div class="flex flex-col gap-1.5">
                <label class="text-[13px] font-medium" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('agents.displayName') }}</label>
                <input v-model="newAgent.display_name" type="text" class="rounded-lg border px-3 py-2 text-sm outline-none" :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }" placeholder="My Agent" />
              </div>
              <div class="flex flex-col gap-1.5">
                <label class="text-[13px] font-medium" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('agents.provider') }}</label>
                <select
                  v-model="newAgent.provider"
                  class="rounded-lg border px-3 py-2 text-sm outline-none"
                  :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
                >
                  <option value="">{{ t('settings.llm.selectProvider') }}</option>
                  <option
                    v-for="provider in runtimeProviderOptions"
                    :key="provider.key"
                    :value="provider.key"
                  >
                    {{ provider.label }}
                  </option>
                </select>
              </div>
              <div class="flex flex-col gap-1.5">
                <label class="text-[13px] font-medium" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('agents.model') }}</label>
                <select
                  v-model="newAgent.model"
                  class="rounded-lg border px-3 py-2 text-sm outline-none"
                  :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
                  :disabled="!newAgent.provider"
                >
                  <option value="">{{ t('settings.llm.models') }}</option>
                  <option
                    v-for="model in modelsForProvider(newAgent.provider)"
                    :key="model.id"
                    :value="model.id"
                  >
                    {{ model.name }}
                  </option>
                </select>
              </div>
            </div>
            <div class="flex items-center justify-end gap-2 px-5 py-3.5 border-t" :style="{ borderColor: 'var(--hc-border)' }">
              <button class="px-3 py-1.5 rounded-lg text-sm font-medium" :style="{ color: 'var(--hc-text-secondary)', background: 'var(--hc-bg-hover)' }" @click="showAddAgent = false">
                {{ t('common.cancel') }}
              </button>
              <button
                class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium text-white"
                :style="{ background: 'var(--hc-accent)', opacity: !registerFormValid ? 0.4 : 1 }"
                :disabled="!registerFormValid"
                @click="handleRegisterAgent"
              >
                <Plus :size="14" />
                {{ t('common.create') }}
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- 编辑 Agent 路由对话框 -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="showEditAgent" class="fixed inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-sm" @click.self="showEditAgent = false">
          <div
            class="w-full max-w-md rounded-2xl border flex flex-col overflow-hidden"
            :style="{ background: 'var(--hc-bg-elevated)', borderColor: 'var(--hc-border)' }"
          >
            <div class="flex items-center justify-between px-5 py-4 border-b" :style="{ borderColor: 'var(--hc-border)' }">
              <h2 class="text-[15px] font-semibold m-0" :style="{ color: 'var(--hc-text-primary)' }">{{ t('agents.editAgent') }}</h2>
              <button class="p-1 rounded-md hover:bg-white/5" :style="{ color: 'var(--hc-text-muted)' }" @click="showEditAgent = false">
                <X :size="17" />
              </button>
            </div>
            <div class="p-5 flex flex-col gap-3.5">
              <div class="flex flex-col gap-1.5">
                <label class="text-[13px] font-medium" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('agents.name') }}</label>
                <input :value="editingAgent.name" type="text" disabled class="rounded-lg border px-3 py-2 text-sm outline-none opacity-60" :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }" />
              </div>
              <div class="flex flex-col gap-1.5">
                <label class="text-[13px] font-medium" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('agents.displayName') }}</label>
                <input v-model="editingAgent.display_name" type="text" class="rounded-lg border px-3 py-2 text-sm outline-none" :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }" />
              </div>
              <div class="flex flex-col gap-1.5">
                <label class="text-[13px] font-medium" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('agents.provider') }}</label>
                <select
                  v-model="editingAgent.provider"
                  class="rounded-lg border px-3 py-2 text-sm outline-none"
                  :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
                >
                  <option
                    v-if="
                      editingAgent.provider &&
                      !runtimeProviderOptions.some((provider) => provider.key === editingAgent.provider)
                    "
                    :value="editingAgent.provider"
                  >
                    {{ editingAgent.provider }} (invalid)
                  </option>
                  <option
                    v-for="provider in runtimeProviderOptions"
                    :key="provider.key"
                    :value="provider.key"
                  >
                    {{ provider.label }}
                  </option>
                </select>
              </div>
              <div class="flex flex-col gap-1.5">
                <label class="text-[13px] font-medium" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('agents.model') }}</label>
                <select
                  v-model="editingAgent.model"
                  class="rounded-lg border px-3 py-2 text-sm outline-none"
                  :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
                  :disabled="!editingAgent.provider"
                >
                  <option
                    v-if="
                      editingAgent.model &&
                      !modelsForProvider(editingAgent.provider).some((model) => model.id === editingAgent.model)
                    "
                    :value="editingAgent.model"
                  >
                    {{ editingAgent.model }} (invalid)
                  </option>
                  <option
                    v-for="model in modelsForProvider(editingAgent.provider)"
                    :key="model.id"
                    :value="model.id"
                  >
                    {{ model.name }}
                  </option>
                </select>
              </div>
            </div>
            <div class="flex items-center justify-end gap-2 px-5 py-3.5 border-t" :style="{ borderColor: 'var(--hc-border)' }">
              <button class="px-3 py-1.5 rounded-lg text-sm font-medium" :style="{ color: 'var(--hc-text-secondary)', background: 'var(--hc-bg-hover)' }" @click="showEditAgent = false">
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

    <!-- 注销确认 -->
    <ConfirmDialog
      :open="showUnregisterConfirm"
      :title="t('agents.unregisterConfirmTitle')"
      :message="t('agents.unregisterConfirmMessage')"
      :confirm-text="t('agents.unregister')"
      @confirm="handleUnregisterAgent"
      @cancel="showUnregisterConfirm = false; unregisteringName = ''"
    />

    <!-- 添加路由规则对话框 -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="showAddRule" class="fixed inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-sm" @click.self="showAddRule = false">
          <div
            class="w-full max-w-md rounded-2xl border flex flex-col overflow-hidden"
            :style="{ background: 'var(--hc-bg-elevated)', borderColor: 'var(--hc-border)' }"
          >
            <div class="flex items-center justify-between px-5 py-4 border-b" :style="{ borderColor: 'var(--hc-border)' }">
              <h2 class="text-[15px] font-semibold m-0" :style="{ color: 'var(--hc-text-primary)' }">{{ t('agents.addRule') }}</h2>
              <button class="p-1 rounded-md hover:bg-white/5" :style="{ color: 'var(--hc-text-muted)' }" @click="showAddRule = false">
                <X :size="17" />
              </button>
            </div>
            <div class="p-5 flex flex-col gap-3.5">
              <div class="flex flex-col gap-1.5">
                <label class="text-[13px] font-medium" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('agents.rulePlatform') }} *</label>
                <select
                  v-model="newRule.platform"
                  class="hc-input"
                >
                  <option v-for="p in PLATFORM_OPTIONS" :key="p" :value="p">{{ p }}</option>
                </select>
              </div>
              <div class="flex flex-col gap-1.5">
                <label class="text-[13px] font-medium" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('agents.ruleInstanceId') }}</label>
                <input v-model="newRule.instance_id" type="text" class="rounded-lg border px-3 py-2 text-sm outline-none" :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }" placeholder="feishu-support" />
              </div>
              <div class="flex flex-col gap-1.5">
                <label class="text-[13px] font-medium" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('agents.ruleUserId') }}</label>
                <input v-model="newRule.user_id" type="text" class="rounded-lg border px-3 py-2 text-sm outline-none" :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }" placeholder="user-123" />
              </div>
              <div class="flex flex-col gap-1.5">
                <label class="text-[13px] font-medium" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('agents.ruleChatId') }}</label>
                <input v-model="newRule.chat_id" type="text" class="rounded-lg border px-3 py-2 text-sm outline-none" :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }" placeholder="chat-456" />
              </div>
              <div class="flex flex-col gap-1.5">
                <label class="text-[13px] font-medium" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('agents.ruleAgentName') }} *</label>
                <select
                  v-model="newRule.agent_name"
                  class="hc-input"
                >
                  <option value="">— {{ t('agents.ruleAgentName') }} —</option>
                  <option v-for="a in agents" :key="a.name" :value="a.name">{{ a.display_name || a.name }}</option>
                </select>
              </div>
              <div class="flex flex-col gap-1.5">
                <label class="text-[13px] font-medium" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('agents.rulePriority') }}</label>
                <input v-model.number="newRule.priority" type="number" class="rounded-lg border px-3 py-2 text-sm outline-none" :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }" placeholder="0" />
              </div>
            </div>
            <div class="flex items-center justify-end gap-2 px-5 py-3.5 border-t" :style="{ borderColor: 'var(--hc-border)' }">
              <button class="px-3 py-1.5 rounded-lg text-sm font-medium" :style="{ color: 'var(--hc-text-secondary)', background: 'var(--hc-bg-hover)' }" @click="showAddRule = false">
                {{ t('common.cancel') }}
              </button>
              <button
                class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium text-white disabled:opacity-50"
                :style="{ background: 'var(--hc-accent)' }"
                :disabled="!newRule.agent_name?.trim() || ruleSaving"
                @click="handleAddRule"
              >
                <Plus v-if="!ruleSaving" :size="14" />
                <span>{{ ruleSaving ? t('common.loading') : t('common.create') }}</span>
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- 删除规则确认 -->
    <ConfirmDialog
      :open="deletingRuleId !== null"
      :title="t('common.delete')"
      :message="t('agents.deleteRuleConfirm')"
      :confirm-text="t('common.delete')"
      @confirm="deletingRuleId != null && handleDeleteRule(deletingRuleId)"
      @cancel="deletingRuleId = null"
    />
  </div>
</template>

<style scoped>
.line-clamp-2 {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.modal-enter-active { transition: opacity 0.2s ease-out; }
.modal-leave-active { transition: opacity 0.15s ease-in; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
</style>
