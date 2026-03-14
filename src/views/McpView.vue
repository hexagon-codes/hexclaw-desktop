<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Server, Wrench, RefreshCw } from 'lucide-vue-next'
import { getMcpServers, getMcpTools } from '@/api/mcp'
import type { McpTool } from '@/types'
import PageHeader from '@/components/common/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import LoadingState from '@/components/common/LoadingState.vue'

const { t } = useI18n()

const servers = ref<string[]>([])
const tools = ref<McpTool[]>([])
const loading = ref(true)
const errorMsg = ref('')
const activeTab = ref<'servers' | 'tools'>('servers')
const expandedTool = ref<string | null>(null)

onMounted(async () => {
  await loadAll()
})

async function loadAll() {
  loading.value = true
  errorMsg.value = ''
  try {
    const [srvRes, toolRes] = await Promise.all([getMcpServers(), getMcpTools()])
    servers.value = srvRes.servers || []
    tools.value = toolRes.tools || []
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : '加载 MCP 数据失败'
    console.error('加载 MCP 数据失败:', e)
  } finally {
    loading.value = false
  }
}

function toggleTool(name: string) {
  expandedTool.value = expandedTool.value === name ? null : name
}
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <PageHeader :title="t('mcp.title')" :description="t('mcp.description')">
      <template #actions>
        <button
          class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium"
          :style="{ color: 'var(--hc-text-secondary)', background: 'var(--hc-bg-hover)' }"
          @click="loadAll"
        >
          <RefreshCw :size="14" />
          {{ t('common.refresh') || '刷新' }}
        </button>
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
          borderColor: activeTab === 'servers' ? 'var(--hc-accent)' : 'transparent',
          color: activeTab === 'servers' ? 'var(--hc-text-primary)' : 'var(--hc-text-secondary)',
        }"
        @click="activeTab = 'servers'"
      >
        {{ t('mcp.servers') }} ({{ servers.length }})
      </button>
      <button
        class="px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px"
        :style="{
          borderColor: activeTab === 'tools' ? 'var(--hc-accent)' : 'transparent',
          color: activeTab === 'tools' ? 'var(--hc-text-primary)' : 'var(--hc-text-secondary)',
        }"
        @click="activeTab = 'tools'"
      >
        {{ t('mcp.tools') }} ({{ tools.length }})
      </button>
    </div>

    <div class="flex-1 overflow-y-auto p-6">
      <LoadingState v-if="loading" />

      <!-- 服务器列表 -->
      <template v-else-if="activeTab === 'servers'">
        <EmptyState
          v-if="servers.length === 0"
          :icon="Server"
          :title="t('common.noData')"
          :description="t('mcp.emptyDesc')"
        />

        <div v-else class="space-y-3 max-w-2xl">
          <div
            v-for="name in servers"
            :key="name"
            class="flex items-center gap-3 rounded-xl border p-4"
            :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
          >
            <Server :size="16" :style="{ color: 'var(--hc-accent)' }" />
            <span class="text-sm font-medium" :style="{ color: 'var(--hc-text-primary)' }">{{ name }}</span>
          </div>
        </div>
      </template>

      <!-- 工具列表 -->
      <template v-else>
        <EmptyState
          v-if="tools.length === 0"
          :icon="Wrench"
          :title="t('common.noData')"
          :description="t('mcp.noTools')"
        />

        <div v-else class="space-y-3 max-w-2xl">
          <div
            v-for="tool in tools"
            :key="tool.name"
            class="rounded-xl border overflow-hidden"
            :style="{ background: 'var(--hc-bg-card)', borderColor: 'var(--hc-border)' }"
          >
            <div
              class="flex items-center gap-3 p-4 cursor-pointer hover:bg-white/[0.02] transition-colors"
              @click="toggleTool(tool.name)"
            >
              <Wrench :size="14" :style="{ color: 'var(--hc-accent)' }" />
              <div class="flex-1 min-w-0">
                <span class="text-sm font-medium" :style="{ color: 'var(--hc-text-primary)' }">{{ tool.name }}</span>
                <p v-if="tool.description" class="text-xs mt-0.5 truncate" :style="{ color: 'var(--hc-text-muted)' }">
                  {{ tool.description }}
                </p>
              </div>
              <span class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">
                {{ expandedTool === tool.name ? '▲' : '▼' }}
              </span>
            </div>
            <div
              v-if="expandedTool === tool.name && tool.input_schema"
              class="px-4 pb-4 border-t"
              :style="{ borderColor: 'var(--hc-border)' }"
            >
              <pre class="text-xs mt-3 p-3 rounded-lg overflow-x-auto" :style="{ background: 'var(--hc-bg-main)', color: 'var(--hc-text-secondary)' }">{{ JSON.stringify(tool.input_schema, null, 2) }}</pre>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
