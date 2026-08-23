<script setup lang="ts">
import { onMounted, ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import {
  Server,
  Wrench,
  Play,
  Loader2,
  CircleCheck,
  CircleX,
  Plus,
  X,
  Download,
} from 'lucide-vue-next'
import {
  getMcpServers,
  getMcpTools,
  callMcpTool,
  getMcpServerStatus,
  addMcpServer,
  removeMcpServer,
  restartMcpServer,
  getMcpMarketplace,
  type McpMarketplaceEntry,
} from '@/api/mcp'
import { useToast } from '@/composables/useToast'
import UnderlineTabs from '@/components/common/UnderlineTabs.vue'
import { installFromHub } from '@/api/skills'
import { resolveUserHome } from '@/utils/platform'
import type { McpServer, McpServerListItem, McpTool } from '@/types/mcp'
import EmptyState from '@/components/common/EmptyState.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import HcSelect from '@/components/common/HcSelect.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'

const { t } = useI18n()
const router = useRouter()

const props = withDefaults(
  defineProps<{
    embeddedSearch?: string
  }>(),
  {
    embeddedSearch: undefined,
  },
)
const emit = defineEmits<{
  'search-context-change': [context: 'mcp-servers' | 'mcp-tools' | 'mcp-marketplace']
}>()

// 服务器名称仍作为列表事实源，描述等内容由同一次 API 返回的结构化项旁路保存；
// 这样既兼容旧版 string[] 响应，也不会让页面为旧响应臆造描述。
const servers = ref<string[]>([])
const serverDetails = ref<Record<string, McpServerListItem>>({})
type McpServerStatus = McpServer['status']
const serverStatuses = ref<Record<string, McpServerStatus>>({})
const tools = ref<McpTool[]>([])
const loading = ref(true)
const errorMsg = ref('')
const activeTab = ref<'servers' | 'tools' | 'marketplace'>('servers')
watch(
  activeTab,
  (tab) =>
    emit(
      'search-context-change',
      tab === 'marketplace' ? 'mcp-marketplace' : tab === 'tools' ? 'mcp-tools' : 'mcp-servers',
    ),
  { immediate: true },
)

// 二级 tab（统一 UnderlineTabs）：服务器 / 工具 / 市场（带计数）
const mcpSubTabs = computed(() => [
  { key: 'servers', label: t('mcp.servers'), count: servers.value.length },
  { key: 'tools', label: t('mcp.tools'), count: tools.value.length },
  // 市场计数 = 已加载的市场条目数（懒加载，未进入市场 tab 前为 0，0 时 UnderlineTabs 自动隐藏，
  // 与 Skills 市场 tab 一致）。
  {
    key: 'marketplace',
    label: t('mcp.marketplace', 'Marketplace'),
    count: marketplaceItems.value.length,
  },
])
function onMcpTabChange(key: string) {
  activeTab.value = key as 'servers' | 'tools' | 'marketplace'
  // 市场已在 onMounted 预读（tab 标签即显总条数）；仅在尚未加载时才补拉，避免重复请求。
  if (key === 'marketplace' && marketplaceItems.value.length === 0 && !marketplaceLoading.value)
    loadMarketplace()
}

// ─── 市场分类 pill（精选 pill → hub 分类集合 的展示映射；统一渲染后端 hub 市场，客户端过滤）──
interface McpPill {
  key: string
  label: string
  /** 命中的 hub 分类集合；null = 全部 */
  cats: string[] | null
}
const MCP_PILLS: McpPill[] = [
  { key: 'all', label: t('mcp.cat.all', '全部'), cats: null },
  { key: 'finance', label: t('mcp.cat.finance', '金融'), cats: ['finance'] },
  {
    key: 'dev',
    label: t('mcp.cat.dev', '开发'),
    cats: ['development', 'system', 'devops', 'cloud', 'monitoring'],
  },
  { key: 'data', label: t('mcp.cat.data', '数据'), cats: ['database', 'memory', 'reasoning'] },
  { key: 'search', label: t('mcp.cat.search', '搜索'), cats: ['search', 'web'] },
  { key: 'browser', label: t('mcp.cat.browser', '浏览器'), cats: ['automation'] },
  { key: 'collab', label: t('mcp.cat.collab', '协作'), cats: ['communication'] },
  { key: 'docs', label: t('mcp.cat.docs', '文档'), cats: ['documentation', 'office'] },
  { key: 'productivity', label: t('mcp.cat.productivity', '效率'), cats: ['productivity'] },
  { key: 'edu', label: t('mcp.cat.edu', '教育'), cats: ['education'] },
  { key: 'media', label: t('mcp.cat.media', '媒体'), cats: ['media', 'video'] },
  { key: 'utility', label: t('mcp.cat.utility', '工具'), cats: ['utility', 'geo', 'automotive'] },
]
const marketplaceCategory = ref<string>('all')

// 选中 pill 命中的 hub 分类集合（null=全部）
const activeMcpCats = computed(
  () => MCP_PILLS.find((p) => p.key === marketplaceCategory.value)?.cats ?? null,
)

// 统一后的市场列表：原硬编码"推荐区"已删除，直接按 pill 分类 + 搜索词客户端过滤后端 hub 列表
const filteredMarketplace = computed(() => {
  const cats = activeMcpCats.value
  const q = (props.embeddedSearch ?? toolSearchQuery.value).trim().toLowerCase()
  return marketplaceItems.value.filter((item) => {
    if (cats && !cats.includes((item.category || '').toLowerCase())) return false
    if (!q) return true
    return (
      (item.display_name || item.name).toLowerCase().includes(q) ||
      item.name.toLowerCase().includes(q) ||
      (item.description || '').toLowerCase().includes(q) ||
      (item.tags || []).some((tg) => tg.toLowerCase().includes(q))
    )
  })
})

// ─── MCP Marketplace state ──────────────────────────────
const marketplaceItems = ref<McpMarketplaceEntry[]>([])
const marketplaceLoading = ref(false)
const installingServers = ref<Set<string>>(new Set())
let marketplaceRequestGen = 0
let loadAllRequestGen = 0
let statusRequestGen = 0

async function loadMarketplace(opts?: { silent?: boolean }) {
  // silent=true（onMounted 预读总条数）：只填充列表/计数，不动共享 errorMsg，
  // 避免在「服务器」tab 上把市场加载错误误显，也不清掉服务器/工具的加载错误。
  const silent = opts?.silent === true
  const requestGen = ++marketplaceRequestGen
  marketplaceLoading.value = true
  if (!silent) errorMsg.value = ''
  try {
    // 一次拉全量 hub 列表，分类 pill + 搜索词改为 filteredMarketplace 客户端过滤
    const res = await getMcpMarketplace()
    if (requestGen !== marketplaceRequestGen) return
    marketplaceItems.value = res.skills || []
  } catch (e) {
    if (requestGen !== marketplaceRequestGen) return
    console.error('Failed to load MCP marketplace:', e)
    if (!silent) errorMsg.value = e instanceof Error ? e.message : 'Failed to load marketplace'
    marketplaceItems.value = []
  } finally {
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
      if (args.some((a) => a.includes('server-filesystem'))) {
        const hasPath = args.some(
          (a) => a.startsWith('/') || a.startsWith('~') || /^[A-Z]:\\/i.test(a),
        )
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
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : 'Install failed'
  } finally {
    const nextInstalling = new Set(installingServers.value)
    nextInstalling.delete(entry.name)
    installingServers.value = nextInstalling
  }
}
const toolSearchQuery = ref('')

// ─── Tool testing state ──────────────────────────────
const testingTool = ref<string | null>(null)
const testParams = ref<Record<string, string>>({})
const testRunningTools = ref<Set<string>>(new Set())
const testResult = ref<{ output?: unknown; error?: string } | null>(null)

onMounted(async () => {
  await loadAll()
  // 进入页面即后台预读市场目录，使「市场」tab 标签直接显示总条数，无需点开市场 tab。
  // silent：预读失败不污染共享 errorMsg（真正点开市场 tab 时才按需补拉并显错）。
  void loadMarketplace({ silent: true })
})

watch(activeTab, () => {
  errorMsg.value = ''
})

function setOptimisticStatuses(nextServers: string[]) {
  const statuses: Record<string, McpServerStatus> = {}
  for (const server of nextServers) {
    const detail = serverDetails.value[server]
    statuses[server] = detail?.status ?? (detail?.connected === false ? 'disconnected' : 'connected')
  }
  serverStatuses.value = statuses
}

function normalizeServerList(items: Array<string | McpServerListItem>): {
  names: string[]
  details: Record<string, McpServerListItem>
} {
  const names: string[] = []
  const details: Record<string, McpServerListItem> = {}
  for (const item of items) {
    const name = typeof item === 'string' ? item : item.name
    if (!name || names.includes(name)) continue
    names.push(name)
    if (typeof item !== 'string') details[name] = item
  }
  return { names, details }
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
    const normalized = normalizeServerList(srvRes.servers || [])
    servers.value = normalized.names
    serverDetails.value = normalized.details
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

const expandedTools = ref<Set<string>>(new Set())
// 保留旧的单值暴露，兼容既有测试/调用方；实际展开状态由 Set 维护。
const expandedTool = computed(() => expandedTools.value.values().next().value ?? null)

function isToolExpanded(name: string): boolean {
  return expandedTools.value.has(name)
}

function toggleTool(name: string) {
  const next = new Set(expandedTools.value)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  expandedTools.value = next
  // Close test form when collapsing
  if (!next.has(name) && testingTool.value === name) {
    testingTool.value = null
    testResult.value = null
  }
}

// ─── 顶栏统一搜索（IntegrationView 注入）；本地 toolSearchQuery 作为兜底 ───
const activeQuery = computed(() =>
  (props.embeddedSearch ?? toolSearchQuery.value).trim().toLowerCase(),
)

// 服务器列表过滤（按名称）
const filteredServers = computed(() => {
  const q = activeQuery.value
  if (!q) return servers.value
  return servers.value.filter((name) => name.toLowerCase().includes(q))
})

// ─── Tool search ─────────────────────────────────────
const filteredTools = computed(() => {
  const q = activeQuery.value
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

function getSchemaProperties(
  tool: McpTool,
): Array<{ key: string; type: string; description: string; required: boolean }> {
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

function getServerStatus(name: string): McpServerStatus {
  return serverStatuses.value[name] || 'disconnected'
}

function getServerStatusLabel(name: string): string {
  const status = getServerStatus(name)
  if (status === 'connected') return t('mcp.serverConnected')
  if (status === 'pending_authorization') return t('mcp.serverPendingAuthorization')
  return t('mcp.serverDisconnected')
}

function getServerDescription(name: string): string | undefined {
  const description = serverDetails.value[name]?.description
  return typeof description === 'string' && description.trim() ? description : undefined
}

function getStaticInputEntries(tool: McpTool): Array<{ key: string; value: string }> {
  const schema = tool.input_schema as Record<string, unknown> | undefined
  const properties = schema?.properties as Record<string, Record<string, unknown>> | undefined
  if (!properties) return []

  const entries: Array<{ key: string; value: string }> = []
  for (const [key, property] of Object.entries(properties)) {
    if (!property || typeof property !== 'object') continue
    // `default` 属于 schema 事实；只有显式 `example` 才是原型中的静态示例输入。
    // 不把默认值误投影成可填写的测试输入，测试表单仍由“测试”动作独立打开。
    const example = property.example
    if (example === undefined) continue
    entries.push({
      key,
      value: typeof example === 'string' ? example : JSON.stringify(example),
    })
  }
  return entries
}

function getStaticSchema(tool: McpTool): Record<string, unknown> {
  const schema = tool.input_schema as Record<string, unknown> | undefined
  const properties = schema?.properties
  if (!properties || typeof properties !== 'object') return {}

  // 示例值只属于原型中的静态输入，不属于 schema 事实；展示 schema 时剥离它。
  return Object.fromEntries(
    Object.entries(properties as Record<string, unknown>).map(([key, value]) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [key, value]
      const schemaProperty = { ...(value as Record<string, unknown>) }
      delete schemaProperty.example
      return [key, schemaProperty]
    }),
  )
}

// ─── Server management ──────────────────────────────
const showAddServer = ref(false)
const newServerName = ref('')
const newServerCommand = ref('')
const newServerArgs = ref('')
const newServerTransport = ref<'stdio' | 'sse' | 'streamable'>('stdio')
// transport 下拉走 HcSelect（原生 select 在 WKWebView 显 macOS Aqua 样式 · BUG-20260708 B6）
const transportOptions = computed(() => [
  { value: 'stdio', label: t('mcpManage.transportStdio') },
  { value: 'sse', label: t('mcpManage.transportSse') },
  { value: 'streamable', label: t('mcpManage.transportStreamable') },
])
const newServerEndpoint = ref('')
const addingServer = ref(false)
const removingServers = ref<Set<string>>(new Set())
const pendingRemoveServer = ref<string | null>(null)
// M3-20260710：单服务器重启（stdio 进程僵死/外部依赖变更后手动拉起）
const toast = useToast()
const restartingServers = ref<Set<string>>(new Set())
async function handleRestartServer(name: string) {
  if (restartingServers.value.has(name)) return
  restartingServers.value = new Set(restartingServers.value).add(name)
  try {
    await restartMcpServer(name)
    toast.success(t('mcpManage.restarted', { name }))
    await loadAll()
  } catch (e) {
    toast.error(e instanceof Error ? e.message : t('mcpManage.restartFailed'))
  } finally {
    const next = new Set(restartingServers.value)
    next.delete(name)
    restartingServers.value = next
  }
}

// stdio 需要 command；sse/streamable 需要 endpoint —— 与后端校验对齐。
const addServerValid = computed(() => {
  if (!newServerName.value.trim()) return false
  return newServerTransport.value === 'stdio'
    ? !!newServerCommand.value.trim()
    : !!newServerEndpoint.value.trim()
})

function resetAddServerForm() {
  newServerName.value = ''
  newServerCommand.value = ''
  newServerArgs.value = ''
  newServerTransport.value = 'stdio'
  newServerEndpoint.value = ''
}

function closeAddServer() {
  showAddServer.value = false
  errorMsg.value = ''
  resetAddServerForm()
}

async function handleAddServer() {
  if (addingServer.value) return
  if (!addServerValid.value) return
  addingServer.value = true
  errorMsg.value = ''
  try {
    const isStdio = newServerTransport.value === 'stdio'
    const args =
      isStdio && newServerArgs.value.trim() ? newServerArgs.value.trim().split(/\s+/) : undefined
    await addMcpServer(
      newServerName.value.trim(),
      isStdio ? newServerCommand.value.trim() : '',
      args,
      {
        transport: newServerTransport.value,
        endpoint: isStdio ? undefined : newServerEndpoint.value.trim(),
      },
    )
    closeAddServer()
    await loadAll()
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : '添加服务器失败'
  } finally {
    addingServer.value = false
  }
}

async function confirmRemoveServer() {
  const name = pendingRemoveServer.value
  if (!name) return
  if (removingServers.value.has(name)) return
  pendingRemoveServer.value = null
  const nextRemoving = new Set(removingServers.value)
  nextRemoving.add(name)
  removingServers.value = nextRemoving
  errorMsg.value = ''
  try {
    await removeMcpServer(name)
    servers.value = servers.value.filter((s) => s !== name)
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

defineExpose({ openAddServer, switchToMarketplace, expandedTool })
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <!-- 错误提示 -->
    <div
      v-if="errorMsg"
      class="mx-6 mt-2 px-4 py-2 rounded-lg text-sm flex items-center justify-between"
      style="background: #ef444420; color: #ef4444"
    >
      <span>{{ errorMsg }}</span>
      <button class="text-xs underline ml-4" @click="errorMsg = ''">{{ t('common.close') }}</button>
    </div>

    <!-- 二级 tab：服务器 / 工具 / 市场（统一 UnderlineTabs，滑动下划线） -->
    <div class="px-6 pt-3">
      <UnderlineTabs
        :tabs="mcpSubTabs"
        :model-value="activeTab"
        @update:model-value="onMcpTabChange"
      />
    </div>

    <div class="flex-1 overflow-y-auto hc-capability-content-pad">
      <LoadingState v-if="loading" />

      <!-- 服务器列表 -->
      <template v-else-if="activeTab === 'servers'">
        <EmptyState
          v-if="filteredServers.length === 0"
          :icon="Server"
          :title="t('common.noData')"
          :description="t('mcp.emptyDesc')"
        />

        <div v-else class="hc-capability-installed-track hc-capability-installed-track--mcp">
          <div
            v-for="name in filteredServers"
            :key="name"
            class="hc-capability-installed-row hc-capability-installed-row--mcp"
          >
            <div
              class="hc-capability-installed-main hc-capability-installed-main--row hc-capability-installed-main--mcp-server"
            >
              <div class="hc-capability-installed-icon hc-capability-installed-icon--mcp-server" aria-hidden="true">
                <Server :size="18" :style="{ color: 'var(--hc-accent)' }" />
              </div>
              <div class="flex-1 min-w-0">
                <div class="hc-capability-installed-server-name">
                  {{ name }}
                </div>
                <div
                  v-if="getServerDescription(name)"
                  data-mcp-description
                  class="hc-capability-installed-server-description"
                >
                  {{ getServerDescription(name) }}
                </div>
              </div>
            </div>
            <div class="hc-capability-installed-actions hc-capability-installed-actions--mcp-server">
              <span
                class="hc-capability-installed-mcp-status"
                :class="{
                  'hc-capability-installed-mcp-status--connected': getServerStatus(name) === 'connected',
                  'hc-capability-installed-mcp-status--pending': getServerStatus(name) === 'pending_authorization',
                  'hc-capability-installed-mcp-status--error': getServerStatus(name) === 'error',
                  'hc-capability-installed-mcp-status--disconnected':
                    getServerStatus(name) === 'disconnected',
                }"
                :data-testid="`mcp-server-status-${name}`"
                :title="getServerStatusLabel(name)"
              >
                {{ getServerStatusLabel(name) }}
              </span>
              <button
                v-if="getServerStatus(name) === 'pending_authorization'"
                class="btn flex-shrink-0"
                :data-testid="`mcp-server-authorize-${name}`"
                :style="{ color: 'var(--hc-accent)' }"
                :title="t('mcpManage.authorizeServer', '去设置授权')"
                @click="router.push('/settings')"
              >
                <span>{{ t('mcpManage.authorizeServer', '去设置授权') }}</span>
              </button>
              <button
                v-if="getServerStatus(name) === 'connected'"
                class="btn flex-shrink-0"
                data-testid="mcp-server-restart"
                :disabled="restartingServers.has(name)"
                :style="{ color: 'var(--hc-text-muted)' }"
                :title="t('mcpManage.restartServer', '重启')"
                @click="handleRestartServer(name)"
              >
                <Loader2 v-if="restartingServers.has(name)" :size="14" class="animate-spin" />
                <span>{{ t('mcpManage.restartServer', '重启') }}</span>
              </button>
              <button
                class="btn btn-ghost flex-shrink-0"
                :disabled="removingServers.has(name)"
                :style="{ color: 'var(--hc-text-muted)' }"
                :title="t('mcpManage.removeServer', '删除')"
                @click="pendingRemoveServer = name"
              >
                <span>{{ t('mcpManage.removeServer', '删除') }}</span>
              </button>
            </div>
          </div>
        </div>
      </template>

      <!-- 工具列表（搜索统一由顶栏搜索框驱动） -->
      <template v-else-if="activeTab === 'tools'">
        <EmptyState
          v-if="filteredTools.length === 0"
          :icon="Wrench"
          :title="t('common.noData')"
          :description="t('mcp.noTools')"
        />

        <div v-else class="hc-capability-installed-track hc-capability-installed-track--mcp">
          <div
            v-for="tool in filteredTools"
            :key="tool.name"
            class="hc-capability-installed-row hc-capability-installed-row--tool overflow-hidden"
          >
            <div
              class="hc-capability-installed-main hc-capability-installed-main--mcp-tool"
              @click="toggleTool(tool.name)"
            >
              <div class="hc-capability-installed-tool-name">{{ tool.name }}</div>
              <p v-if="tool.description" class="hc-capability-installed-tool-description">
                {{ tool.description }}
              </p>

              <!-- 静态 schema/input 属于工具主内容；测试表单仍由下方独立展开面板承载。 -->
              <template v-if="tool.input_schema">
                <pre
                  class="hc-capability-installed-schema"
                  @click.stop
                  >{{ JSON.stringify(getStaticSchema(tool)) }}</pre
                >
                <div
                  v-for="entry in getStaticInputEntries(tool)"
                  :key="entry.key"
                  data-mcp-static-input
                  class="hc-capability-installed-static-input-wrapper"
                  @click.stop
                >
                  <input
                    :value="entry.value"
                    :aria-label="`${tool.name} ${entry.key}`"
                    class="hc-capability-installed-static-input"
                  />
                </div>
              </template>
            </div>
            <div class="hc-capability-installed-actions">
              <!-- Test button -->
              <button
                class="btn flex-shrink-0"
                @click.stop="openTestForm(tool.name)"
              >
                {{ t('mcp.testTool') }}
              </button>
            </div>

            <!-- Test form -->
            <div
              v-if="testingTool === tool.name"
              class="hc-capability-installed-expanded px-4 pb-4 border-t"
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
                  <label
                    class="text-[10px] font-medium flex items-center gap-1"
                    :style="{ color: 'var(--hc-text-muted)' }"
                  >
                    {{ prop.key }}
                    <span
                      class="text-[9px] px-1 rounded"
                      :style="{ background: 'var(--hc-bg-hover)', color: 'var(--hc-text-muted)' }"
                      >{{ prop.type }}</span
                    >
                    <span v-if="prop.required" class="text-red-400">*</span>
                  </label>
                  <HcClearableField>
                    <input
                      v-model="testParams[prop.key]"
                      type="text"
                      class="w-full px-2.5 py-1.5 rounded-lg text-xs border outline-none transition-colors"
                      :style="{
                        background: 'var(--hc-bg-main)',
                        borderColor: 'var(--hc-border)',
                        color: 'var(--hc-text-primary)',
                      }"
                      :placeholder="prop.description || prop.key"
                    />
                  </HcClearableField>
                </div>

                <!-- If no schema properties, show generic key-value -->
                <div
                  v-if="getSchemaProperties(tool).length === 0"
                  class="text-xs"
                  :style="{ color: 'var(--hc-text-muted)' }"
                >
                  {{ t('mcp.noParams') }}
                </div>

                <!-- Execute button -->
                <button
                  class="flex items-center justify-center gap-1.5 w-full px-3 py-1.5 rounded-lg text-xs font-medium text-white transition-colors"
                  :style="{
                    background: isTestRunning(tool.name)
                      ? 'var(--hc-text-muted)'
                      : 'var(--hc-accent)',
                  }"
                  :disabled="isTestRunning(tool.name)"
                  @click="executeTest(tool.name)"
                >
                  <Loader2 v-if="isTestRunning(tool.name)" :size="12" class="animate-spin" />
                  <Play v-else :size="12" />
                  {{ isTestRunning(tool.name) ? t('mcp.testing') : t('mcp.testExecute') }}
                </button>

                <!-- Test result -->
                <div v-if="testResult" class="mt-2">
                  <div v-if="testResult.error" class="rounded-lg p-3" style="background: #ef444410">
                    <div class="flex items-center gap-1.5 mb-1">
                      <CircleX :size="12" style="color: #ef4444" />
                      <span class="text-xs font-medium" style="color: #ef4444">{{
                        t('mcp.testError')
                      }}</span>
                    </div>
                    <pre class="text-xs whitespace-pre-wrap" style="color: #ef4444">{{
                      testResult.error
                    }}</pre>
                  </div>
                  <div
                    v-if="testResult.output !== undefined"
                    class="rounded-lg p-3"
                    :style="{ background: 'var(--hc-bg-main)' }"
                  >
                    <div class="flex items-center gap-1.5 mb-1">
                      <CircleCheck :size="12" style="color: #10b981" />
                      <span
                        class="text-xs font-medium"
                        :style="{ color: 'var(--hc-text-primary)' }"
                        >{{ t('mcp.testResult') }}</span
                      >
                    </div>
                    <pre
                      class="text-xs whitespace-pre-wrap overflow-x-auto"
                      :style="{ color: 'var(--hc-text-secondary)' }"
                      >{{
                        typeof testResult.output === 'string'
                          ? testResult.output
                          : JSON.stringify(testResult.output, null, 2)
                      }}</pre
                    >
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- Marketplace Tab -->
      <template v-else-if="activeTab === 'marketplace'">
        <div class="hc-capability-market-surface">
          <!-- 分类 pill（视觉/交互照搬 Skill 市场分类 pill）-->
          <div class="flex flex-wrap gap-2 mb-5 max-w-4xl">
            <button
              v-for="pill in MCP_PILLS"
              :key="pill.key"
              class="px-3 py-1 rounded-full text-xs font-medium transition-colors"
              :style="{
                background:
                  marketplaceCategory === pill.key ? 'var(--hc-accent)' : 'var(--hc-bg-hover)',
                color: marketplaceCategory === pill.key ? '#fff' : 'var(--hc-text-secondary)',
              }"
              @click="marketplaceCategory = pill.key"
            >
              {{ pill.label }}
            </button>
          </div>

          <div v-if="marketplaceLoading" class="text-center py-8">
            <Loader2 :size="20" class="animate-spin mx-auto" style="color: var(--hc-accent)" />
          </div>
          <div
            v-else-if="filteredMarketplace.length === 0"
            class="text-center py-8"
            style="color: var(--hc-text-secondary)"
          >
            {{ t('mcp.noMarketplaceResults', 'No MCP servers found. Try a different search.') }}
          </div>
          <div v-else class="hc-capability-market-grid">
            <div v-for="item in filteredMarketplace" :key="item.name" class="hc-mcp-market-card">
              <div class="hc-mcp-market-card__head">
                <span class="hc-mcp-market-card__icon" aria-hidden="true">
                  <Server :size="16" />
                </span>
                <div class="hc-mcp-market-card__identity">
                  <strong :title="item.display_name || item.name">{{
                    item.display_name || item.name
                  }}</strong>
                  <span v-if="item.category">{{ item.category }}</span>
                </div>
              </div>
              <p class="hc-mcp-market-card__description">{{ item.description }}</p>
              <p v-if="item.config_hint" class="hc-mcp-market-card__config">
                {{ t('mcp.needsConfig', '需配置') }}: {{ item.config_hint }}
              </p>
              <button
                class="hc-mcp-market-card__install"
                :class="{ 'hc-mcp-market-card__install--installed': servers.includes(item.name) }"
                :disabled="servers.includes(item.name) || installingServers.has(item.name)"
                @click="installFromMarketplace(item)"
              >
                <Loader2 v-if="installingServers.has(item.name)" :size="12" class="animate-spin" />
                <Download v-else :size="12" />
                {{
                  servers.includes(item.name)
                    ? t('mcp.installed', 'Installed')
                    : t('mcp.install', 'Install')
                }}
              </button>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- 添加 MCP 服务器对话框 -->
    <Teleport to="body">
      <div
        v-if="showAddServer"
        class="fixed inset-0 z-50 flex items-center justify-center"
        style="background: rgba(0, 0, 0, 0.45); backdrop-filter: blur(4px)"
        @click.self="closeAddServer"
      >
        <div
          class="w-full max-w-md rounded-xl border shadow-lg overflow-hidden"
          :style="{ background: 'var(--hc-bg-elevated)', borderColor: 'var(--hc-border)' }"
        >
          <div
            class="flex items-center justify-between px-5 py-4 border-b"
            :style="{ borderColor: 'var(--hc-border)' }"
          >
            <h2 class="text-[15px] font-semibold m-0" :style="{ color: 'var(--hc-text-primary)' }">
              {{ t('mcpManage.addServerTitle') }}
            </h2>
            <button
              class="p-1 rounded-md hover:bg-white/5"
              :style="{ color: 'var(--hc-text-muted)' }"
              @click="closeAddServer"
            >
              <X :size="17" />
            </button>
          </div>
          <div class="p-5 flex flex-col gap-3.5">
            <div class="flex flex-col gap-1.5">
              <label
                class="text-[13px] font-medium"
                :style="{ color: 'var(--hc-text-secondary)' }"
                >{{ t('mcpManage.serverName') }}</label
              >
              <HcClearableField>
                <input
                  v-model="newServerName"
                  type="text"
                  class="rounded-lg border px-3 py-2 text-sm outline-none"
                  :style="{
                    background: 'var(--hc-bg-input)',
                    borderColor: 'var(--hc-border)',
                    color: 'var(--hc-text-primary)',
                  }"
                  :placeholder="t('mcpManage.serverNamePlaceholder')"
                />
              </HcClearableField>
            </div>
            <div class="flex flex-col gap-1.5">
              <label
                class="text-[13px] font-medium"
                :style="{ color: 'var(--hc-text-secondary)' }"
                >{{ t('mcpManage.transport') }}</label
              >
              <HcSelect
                :model-value="newServerTransport"
                :options="transportOptions"
                @update:model-value="
                  (v) => (newServerTransport = v as 'stdio' | 'sse' | 'streamable')
                "
              />
            </div>
            <template v-if="newServerTransport === 'stdio'">
              <div class="flex flex-col gap-1.5">
                <label
                  class="text-[13px] font-medium"
                  :style="{ color: 'var(--hc-text-secondary)' }"
                  >{{ t('mcpManage.serverCommand') }}</label
                >
                <HcClearableField>
                  <input
                    v-model="newServerCommand"
                    type="text"
                    class="rounded-lg border px-3 py-2 text-sm outline-none"
                    :style="{
                      background: 'var(--hc-bg-input)',
                      borderColor: 'var(--hc-border)',
                      color: 'var(--hc-text-primary)',
                    }"
                    :placeholder="t('mcpManage.serverCommandPlaceholder')"
                  />
                </HcClearableField>
              </div>
              <div class="flex flex-col gap-1.5">
                <label
                  class="text-[13px] font-medium"
                  :style="{ color: 'var(--hc-text-secondary)' }"
                  >{{ t('mcpManage.serverArgs') }}</label
                >
                <HcClearableField>
                  <input
                    v-model="newServerArgs"
                    type="text"
                    class="rounded-lg border px-3 py-2 text-sm outline-none"
                    :style="{
                      background: 'var(--hc-bg-input)',
                      borderColor: 'var(--hc-border)',
                      color: 'var(--hc-text-primary)',
                    }"
                    :placeholder="t('mcpManage.serverArgsPlaceholder')"
                  />
                </HcClearableField>
              </div>
            </template>
            <div v-else class="flex flex-col gap-1.5">
              <label
                class="text-[13px] font-medium"
                :style="{ color: 'var(--hc-text-secondary)' }"
                >{{ t('mcpManage.serverEndpoint') }}</label
              >
              <HcClearableField>
                <input
                  v-model="newServerEndpoint"
                  type="url"
                  class="rounded-lg border px-3 py-2 text-sm outline-none"
                  :style="{
                    background: 'var(--hc-bg-input)',
                    borderColor: 'var(--hc-border)',
                    color: 'var(--hc-text-primary)',
                  }"
                  :placeholder="t('mcpManage.serverEndpointPlaceholder')"
                />
              </HcClearableField>
            </div>
          </div>
          <div
            class="flex items-center justify-end gap-2 px-5 py-3.5 border-t"
            :style="{ borderColor: 'var(--hc-border)' }"
          >
            <button
              class="px-3 py-1.5 rounded-lg text-sm font-medium"
              :style="{ color: 'var(--hc-text-secondary)', background: 'var(--hc-bg-hover)' }"
              @click="closeAddServer"
            >
              {{ t('common.cancel') }}
            </button>
            <button
              class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium text-white"
              :style="{ background: 'var(--hc-accent)', opacity: !addServerValid ? 0.4 : 1 }"
              :disabled="!addServerValid || addingServer"
              @click="handleAddServer"
            >
              <Loader2 v-if="addingServer" :size="14" class="animate-spin" />
              <Plus v-else :size="14" />
              {{ t('common.create') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
    <ConfirmDialog
      :open="!!pendingRemoveServer"
      :title="t('mcpManage.removeConfirmTitle', '删除 MCP 服务器？')"
      :message="t('mcpManage.removeConfirm')"
      :confirm-text="t('common.delete')"
      :cancel-text="t('common.cancel')"
      :confirmation-key="pendingRemoveServer"
      danger
      @confirm="confirmRemoveServer"
      @cancel="pendingRemoveServer = null"
    />
  </div>
</template>

<style scoped>
.hc-mcp-market-card {
  display: flex;
  min-width: 0;
  min-height: 154px;
  flex-direction: column;
  gap: 9px;
  padding: 13px;
  border: 0.5px solid var(--hc-border);
  border-radius: var(--hc-radius-lg);
  background: var(--hc-bg-card);
  box-shadow: var(--hc-shadow-sm);
}

.hc-mcp-market-card__head {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  gap: 10px;
}

.hc-mcp-market-card__icon {
  display: grid;
  width: 36px;
  height: 36px;
  flex: none;
  place-items: center;
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-input);
  color: var(--hc-accent);
}

.hc-mcp-market-card__identity {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.hc-mcp-market-card__identity strong {
  overflow: hidden;
  color: var(--hc-text-primary);
  font-size: 13.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hc-mcp-market-card__identity span,
.hc-mcp-market-card__config {
  color: var(--hc-text-muted);
  font-size: 11px;
}

.hc-mcp-market-card__description {
  margin: 0;
  color: var(--hc-text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.hc-mcp-market-card__config {
  margin: 0;
  line-height: 1.45;
}

.hc-mcp-market-card__install {
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  gap: 5px;
  margin-top: auto;
  padding: 6px 11px;
  border: 0;
  border-radius: var(--hc-radius-md);
  background: var(--hc-accent);
  color: var(--hc-text-inverse);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.hc-mcp-market-card__install--installed,
.hc-mcp-market-card__install:disabled {
  background: var(--hc-bg-active);
  color: var(--hc-text-muted);
  cursor: default;
}
</style>
