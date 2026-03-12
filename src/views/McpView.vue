<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Server, Plus, Trash2, RefreshCw, Wrench } from 'lucide-vue-next'
import { getMcpServers, addMcpServer, removeMcpServer, reconnectMcpServer, type McpServer } from '@/api/mcp'
import PageHeader from '@/components/common/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import StatusBadge from '@/components/common/StatusBadge.vue'

const { t } = useI18n()

const servers = ref<McpServer[]>([])
const loading = ref(true)
const showAddForm = ref(false)
const newName = ref('')
const newUrl = ref('')
const newTransport = ref<'stdio' | 'sse' | 'streamable_http'>('stdio')
const selectedTool = ref<{ name: string; description: string; schema?: any } | null>(null)

onMounted(async () => {
  await loadServers()
})

async function loadServers() {
  loading.value = true
  try {
    const res = await getMcpServers()
    servers.value = res.servers || []
  } catch (e) {
    console.error('加载 MCP 服务器失败:', e)
  } finally {
    loading.value = false
  }
}

async function handleAdd() {
  if (!newName.value.trim() || !newUrl.value.trim()) return
  try {
    const server = await addMcpServer(newName.value.trim(), newUrl.value.trim())
    servers.value.push(server)
    newName.value = ''
    newUrl.value = ''
    showAddForm.value = false
  } catch (e) {
    console.error('添加 MCP 服务器失败:', e)
  }
}

async function handleRemove(server: McpServer) {
  try {
    await removeMcpServer(server.id)
    servers.value = servers.value.filter(s => s.id !== server.id)
  } catch (e) {
    console.error('删除 MCP 服务器失败:', e)
  }
}

async function handleReconnect(server: McpServer) {
  try {
    await reconnectMcpServer(server.id)
    server.status = 'connected'
  } catch (e) {
    console.error('重连 MCP 服务器失败:', e)
  }
}

function serverStatus(s: string): 'online' | 'offline' | 'error' {
  const map: Record<string, 'online' | 'offline' | 'error'> = {
    connected: 'online',
    disconnected: 'offline',
    error: 'error',
  }
  return map[s] || 'offline'
}
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <PageHeader :title="t('mcp.title')" :description="t('mcp.description')">
      <template #actions>
        <button
          class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium text-white"
          :style="{ background: 'var(--hc-accent)' }"
          @click="showAddForm = !showAddForm"
        >
          <Plus :size="16" />
          {{ t('common.create') }}
        </button>
      </template>
    </PageHeader>

    <div class="flex-1 overflow-y-auto p-6">
      <!-- 添加表单 -->
      <div
        v-if="showAddForm"
        class="mb-6 max-w-lg rounded-xl border p-4 space-y-3"
        :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
      >
        <input
          v-model="newName"
          type="text"
          :placeholder="t('mcp.serverName')"
          class="w-full rounded-lg border px-3 py-2 text-sm outline-none"
          :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
        />
        <input
          v-model="newUrl"
          type="text"
          :placeholder="t('mcp.serverUrl')"
          class="w-full rounded-lg border px-3 py-2 text-sm outline-none"
          :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
        />
        <select
          v-model="newTransport"
          class="w-full rounded-lg border px-3 py-2 text-sm outline-none"
          :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
        >
          <option value="stdio">stdio</option>
          <option value="sse">SSE</option>
          <option value="streamable_http">Streamable HTTP</option>
        </select>
        <div class="flex gap-2">
          <button
            class="px-3 py-1.5 rounded-lg text-sm text-white"
            :style="{ background: 'var(--hc-accent)' }"
            @click="handleAdd"
          >
            {{ t('common.create') }}
          </button>
          <button
            class="px-3 py-1.5 rounded-lg text-sm"
            :style="{ color: 'var(--hc-text-secondary)' }"
            @click="showAddForm = false"
          >
            {{ t('common.cancel') }}
          </button>
        </div>
      </div>

      <LoadingState v-if="loading" />

      <EmptyState
        v-else-if="servers.length === 0"
        :icon="Server"
        :title="t('common.noData')"
        :description="t('mcp.emptyDesc')"
      />

      <div v-else class="space-y-4 max-w-2xl">
        <div
          v-for="server in servers"
          :key="server.id"
          class="rounded-xl border p-4"
          :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
        >
          <div class="flex items-start justify-between mb-3">
            <div>
              <div class="flex items-center gap-2">
                <span class="text-sm font-medium" :style="{ color: 'var(--hc-text-primary)' }">{{ server.name }}</span>
                <StatusBadge :status="serverStatus(server.status)" />
              </div>
              <p class="text-xs mt-0.5" :style="{ color: 'var(--hc-text-muted)' }">{{ server.url }}</p>
            </div>
            <div class="flex items-center gap-1">
              <button
                class="p-1.5 rounded-md hover:bg-white/5 transition-colors"
                :style="{ color: 'var(--hc-text-secondary)' }"
                :title="t('mcp.reconnect')"
                @click="handleReconnect(server)"
              >
                <RefreshCw :size="14" />
              </button>
              <button
                class="p-1.5 rounded-md hover:bg-white/5 transition-colors"
                :style="{ color: 'var(--hc-error)' }"
                :title="t('common.delete')"
                @click="handleRemove(server)"
              >
                <Trash2 :size="14" />
              </button>
            </div>
          </div>

          <!-- 工具列表 -->
          <div v-if="server.tools.length > 0">
            <div class="text-xs mb-1.5" :style="{ color: 'var(--hc-text-muted)' }">
              <Wrench :size="12" class="inline mr-1" />
              {{ t('mcp.toolCount', { count: server.tools.length }) }}
            </div>
            <div class="flex flex-wrap gap-1">
              <span
                v-for="tool in server.tools"
                :key="tool.name"
                class="px-2 py-0.5 rounded text-xs"
                :style="{ background: 'var(--hc-bg-hover)', color: 'var(--hc-text-secondary)' }"
              >
                {{ tool.name }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
