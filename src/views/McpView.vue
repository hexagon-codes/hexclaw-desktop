<script setup lang="ts">
import { onMounted, ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Server, Wrench, Search, Play, Loader2, CircleCheck, CircleX, Plus, Trash2, X, Download } from 'lucide-vue-next'
import { getMcpServers, getMcpTools, callMcpTool, getMcpServerStatus, addMcpServer, removeMcpServer, getMcpMarketplace, searchMcpMarketplace, type McpMarketplaceEntry } from '@/api/mcp'
import { installFromHub } from '@/api/skills'
import { resolveUserHome } from '@/utils/platform'
import type { McpTool } from '@/types'
import EmptyState from '@/components/common/EmptyState.vue'
import LoadingState from '@/components/common/LoadingState.vue'

const { t } = useI18n()

const servers = ref<string[]>([])
const serverStatuses = ref<Record<string, 'connected' | 'disconnected' | 'error'>>({})
const tools = ref<McpTool[]>([])
const loading = ref(true)
const errorMsg = ref('')
const activeTab = ref<'servers' | 'tools' | 'marketplace'>('servers')

// ─── MCP Marketplace state ──────────────────────────────
const marketplaceItems = ref<McpMarketplaceEntry[]>([])
const marketplaceLoading = ref(false)
const marketplaceSearch = ref('')
const installingServers = ref<Set<string>>(new Set())
let marketplaceRequestGen = 0
let loadAllRequestGen = 0
let statusRequestGen = 0

async function loadMarketplace() {
  const requestGen = ++marketplaceRequestGen
  marketplaceLoading.value = true
  errorMsg.value = ''
  try {
    const q = marketplaceSearch.value.trim()
    const res = q ? await searchMcpMarketplace(q) : await getMcpMarketplace()
    if (requestGen !== marketplaceRequestGen) return
    marketplaceItems.value = res.skills || []
  } catch (e) {
    if (requestGen !== marketplaceRequestGen) return
    console.error('Failed to load MCP marketplace:', e)
    errorMsg.value = e instanceof Error ? e.message : 'Failed to load marketplace'
    marketplaceItems.value = []
  }
  finally {
    if (requestGen === marketplaceRequestGen) {
      marketplaceLoading.value = false
    }
  }
}

async function installFromMarketplace(entry: McpMarketplaceEntry) {
  if (installingServers.value.has(entry.name)) return
  installingServers.value = new Set([...installingServers.value, entry.name])
  errorMsg.value = ''
  try {
    // MCP 条目有 command/args → 直接添加为 MCP Server
    // Skill 条目 → 通过 Hub 安装
    if (entry.command?.trim()) {
      let args = entry.args || []
      // filesystem server 需要目录参数，动态追加用户 home 目录（兼容 Win/Linux/macOS）
      if (args.some(a => a.includes('server-filesystem'))) {
        const hasPath = args.some(a => a.startsWith('/') || a.startsWith('~') || /^[A-Z]:\\/i.test(a))
        if (!hasPath) {
          const home = await resolveUserHome()
          if (home) args = [...args, home]
        }
      }
      await addMcpServer(entry.name, entry.command, args)
    } else {
      await installFromHub(entry.name)
    }
    await loadAll()
  } catch (e) { errorMsg.value = e instanceof Error ? e.message : 'Install failed' }
  finally {
    const nextInstalling = new Set(installingServers.value)
    nextInstalling.delete(entry.name)
    installingServers.value = nextInstalling
  }
}
const expandedTool = ref<string | null>(null)
const toolSearchQuery = ref('')

// ─── Tool testing state ──────────────────────────────
const testingTool = ref<string | null>(null)
const testParams = ref<Record<string, string>>({})
const testRunningTools = ref<Set<string>>(new Set())
const testResult = ref<{ output?: unknown; error?: string } | null>(null)

onMounted(async () => {
  await loadAll()
})

watch(activeTab, () => {
  errorMsg.value = ''
})

