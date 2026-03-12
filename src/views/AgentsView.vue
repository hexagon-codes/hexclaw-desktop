<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Plus, Bot, Search } from 'lucide-vue-next'
import { useAgentsStore } from '@/stores/agents'
import type { AgentRole, AgentRoleInput } from '@/api/agents'
import PageHeader from '@/components/common/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import SearchInput from '@/components/common/SearchInput.vue'
import AgentCard from '@/components/agent/AgentCard.vue'
import AgentForm from '@/components/agent/AgentForm.vue'

const { t } = useI18n()
const router = useRouter()
const agentsStore = useAgentsStore()
const showForm = ref(false)
const editingRole = ref<AgentRole | null>(null)
const searchQuery = ref('')

onMounted(() => {
  agentsStore.loadRoles()
})

function handleCreate() {
  editingRole.value = null
  showForm.value = true
}

function handleEdit(role: AgentRole) {
  editingRole.value = role
  showForm.value = true
}

function handleChat(role: AgentRole) {
  router.push({ path: '/chat', query: { agent_id: role.id } })
}

async function handleDelete(role: AgentRole) {
  await agentsStore.deleteRole(role.id)
}

async function handleSave(data: AgentRoleInput) {
  if (editingRole.value) {
    await agentsStore.updateRole(editingRole.value.id, data)
  } else {
    await agentsStore.createRole(data)
  }
  showForm.value = false
}

function filteredRoles() {
  if (!searchQuery.value) return agentsStore.roles
  const q = searchQuery.value.toLowerCase()
  return agentsStore.roles.filter(
    (r) =>
      r.name.toLowerCase().includes(q) ||
      r.display_name.toLowerCase().includes(q) ||
      (r.description || '').toLowerCase().includes(q),
  )
}
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <PageHeader :title="t('agents.title')" :description="t('agents.description')">
      <template #actions>
        <SearchInput v-model="searchQuery" :placeholder="t('agents.searchPlaceholder')" />
        <button
          class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium text-white transition-colors"
          :style="{ background: 'var(--hc-accent)' }"
          @click="handleCreate"
        >
          <Plus :size="16" />
          {{ t('agents.createAgent') }}
        </button>
      </template>
    </PageHeader>

    <div class="flex-1 overflow-y-auto p-6">
      <LoadingState v-if="agentsStore.loading" />

      <EmptyState
        v-else-if="agentsStore.roles.length === 0"
        :icon="Bot"
        :title="t('agents.noAgents')"
        :description="t('agents.noAgentsDesc')"
      >
        <button
          class="mt-4 px-4 py-2 rounded-lg text-sm text-white"
          :style="{ background: 'var(--hc-accent)' }"
          @click="handleCreate"
        >
          {{ t('agents.createAgent') }}
        </button>
      </EmptyState>

      <div v-else class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <AgentCard
          v-for="role in filteredRoles()"
          :key="role.id"
          :role="role"
          @chat="handleChat"
          @edit="handleEdit"
          @delete="handleDelete"
        />
      </div>
    </div>

    <AgentForm
      :visible="showForm"
      :role="editingRole"
      @close="showForm = false"
      @save="handleSave"
    />
  </div>
</template>
