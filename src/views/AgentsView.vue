<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Bot, MessageSquare, Plus, Trash2, X, Users } from 'lucide-vue-next'
import { useAgentsStore } from '@/stores/agents'
import { getAgents, registerAgent, unregisterAgent } from '@/api/agents'
import type { AgentRole, AgentConfig } from '@/types'
import PageHeader from '@/components/common/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import SearchInput from '@/components/common/SearchInput.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'

const { t } = useI18n()
const router = useRouter()
const agentsStore = useAgentsStore()

const searchQuery = ref('')
const activeTab = ref<'roles' | 'agents'>('roles')
const errorMsg = ref('')

// Agent 路由
const agents = ref<AgentConfig[]>([])
const defaultAgent = ref('')
const agentsLoading = ref(false)
const showAddAgent = ref(false)
const newAgent = ref<AgentConfig>({ name: '', display_name: '', model: '', provider: '' })

// 注销确认
const showUnregisterConfirm = ref(false)
const unregisteringName = ref('')

onMounted(async () => {
  await Promise.all([agentsStore.loadRoles(), loadAgents()])
})

async function loadAgents() {
  agentsLoading.value = true
  errorMsg.value = ''
  try {
    const res = await getAgents()
    agents.value = res.agents || []
    defaultAgent.value = res.default || ''
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : '加载 Agents 失败'
    console.error('加载 Agents 失败:', e)
  } finally {
    agentsLoading.value = false
  }
}

function handleChat(role: AgentRole) {
  router.push({ path: '/chat', query: { role: role.name } })
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
    (a) => a.name.toLowerCase().includes(q) || a.display_name.toLowerCase().includes(q) || a.model.toLowerCase().includes(q),
  )
})

async function handleRegisterAgent() {
  if (!newAgent.value.name.trim()) return
  errorMsg.value = ''
  try {
    await registerAgent(newAgent.value)
    showAddAgent.value = false
    newAgent.value = { name: '', display_name: '', model: '', provider: '' }
    await loadAgents()
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : '注册 Agent 失败'
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
    errorMsg.value = e instanceof Error ? e.message : '注销 Agent 失败'
    console.error('注销 Agent 失败:', e)
  } finally {
    showUnregisterConfirm.value = false
    unregisteringName.value = ''
  }
}
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <PageHeader :title="t('agents.title')" :description="t('agents.description')">
      <template #actions>
        <SearchInput v-model="searchQuery" :placeholder="t('agents.searchPlaceholder')" />
      </template>
    </PageHeader>

    <!-- 错误提示 -->
    <div
      v-if="errorMsg"
      class="mx-6 mt-2 px-4 py-2 rounded-lg text-sm flex items-center justify-between"
      style="background: #ef444420; color: #ef4444;"
    >
      <span>{{ errorMsg }}</span>
      <button class="text-xs underline ml-4" @click="errorMsg = ''">{{ t('common.close') }}</button>
    </div>

    <!-- 标签页 -->
    <div class="flex items-center gap-0 px-6 pt-3 border-b" :style="{ borderColor: 'var(--hc-border)' }">
      <button
        class="px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px"
        :style="{
          borderColor: activeTab === 'roles' ? 'var(--hc-accent)' : 'transparent',
          color: activeTab === 'roles' ? 'var(--hc-text-primary)' : 'var(--hc-text-secondary)',
        }"
        @click="activeTab = 'roles'"
      >
        {{ t('agents.roles') }} ({{ agentsStore.roles.length }})
      </button>
      <button
        class="px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px"
        :style="{
          borderColor: activeTab === 'agents' ? 'var(--hc-accent)' : 'transparent',
          color: activeTab === 'agents' ? 'var(--hc-text-primary)' : 'var(--hc-text-secondary)',
        }"
        @click="activeTab = 'agents'"
      >
        {{ t('agents.routing') }} ({{ agents.length }})
      </button>
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
            class="rounded-xl border p-4 cursor-pointer transition-colors"
            :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
            @click="handleChat(role)"
          >
            <div class="flex items-center gap-3 mb-3">
              <div
                class="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
                :style="{ background: 'var(--hc-accent)', color: '#fff' }"
              >
                <Bot :size="18" />
              </div>
              <div class="min-w-0">
                <div class="text-sm font-semibold truncate" :style="{ color: 'var(--hc-text-primary)' }">
                  {{ role.title || role.name }}
                </div>
                <div class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">{{ role.name }}</div>
              </div>
            </div>
            <p class="text-xs leading-relaxed line-clamp-2" :style="{ color: 'var(--hc-text-secondary)' }">
              {{ role.goal || t('agents.noDesc') }}
            </p>
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

      <!-- Agent 路由管理 -->
      <template v-else>
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
                <input v-model="newAgent.provider" type="text" class="rounded-lg border px-3 py-2 text-sm outline-none" :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }" placeholder="openai" />
              </div>
              <div class="flex flex-col gap-1.5">
                <label class="text-[13px] font-medium" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('agents.model') }}</label>
                <input v-model="newAgent.model" type="text" class="rounded-lg border px-3 py-2 text-sm outline-none" :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }" placeholder="gpt-4o" />
              </div>
            </div>
            <div class="flex items-center justify-end gap-2 px-5 py-3.5 border-t" :style="{ borderColor: 'var(--hc-border)' }">
              <button class="px-3 py-1.5 rounded-lg text-sm font-medium" :style="{ color: 'var(--hc-text-secondary)', background: 'var(--hc-bg-hover)' }" @click="showAddAgent = false">
                {{ t('common.cancel') }}
              </button>
              <button
                class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium text-white"
                :style="{ background: 'var(--hc-accent)', opacity: !newAgent.name.trim() ? 0.4 : 1 }"
                :disabled="!newAgent.name.trim()"
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

    <!-- 注销确认 -->
    <ConfirmDialog
      :open="showUnregisterConfirm"
      :title="t('agents.unregisterConfirmTitle')"
      :message="t('agents.unregisterConfirmMessage')"
      :confirm-text="t('agents.unregister')"
      @confirm="handleUnregisterAgent"
      @cancel="showUnregisterConfirm = false; unregisteringName = ''"
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