function setOptimisticStatuses(nextServers: string[]) {
  const statuses: Record<string, 'connected'> = {}
  for (const server of nextServers) statuses[server] = 'connected'
  serverStatuses.value = statuses
}

async function refreshServerStatuses(nextServers: string[], requestGen: number) {
  const statusGen = ++statusRequestGen
  try {
    const statusRes = await getMcpServerStatus()
    if (requestGen !== loadAllRequestGen || statusGen !== statusRequestGen) return
    if (statusRes.statuses) {
      serverStatuses.value = statusRes.statuses
      return
    }
    if (Array.isArray(statusRes.servers)) {
      const map: Record<string, 'connected' | 'disconnected'> = {}
      for (const s of statusRes.servers as Array<{ name: string; connected: boolean }>) {
        map[s.name] = s.connected ? 'connected' : 'disconnected'
      }
      serverStatuses.value = map
      return
    }
  } catch {
    // If status API not available, keep optimistic connected statuses.
  }

  if (requestGen !== loadAllRequestGen || statusGen !== statusRequestGen) return
  setOptimisticStatuses(nextServers)
}

async function loadAll() {
  const requestGen = ++loadAllRequestGen
  loading.value = true
  errorMsg.value = ''
  try {
    const [srvRes, toolRes] = await Promise.all([getMcpServers(), getMcpTools()])
    if (requestGen !== loadAllRequestGen) return
    servers.value = srvRes.servers || []
    tools.value = toolRes.tools || []
    setOptimisticStatuses(servers.value)
    void refreshServerStatuses(servers.value, requestGen)
  } catch (e) {
    if (requestGen !== loadAllRequestGen) return
    errorMsg.value = e instanceof Error ? e.message : '加载 MCP 数据失败'
    console.error('加载 MCP 数据失败:', e)
  } finally {
    if (requestGen === loadAllRequestGen) {
      loading.value = false
    }
  }
}

function toggleTool(name: string) {
  expandedTool.value = expandedTool.value === name ? null : name
  // Close test form when collapsing
  if (expandedTool.value !== name && testingTool.value === name) {
    testingTool.value = null
    testResult.value = null
  }
}

// ─── Tool search ─────────────────────────────────────
const filteredTools = computed(() => {
  const q = toolSearchQuery.value.toLowerCase().trim()
  if (!q) return tools.value
  return tools.value.filter(
    (tool) =>
      tool.name.toLowerCase().includes(q) ||
      (tool.description && tool.description.toLowerCase().includes(q)),
  )
})

// ─── Tool testing ────────────────────────────────────
function openTestForm(toolName: string) {
  if (testingTool.value === toolName) {
    testingTool.value = null
    testResult.value = null
    return
  }
  testingTool.value = toolName
  testResult.value = null
  // Initialize params from schema
  const tool = tools.value.find((t) => t.name === toolName)
  const params: Record<string, string> = {}
  if (tool?.input_schema) {
    const props = (tool.input_schema as Record<string, unknown>).properties as
      | Record<string, unknown>
      | undefined
    if (props) {
      for (const key of Object.keys(props)) {
        params[key] = ''
      }
    }
  }
  testParams.value = params
}

function isTestRunning(toolName: string): boolean {
  return testRunningTools.value.has(toolName)
}

async function executeTest(toolName: string) {
  if (testRunningTools.value.has(toolName)) return
  testRunningTools.value = new Set([...testRunningTools.value, toolName])
  testResult.value = null
  try {
    // Parse params - try to parse JSON values
    const args: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(testParams.value)) {
      if (!val.trim()) continue
      try {
        args[key] = JSON.parse(val)
      } catch {
        args[key] = val
      }
    }
    const res = await callMcpTool(toolName, args)
    testResult.value = { output: res.result, error: res.error }
  } catch (e: unknown) {
    testResult.value = { error: e instanceof Error ? e.message : 'Execution failed' }
  } finally {
    const next = new Set(testRunningTools.value)
    next.delete(toolName)
    testRunningTools.value = next
  }
}

