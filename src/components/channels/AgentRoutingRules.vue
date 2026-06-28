<script setup lang="ts">
/**
 * Agent 路由规则管理：配置"哪个通道/用户的消息分派给哪个 Agent"。
 */
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, Trash2, Users, X } from 'lucide-vue-next'
import { getAgents, getRules, addRule, deleteRule } from '@/api/agents'
import { logger } from '@/utils/logger'
import { userVisibleAgents } from '@/utils/imChannelBinding'
import type { AgentConfig, AgentRule } from '@/types'
import LoadingState from '@/components/common/LoadingState.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import HcSelect from '@/components/common/HcSelect.vue'

const { t } = useI18n()

const errorMsg = ref('')
const agents = ref<AgentConfig[]>([])
const rules = ref<AgentRule[]>([])
const rulesLoading = ref(false)
const ruleSaving = ref(false)
const showAddRule = ref(false)
const deletingRuleId = ref<number | null>(null)
const deletingRuleIds = ref<Set<number>>(new Set())
const newRule = ref<Omit<AgentRule, 'id'>>({
  platform: 'api',
  instance_id: '',
  user_id: '',
  chat_id: '',
  agent_name: '',
  priority: 0,
})
const RULE_PLATFORM_OPTIONS = ['api', 'telegram', 'feishu', 'dingtalk', 'discord'] as const

const sortedRules = computed(() =>
  [...rules.value].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)),
)
const canAddRule = computed(() => agents.value.length > 0)

// HcSelect 选项投影
const platformOptions = computed(() =>
  RULE_PLATFORM_OPTIONS.map((p) => ({ value: p, label: p })),
)
const agentNameOptions = computed(() =>
  agents.value.map((a) => ({ value: a.name, label: a.display_name || a.name })),
)

async function loadAll() {
  rulesLoading.value = true
  try {
    const [agentsRes, rulesRes] = await Promise.all([getAgents(), getRules()])
    // 经单一可见性边界 userVisibleAgents 剔除匿名「频道默认模型」Agent（@im/*）——不作为可手动绑定的路由目标暴露给用户。
    agents.value = userVisibleAgents(agentsRes.agents || [])
    rules.value = rulesRes.rules || []
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('agents.loadRulesFailed')
    logger.error('加载路由规则失败:', e)
  } finally {
    rulesLoading.value = false
  }
}

async function handleAddRule() {
  if (ruleSaving.value) return
  if (!newRule.value.agent_name.trim()) return
  ruleSaving.value = true
  errorMsg.value = ''
  try {
    await addRule(newRule.value)
    closeAddRuleDialog()
    await loadAll()
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('agents.loadRulesFailed')
  } finally {
    ruleSaving.value = false
  }
}

async function handleDeleteRule(id: number) {
  if (deletingRuleIds.value.has(id)) return
  deletingRuleIds.value = new Set(deletingRuleIds.value).add(id)
  errorMsg.value = ''
  try {
    await deleteRule(id)
    rules.value = rules.value.filter((r) => r.id !== id)
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('agents.loadRulesFailed')
  } finally {
    const next = new Set(deletingRuleIds.value)
    next.delete(id)
    deletingRuleIds.value = next
    deletingRuleId.value = null
  }
}

function resetAddRuleDialog() {
  newRule.value = {
    platform: 'api',
    instance_id: '',
    user_id: '',
    chat_id: '',
    agent_name: '',
    priority: 0,
  }
}

function openAddRuleDialog() {
  errorMsg.value = ''
  resetAddRuleDialog()
  showAddRule.value = true
}

function closeAddRuleDialog() {
  showAddRule.value = false
  errorMsg.value = ''
  resetAddRuleDialog()
}

function ruleSummary(rule: AgentRule): string {
  const parts: string[] = []
  if (rule.platform) parts.push(rule.platform)
  if (rule.instance_id) parts.push(rule.instance_id)
  if (rule.user_id) parts.push(`user:${rule.user_id}`)
  if (rule.chat_id) parts.push(`chat:${rule.chat_id}`)
  return parts.join(' · ') || '—'
}

onMounted(loadAll)

defineExpose({ loadAll })
</script>

<template>
  <div>
    <p
      v-if="errorMsg"
      class="text-sm rounded-lg px-3 py-2 mb-3 max-w-2xl"
      :style="{ color: 'var(--hc-error)', background: 'var(--hc-bg-card)' }"
    >
      {{ errorMsg }}
    </p>

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
        @click="openAddRuleDialog"
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
          @click="canAddRule && openAddRuleDialog()"
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

    <!-- 添加路由规则对话框 -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="showAddRule" class="fixed inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-sm" @click.self="closeAddRuleDialog">
          <div
            class="w-full max-w-md rounded-2xl border flex flex-col overflow-hidden"
            :style="{ background: 'var(--hc-bg-elevated)', borderColor: 'var(--hc-border)' }"
          >
            <div class="flex items-center justify-between px-5 py-4 border-b" :style="{ borderColor: 'var(--hc-border)' }">
              <h2 class="text-[15px] font-semibold m-0" :style="{ color: 'var(--hc-text-primary)' }">{{ t('agents.addRule') }}</h2>
              <button class="p-1 rounded-md hover:bg-white/5" :style="{ color: 'var(--hc-text-muted)' }" @click="closeAddRuleDialog">
                <X :size="17" />
              </button>
            </div>
            <div class="p-5 flex flex-col gap-3.5">
              <div class="flex flex-col gap-1.5">
                <label class="text-[13px] font-medium" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('agents.rulePlatform') }} *</label>
                <HcSelect v-model="newRule.platform" :options="platformOptions" />
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
                <HcSelect
                  v-model="newRule.agent_name"
                  :options="agentNameOptions"
                  :placeholder="`— ${t('agents.ruleAgentName')} —`"
                />
              </div>
              <div class="flex flex-col gap-1.5">
                <label class="text-[13px] font-medium" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('agents.rulePriority') }}</label>
                <input v-model.number="newRule.priority" type="number" class="rounded-lg border px-3 py-2 text-sm outline-none" :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }" placeholder="0" />
              </div>
            </div>
            <div class="flex items-center justify-end gap-2 px-5 py-3.5 border-t" :style="{ borderColor: 'var(--hc-border)' }">
              <button class="px-3 py-1.5 rounded-lg text-sm font-medium" :style="{ color: 'var(--hc-text-secondary)', background: 'var(--hc-bg-hover)' }" @click="closeAddRuleDialog">
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