function getSchemaProperties(tool: McpTool): Array<{ key: string; type: string; description: string; required: boolean }> {
  if (!tool.input_schema) return []
  const schema = tool.input_schema as Record<string, unknown>
  const props = schema.properties as Record<string, Record<string, unknown>> | undefined
  const required = (schema.required as string[]) || []
  if (!props) return []
  return Object.entries(props).map(([key, val]) => ({
    key,
    type: (val.type as string) || 'string',
    description: (val.description as string) || '',
    required: required.includes(key),
  }))
}

function getServerStatus(name: string): 'connected' | 'disconnected' | 'error' {
  return serverStatuses.value[name] || 'disconnected'
}

// ─── Server management ──────────────────────────────
const showAddServer = ref(false)
const newServerName = ref('')
const newServerCommand = ref('')
const newServerArgs = ref('')
const addingServer = ref(false)
const removingServers = ref<Set<string>>(new Set())

function resetAddServerForm() {
  newServerName.value = ''
  newServerCommand.value = ''
  newServerArgs.value = ''
}

function closeAddServer() {
  showAddServer.value = false
  errorMsg.value = ''
  resetAddServerForm()
}

async function handleAddServer() {
  if (addingServer.value) return
  if (!newServerName.value.trim() || !newServerCommand.value.trim()) return
  addingServer.value = true
  errorMsg.value = ''
  try {
    const args = newServerArgs.value.trim() ? newServerArgs.value.trim().split(/\s+/) : undefined
    await addMcpServer(newServerName.value.trim(), newServerCommand.value.trim(), args)
    closeAddServer()
    await loadAll()
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : '添加服务器失败'
  } finally {
    addingServer.value = false
  }
}

async function handleRemoveServer(name: string) {
  if (removingServers.value.has(name)) return
  if (!confirm(t('mcpManage.removeConfirm'))) return
  const nextRemoving = new Set(removingServers.value)
  nextRemoving.add(name)
  removingServers.value = nextRemoving
  errorMsg.value = ''
  try {
    await removeMcpServer(name)
    servers.value = servers.value.filter(s => s !== name)
    delete serverStatuses.value[name]
    await loadAll()
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : '移除服务器失败'
  } finally {
    const currentRemoving = new Set(removingServers.value)
    currentRemoving.delete(name)
    removingServers.value = currentRemoving
  }
}

function openAddServer() {
  closeAddServer()
  showAddServer.value = true
}

function switchToMarketplace() {
  activeTab.value = 'marketplace'
  loadMarketplace()
}

defineExpose({ openAddServer, switchToMarketplace })
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">

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
      <div class="flex-1 flex items-center gap-0">
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
      <button
        class="px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px"
        :style="{
          borderColor: activeTab === 'marketplace' ? 'var(--hc-accent)' : 'transparent',
          color: activeTab === 'marketplace' ? 'var(--hc-text-primary)' : 'var(--hc-text-secondary)',
        }"
        @click="activeTab = 'marketplace'; loadMarketplace()"
      >
        {{ t('mcp.marketplace', 'Marketplace') }}
      </button>
      </div>
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
            <!-- Status dot -->
            <div
              class="w-2.5 h-2.5 rounded-full flex-shrink-0"
              :style="{
                background: getServerStatus(name) === 'connected' ? '#10b981' : getServerStatus(name) === 'error' ? '#ef4444' : '#6b7280',
              }"
              :title="getServerStatus(name) === 'connected' ? t('mcp.serverConnected') : t('mcp.serverDisconnected')"
            />
            <Server :size="16" :style="{ color: 'var(--hc-accent)' }" />
            <span class="text-sm font-medium flex-1" :style="{ color: 'var(--hc-text-primary)' }">{{ name }}</span>
            <button
              class="p-1.5 rounded-md hover:bg-white/5 transition-colors flex-shrink-0"
              :disabled="removingServers.has(name)"
              :style="{ color: 'var(--hc-text-muted)' }"
              :title="t('mcpManage.removeServer')"
              @click="handleRemoveServer(name)"
            >
              <Trash2 :size="14" />
            </button>
            <span
              class="text-xs px-2 py-0.5 rounded-full"
              :style="{
                background: getServerStatus(name) === 'connected' ? '#10b98120' : '#6b728020',
                color: getServerStatus(name) === 'connected' ? '#10b981' : '#6b7280',
              }"
            >
              {{ getServerStatus(name) === 'connected' ? t('mcp.serverConnected') : t('mcp.serverDisconnected') }}
            </span>
          </div>
        </div>
      </template>

      <!-- 工具列表 -->
      <template v-else-if="activeTab === 'tools'">
        <!-- Tool search bar -->
        <div class="max-w-2xl mb-4">
          <div class="relative">
            <Search
              :size="16"
              class="absolute left-3 top-1/2 -translate-y-1/2"
              :style="{ color: 'var(--hc-text-muted)' }"
            />
            <input
              v-model="toolSearchQuery"
              type="text"
              :placeholder="t('mcp.searchTools')"
              class="w-full pl-9 pr-3 py-2 rounded-lg border text-sm outline-none transition-colors"
              :style="{
                background: 'var(--hc-bg-primary)',
                borderColor: 'var(--hc-border)',
                color: 'var(--hc-text-primary)',
              }"
            />
          </div>
        </div>

        <EmptyState
          v-if="filteredTools.length === 0"
          :icon="Wrench"
          :title="t('common.noData')"
          :description="t('mcp.noTools')"
        />

        <div v-else class="space-y-3 max-w-2xl">
          <div
            v-for="tool in filteredTools"
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
              <!-- Test button -->
              <button
                class="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors hover:bg-white/10"
                :style="{
                  color: testingTool === tool.name ? 'var(--hc-accent)' : 'var(--hc-text-secondary)',
                  background: testingTool === tool.name ? 'var(--hc-accent-subtle)' : 'transparent',
                }"
                @click.stop="openTestForm(tool.name)"
              >
                <Play :size="11" />
                {{ t('mcp.testTool') }}
              </button>
              <span class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">
                {{ expandedTool === tool.name ? '▲' : '▼' }}
              </span>
            </div>

            <!-- Expanded schema view -->
            <div
              v-if="expandedTool === tool.name && tool.input_schema"
              class="px-4 pb-4 border-t"
              :style="{ borderColor: 'var(--hc-border)' }"
            >
              <pre class="text-xs mt-3 p-3 rounded-lg overflow-x-auto" :style="{ background: 'var(--hc-bg-main)', color: 'var(--hc-text-secondary)' }">{{ JSON.stringify(tool.input_schema, null, 2) }}</pre>
            </div>

            <!-- Test form -->
            <div
              v-if="testingTool === tool.name"
              class="px-4 pb-4 border-t"
              :style="{ borderColor: 'var(--hc-border)' }"
            >
              <div class="mt-3 space-y-2">
                <div class="text-xs font-medium" :style="{ color: 'var(--hc-text-primary)' }">
                  {{ t('mcp.testToolTitle') }}: {{ tool.name }}
                </div>

                <!-- Parameter inputs from schema -->
                <div
                  v-for="prop in getSchemaProperties(tool)"
                  :key="prop.key"
                  class="flex flex-col gap-1"
                >
                  <label class="text-[10px] font-medium flex items-center gap-1" :style="{ color: 'var(--hc-text-muted)' }">
                    {{ prop.key }}
                    <span class="text-[9px] px-1 rounded" :style="{ background: 'var(--hc-bg-hover)', color: 'var(--hc-text-muted)' }">{{ prop.type }}</span>
                    <span v-if="prop.required" class="text-red-400">*</span>
                  </label>
                  <input
                    v-model="testParams[prop.key]"
                    type="text"
                    class="w-full px-2.5 py-1.5 rounded-lg text-xs border outline-none transition-colors"
                    :style="{ background: 'var(--hc-bg-main)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
                    :placeholder="prop.description || prop.key"
                  />
                </div>

                <!-- If no schema properties, show generic key-value -->
                <div v-if="getSchemaProperties(tool).length === 0" class="text-xs" :style="{ color: 'var(--hc-text-muted)' }">
                  {{ t('mcp.noParams') }}
                </div>

                <!-- Execute button -->
                <button
                  class="flex items-center justify-center gap-1.5 w-full px-3 py-1.5 rounded-lg text-xs font-medium text-white transition-colors"
                  :style="{ background: isTestRunning(tool.name) ? 'var(--hc-text-muted)' : 'var(--hc-accent)' }"
                  :disabled="isTestRunning(tool.name)"
                  @click="executeTest(tool.name)"
                >
                  <Loader2 v-if="isTestRunning(tool.name)" :size="12" class="animate-spin" />
                  <Play v-else :size="12" />
                  {{ isTestRunning(tool.name) ? t('mcp.testing') : t('mcp.testExecute') }}
                </button>

                <!-- Test result -->
                <div v-if="testResult" class="mt-2">
                  <div v-if="testResult.error" class="rounded-lg p-3" style="background: #ef444410;">
                    <div class="flex items-center gap-1.5 mb-1">
                      <CircleX :size="12" style="color: #ef4444;" />
                      <span class="text-xs font-medium" style="color: #ef4444;">{{ t('mcp.testError') }}</span>
                    </div>
                    <pre class="text-xs whitespace-pre-wrap" style="color: #ef4444;">{{ testResult.error }}</pre>
                  </div>
                  <div v-if="testResult.output !== undefined" class="rounded-lg p-3" :style="{ background: 'var(--hc-bg-main)' }">
                    <div class="flex items-center gap-1.5 mb-1">
                      <CircleCheck :size="12" style="color: #10b981;" />
                      <span class="text-xs font-medium" :style="{ color: 'var(--hc-text-primary)' }">{{ t('mcp.testResult') }}</span>
                    </div>
                    <pre class="text-xs whitespace-pre-wrap overflow-x-auto" :style="{ color: 'var(--hc-text-secondary)' }">{{ typeof testResult.output === 'string' ? testResult.output : JSON.stringify(testResult.output, null, 2) }}</pre>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- Marketplace Tab -->
      <template v-else-if="activeTab === 'marketplace'">
        <div class="p-4">
          <div class="flex gap-2 mb-4">
            <div class="relative flex-1">
              <Search :size="14" class="absolute left-3 top-1/2 -translate-y-1/2" style="color: var(--hc-text-tertiary)" />
              <input
                v-model="marketplaceSearch"
                class="w-full pl-9 pr-3 py-2 rounded-lg text-sm border"
                :style="{ background: 'var(--hc-bg-secondary)', borderColor: 'var(--hc-border)' }"
                :placeholder="t('mcp.searchMarketplace', 'Search MCP servers...')"
                @keydown.enter="loadMarketplace"
              />
            </div>
            <button class="px-3 py-2 rounded-lg text-sm font-medium text-white" :style="{ background: 'var(--hc-accent)' }" @click="loadMarketplace">
              <Search :size="14" />
            </button>
          </div>
          <div v-if="marketplaceLoading" class="text-center py-8">
            <Loader2 :size="20" class="animate-spin mx-auto" style="color: var(--hc-accent)" />
          </div>
          <div v-else-if="marketplaceItems.length === 0" class="text-center py-8" style="color: var(--hc-text-secondary)">
            {{ t('mcp.noMarketplaceResults', 'No MCP servers found. Try a different search.') }}
          </div>
          <div v-else class="space-y-3">
            <div v-for="item in marketplaceItems" :key="item.name" class="p-3 rounded-lg border" :style="{ borderColor: 'var(--hc-border)', background: 'var(--hc-bg-secondary)' }">
              <div class="flex items-center justify-between mb-1">
                <div class="flex items-center gap-2">
                  <Server :size="14" style="color: var(--hc-accent)" />
                  <span class="font-medium text-sm">{{ item.display_name || item.name }}</span>
                  <span v-if="item.category" class="px-1.5 py-0.5 rounded text-xs" style="background: var(--hc-bg-tertiary)">{{ item.category }}</span>
                </div>
                <button
                  class="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium text-white"
                  :style="{ background: servers.includes(item.name) ? 'var(--hc-text-tertiary)' : 'var(--hc-accent)' }"
                  :disabled="servers.includes(item.name) || installingServers.has(item.name)"
                  @click="installFromMarketplace(item)"
                >
                  <Loader2 v-if="installingServers.has(item.name)" :size="12" class="animate-spin" />
                  <Download v-else :size="12" />
                  {{ servers.includes(item.name) ? t('mcp.installed', 'Installed') : t('mcp.install', 'Install') }}
                </button>
              </div>
              <p class="text-xs mb-1" style="color: var(--hc-text-secondary)">{{ item.description }}</p>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- 添加 MCP 服务器对话框 -->
    <Teleport to="body">
      <div v-if="showAddServer" class="fixed inset-0 z-50 flex items-center justify-center" style="background: rgba(0,0,0,0.45); backdrop-filter: blur(4px);" @click.self="closeAddServer">
        <div class="w-full max-w-md rounded-xl border shadow-lg overflow-hidden" :style="{ background: 'var(--hc-bg-elevated)', borderColor: 'var(--hc-border)' }">
          <div class="flex items-center justify-between px-5 py-4 border-b" :style="{ borderColor: 'var(--hc-border)' }">
            <h2 class="text-[15px] font-semibold m-0" :style="{ color: 'var(--hc-text-primary)' }">{{ t('mcpManage.addServerTitle') }}</h2>
            <button class="p-1 rounded-md hover:bg-white/5" :style="{ color: 'var(--hc-text-muted)' }" @click="closeAddServer">
              <X :size="17" />
            </button>
          </div>
          <div class="p-5 flex flex-col gap-3.5">
            <div class="flex flex-col gap-1.5">
              <label class="text-[13px] font-medium" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('mcpManage.serverName') }}</label>
              <input v-model="newServerName" type="text" class="rounded-lg border px-3 py-2 text-sm outline-none" :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }" :placeholder="t('mcpManage.serverNamePlaceholder')" />
            </div>
            <div class="flex flex-col gap-1.5">
              <label class="text-[13px] font-medium" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('mcpManage.serverCommand') }}</label>
              <input v-model="newServerCommand" type="text" class="rounded-lg border px-3 py-2 text-sm outline-none" :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }" :placeholder="t('mcpManage.serverCommandPlaceholder')" />
            </div>
            <div class="flex flex-col gap-1.5">
              <label class="text-[13px] font-medium" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('mcpManage.serverArgs') }}</label>
              <input v-model="newServerArgs" type="text" class="rounded-lg border px-3 py-2 text-sm outline-none" :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }" :placeholder="t('mcpManage.serverArgsPlaceholder')" />
            </div>
          </div>
          <div class="flex items-center justify-end gap-2 px-5 py-3.5 border-t" :style="{ borderColor: 'var(--hc-border)' }">
            <button class="px-3 py-1.5 rounded-lg text-sm font-medium" :style="{ color: 'var(--hc-text-secondary)', background: 'var(--hc-bg-hover)' }" @click="closeAddServer">{{ t('common.cancel') }}</button>
            <button class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium text-white" :style="{ background: 'var(--hc-accent)', opacity: (!newServerName.trim() || !newServerCommand.trim()) ? 0.4 : 1 }" :disabled="!newServerName.trim() || !newServerCommand.trim() || addingServer" @click="handleAddServer">
              <Loader2 v-if="addingServer" :size="14" class="animate-spin" />
              <Plus v-else :size="14" />
              {{ t('common.create') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
