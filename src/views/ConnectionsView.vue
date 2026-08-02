<script setup lang="ts">
/**
 * 连接（二分法）：通道与账号 / 数据连接器。
 *   - 通道与账号 = 原型式 Connection 卡片流（ConnectionChannelCards，复用 IM 实例数据 + 邮箱）。
 *   - 数据连接器 = GitHub / Notion 令牌只读接入（§15.1，真实后端：token 加密存、真 test、浏览资源）。
 * 锚点 = prototype/app.html 的 connections 屏（data-cx 0/1）。
 */
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, Zap, Pencil, Trash2, Database, FolderOpen, X, ExternalLink } from 'lucide-vue-next'
import ConnectionChannelCards from '@/components/channels/ConnectionChannelCards.vue'
import ConnectorConfigModal from '@/components/channels/ConnectorConfigModal.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import PageToolbar from '@/components/common/PageToolbar.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import { useToast } from '@/composables/useToast'
import {
  useConnectorInstances,
  type ConnectorInstance,
} from '@/composables/useConnectorInstances'
import {
  getEnabledLocalFolderAllowedPaths,
  syncLocalFolderAllowedPaths,
} from '@/composables/useLocalFolderAllowedPathsSync'
import { deleteConnector, getConnectorResources, type ConnectorResource } from '@/api/connectors'
import { getMcpServerStatus, removeMcpServer } from '@/api/mcp'
import {
  ensureMcpConnectorOnline,
  runMcpConnectorProbe,
  McpProbeError,
  type McpProbeFailureCode,
} from '@/api/mcp-probe'
import { isMcpConnectorType, MCP_CONNECTOR_SPECS } from '@/config/mcp-connectors'

// 官方品牌 logo（Simple Icons 下载落盘，单色，浅底 tile 保证双主题清晰）。
import postgresLogo from '@/assets/connection-logos/postgres.svg'
import mysqlLogo from '@/assets/connection-logos/mysql.svg'
import sqliteLogo from '@/assets/connection-logos/sqlite.svg'
import mongodbLogo from '@/assets/connection-logos/mongodb.svg'
import redisLogo from '@/assets/connection-logos/redis.svg'
import elasticsearchLogo from '@/assets/connection-logos/elasticsearch.svg'
import clickhouseLogo from '@/assets/connection-logos/clickhouse.svg'
import supabaseLogo from '@/assets/connection-logos/supabase.svg'
import notionLogo from '@/assets/connection-logos/notion.svg'
import obsidianLogo from '@/assets/connection-logos/obsidian.svg'
import confluenceLogo from '@/assets/connection-logos/confluence.svg'
import googleDocsLogo from '@/assets/connection-logos/googleDocs.svg'
import googleDriveLogo from '@/assets/connection-logos/googleDrive.svg'
import s3Logo from '@/assets/connection-logos/s3.svg'
import dropboxLogo from '@/assets/connection-logos/dropbox.svg'
import onedriveLogo from '@/assets/connection-logos/onedrive.svg'
import githubLogo from '@/assets/connection-logos/github.svg'
import gitlabLogo from '@/assets/connection-logos/gitlab.svg'
import giteeLogo from '@/assets/connection-logos/gitee.svg'
import googleSheetsLogo from '@/assets/connection-logos/googleSheets.svg'
import airtableLogo from '@/assets/connection-logos/airtable.svg'
import jiraLogo from '@/assets/connection-logos/jira.svg'
import linearLogo from '@/assets/connection-logos/linear.svg'
import trelloLogo from '@/assets/connection-logos/trello.svg'
import gmailLogo from '@/assets/connection-logos/gmail.svg'
import outlookLogo from '@/assets/connection-logos/outlook.svg'
import googleCalendarLogo from '@/assets/connection-logos/googleCalendar.svg'
import rssLogo from '@/assets/connection-logos/rss.svg'

const { t } = useI18n()
const toast = useToast()

// 已落盘的官方品牌 logo：连接器 id → 资源 URL。
// 无官方 Simple Icons 条目者（语雀 / 飞书系 / WebDAV / 本地文件夹 / Teambition / Tapd /
// 网页抓取 / REST API / 文件导入）走字母 monogram fallback，不阻塞渲染。
const CONNECTOR_LOGOS: Record<string, string> = {
  postgres: postgresLogo,
  mysql: mysqlLogo,
  sqlite: sqliteLogo,
  mongodb: mongodbLogo,
  redis: redisLogo,
  elasticsearch: elasticsearchLogo,
  clickhouse: clickhouseLogo,
  supabase: supabaseLogo,
  notion: notionLogo,
  obsidian: obsidianLogo,
  confluence: confluenceLogo,
  googleDocs: googleDocsLogo,
  googleDrive: googleDriveLogo,
  s3: s3Logo,
  dropbox: dropboxLogo,
  onedrive: onedriveLogo,
  github: githubLogo,
  gitlab: gitlabLogo,
  gitee: giteeLogo,
  googleSheets: googleSheetsLogo,
  airtable: airtableLogo,
  jira: jiraLogo,
  linear: linearLogo,
  trello: trelloLogo,
  gmail: gmailLogo,
  outlook: outlookLogo,
  googleCalendar: googleCalendarLogo,
  rss: rssLogo,
}

type ConnTab = 'channels' | 'connectors'
const activeTab = ref<ConnTab>('channels')

// 顶栏搜索（对齐其它内容页 PageToolbar：seg + 搜索框 + 操作）。
// 通道 tab → 过滤通道卡；连接器 tab → 过滤目录条目。
const searchQuery = ref('')

// 通道卡片流引用：顶栏「添加」按钮委托其 openCreate（锚点 prototype addCurrentConn）
const channelCardsRef = ref<{ openCreate?: () => void }>()

// 数据连接器：实例列表 store（模块级单例，localStorage 持久化）。
const { list: connectorInstances, updateInstance, removeInstance } = useConnectorInstances()

// 删除确认目标（非空 = 待删连接器实例）。removeInstance 会同时清理 secure-store 里的密钥残留。
const deleteTarget = ref<ConnectorInstance | null>(null)
async function confirmDeleteConnector() {
  const target = deleteTarget.value
  if (!target) return
  // token 类：连同后端加密 token 一并删除（不留服务端残留）。
  const cid = target.config?.connector_id
  if (cid && typeMetaById.value[target.type]?.method === 'token') {
    try { await deleteConnector(cid) } catch { /* 引擎降级时仍清本地，避免 UI 卡死 */ }
  }
  // MCP 类：摘除后端注册的 stdio MCP server（best-effort，引擎降级仍清本地）。
  if (isMcpConnectorType(target.type)) {
    const serverName = target.config?.mcp_server || target.name
    if (serverName) {
      try { await removeMcpServer(serverName) } catch { /* server 可能已不在，忽略 */ }
    }
  }
  await removeInstance(target.id)
  if (target.type === 'localFolder') {
    try {
      await syncLocalFolderAllowedPaths(getEnabledLocalFolderAllowedPaths(connectorInstances.value))
    } catch (e) {
      const { messageFromUnknownError } = await import('@/utils/errors')
      toast.error(messageFromUnknownError(e))
    }
  }
  deleteTarget.value = null
}

// bug-20260703 漂移三小修#1：接收 ConnectionChannelCards 的 count，tab 标签带计数徽标（对齐原型「通道与账号 2」）
const channelCount = ref(0)
const tabs = computed(() => [
  { key: 'channels', label: channelCount.value > 0 ? `${t('connections.tabChannels')} ${channelCount.value}` : t('connections.tabChannels') },
  { key: 'connectors', label: t('connections.tabConnectors') },
])

// 连接器弹层状态：editing=要编辑的实例（null=新建）
const connectorModalOpen = ref(false)
const editingConnector = ref<ConnectorInstance | null>(null)

// 顶栏「添加」按钮：按当前 tab 分流（通道 → 新建连接弹层；连接器 → 新建连接器弹层）
function addCurrent() {
  if (activeTab.value === 'channels') channelCardsRef.value?.openCreate?.()
  else openConnectorCreate()
}

function openConnectorCreate() {
  editingConnector.value = null
  connectorModalOpen.value = true
}

function openConnectorEdit(inst: ConnectorInstance) {
  editingConnector.value = inst
  connectorModalOpen.value = true
}

// ─── 数据连接器：按组的 featured 目录（Tier1+Tier2 全量，本期 stub）────────
// 连接方式：native=原生直连 / mcp=一键装 MCP / oauth=OAuth 授权 / token=令牌只读接入(GitHub/Notion，真实后端)。
type ConnectMethod = 'native' | 'mcp' | 'oauth' | 'token'
// 单源：id 同时充当 logo slug；name 为品牌名常量（不进 i18n）。
interface ConnectorItem {
  id: string
  name: string
  method: ConnectMethod
}

// 扁平 featured 目录（11 源，不分类）——数据驱动渲染，避免手写模板块。
const CONNECTOR_TYPES: ConnectorItem[] = [
  // §15.1 真实只读接入(token 加密存后端，真实 test/浏览资源)——置顶。
  { id: 'github', name: 'GitHub', method: 'token' },
  { id: 'notion', name: 'Notion', method: 'token' },
  { id: 'yuque', name: '语雀', method: 'mcp' },
  { id: 'feishuDoc', name: '飞书文档', method: 'mcp' },
  { id: 'postgres', name: 'PostgreSQL', method: 'mcp' },
  { id: 'mysql', name: 'MySQL', method: 'mcp' },
  { id: 'sqlite', name: 'SQLite', method: 'mcp' },
  { id: 'mongodb', name: 'MongoDB', method: 'mcp' },
  { id: 'redis', name: 'Redis', method: 'mcp' },
  { id: 'localFolder', name: '本地文件 / 文件夹', method: 'native' },
]

// 类型选择器数据源：把扁平类型列表投影成弹窗第一步用的网格项（含 logo 命中 + monogram fallback）。
// 数据目录从 tab 移进弹窗，仅作为「选类型」入口；缺图走首字母 monogram。
const connectorTypes = computed(() =>
  CONNECTOR_TYPES.map((it) => ({
    id: it.id,
    name: it.name,
    method: it.method,
    logo: CONNECTOR_LOGOS[it.id] ?? null,
    monogram: it.name.slice(0, 1).toUpperCase(),
  })),
)

// type → 显示名 / 连接方式 反查（用于实例卡 logo / monogram / 副标题）。
const typeMetaById = computed(() => {
  const map: Record<string, { name: string; method: ConnectMethod }> = {}
  for (const it of CONNECTOR_TYPES) map[it.id] = { name: it.name, method: it.method }
  return map
})

function instanceLogo(inst: ConnectorInstance): string | null {
  return CONNECTOR_LOGOS[inst.type] ?? null
}

function instanceMono(inst: ConnectorInstance): string {
  const name = typeMetaById.value[inst.type]?.name ?? inst.type
  return name.slice(0, 1).toUpperCase()
}

// 连接展示串：优先 host / path / url；皆无时取该类型 spec 里首个非机密已填字段
//（如飞书文档 app_id）——避免 token/app 类连接器副标恒显「尚未配置」。
function connectorTarget(inst: ConnectorInstance): string {
  const c = inst.config || {}
  const direct = c.host?.trim() || c.path?.trim() || c.url?.trim()
  if (direct) return direct
  const spec = MCP_CONNECTOR_SPECS[inst.type]
  if (spec) {
    for (const f of spec.fields) {
      if (f.secret) continue
      const v = (c[f.key] ?? '').trim()
      if (v) return v
    }
  }
  return ''
}

// 是否已配置（「测试」按钮 + 副标共用，杜绝判定漂移）：MCP 类型按其 spec 的 fields 是否被填——
// 覆盖 host/path/url 之外的字段（语雀=token、飞书文档=app_id+app_secret），否则会把已配好 token 的
// 连接器误判为未配置（弹「请先配置」/副标显「尚未配置」）。非 MCP 类型回退 host/path/url 展示串。
function connectorConfigured(inst: ConnectorInstance): boolean {
  const c = inst.config || {}
  const spec = MCP_CONNECTOR_SPECS[inst.type]
  if (spec) return spec.fields.some((f) => !!(c[f.key] ?? '').trim())
  return !!connectorTarget(inst)
}

// 实例副标题：有展示串显之；否则已配置（仅机密字段，如语雀 token）显「已配置」，全空显「尚未配置」。
function instanceSub(inst: ConnectorInstance): string {
  const target = connectorTarget(inst)
  if (target) return target
  return connectorConfigured(inst)
    ? t('connections.channels.configured', '已配置')
    : t('connections.channels.notConfigured')
}

function instanceMethodLabel(inst: ConnectorInstance): string {
  const method = typeMetaById.value[inst.type]?.method ?? 'native'
  return t(`connections.connectors.method.${method}`)
}

function instanceMethodClass(inst: ConnectorInstance): ConnectMethod {
  return typeMetaById.value[inst.type]?.method ?? 'native'
}

// 搜索过滤实例：按名称 / 类型显示名匹配（空查询原样返回）。
const filteredConnectorInstances = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return connectorInstances.value
  return connectorInstances.value.filter((inst) => {
    const typeName = typeMetaById.value[inst.type]?.name ?? inst.type
    return (
      inst.name.toLowerCase().includes(q) ||
      inst.type.toLowerCase().includes(q) ||
      typeName.toLowerCase().includes(q)
    )
  })
})

// 实例是否为 token 类真实连接器（github / notion，config 带后端 connector_id）。
function connectorIdOf(inst: ConnectorInstance): string | null {
  const method = typeMetaById.value[inst.type]?.method
  if (method !== 'token') return null
  return inst.config?.connector_id || null
}

// 仅 token(真实复验) / mcp(真实状态) 可测；native/oauth 无可测对象 → 不显示测试按钮（删死 stub）。
function canTest(inst: ConnectorInstance): boolean {
  const method = typeMetaById.value[inst.type]?.method
  return method === 'token' || method === 'mcp'
}

// 启停切换仅对 native/oauth 本地实例有意义；mcp 注册即启用，停用 = 删除（不显示开关）。
function canToggle(inst: ConnectorInstance): boolean {
  return !isMcpConnectorType(inst.type) && !connectorIdOf(inst)
}

// ── MCP 服务真实在线态（卡片徽章 + 「测试」按钮共用同一真值，杜绝两套判定漂移）──
// MCP 连接器「注册即启用」(enabled 恒 true，无启停开关)，故徽章不能绑 enabled——否则
// 后端 stdio server 没真连上（首次冷装组件仍在后台下载）时仍谎报「已连接」，与「测试」结果矛盾。
// 真值统一取自后端 getMcpServerStatus。
type McpStatusResp = Awaited<ReturnType<typeof getMcpServerStatus>>
const mcpStatus = ref<McpStatusResp | null>(null)
const mcpStatusLoaded = ref(false)

async function loadMcpStatus() {
  try {
    mcpStatus.value = await getMcpServerStatus()
  } catch {
    mcpStatus.value = null // 引擎降级 / 端点不可用 → 当作未就绪，不谎报已连接
  } finally {
    mcpStatusLoaded.value = true
  }
}
onMounted(loadMcpStatus)

async function refreshMcpStatus(): Promise<McpStatusResp | null> {
  mcpStatus.value = await getMcpServerStatus()
  mcpStatusLoaded.value = true
  return mcpStatus.value
}

// 单一真值：某 MCP server 名是否真实在线（测试按钮与卡片徽章共用）。
function isMcpServerOnline(serverName: string): boolean {
  const s = mcpStatus.value
  if (!s) return false
  return (
    s.statuses?.[serverName] === 'connected' ||
    !!s.servers?.find((x) => x.name === serverName && x.connected)
  )
}

// 卡片连接态：MCP 类取后端真实在线状态；其它（native/token）沿用本地 enabled。
// pending = MCP 状态尚未拉到（避免首帧闪现错误的绿点）。
function connState(inst: ConnectorInstance): 'online' | 'offline' | 'pending' {
  if (isMcpConnectorType(inst.type)) {
    if (!mcpStatusLoaded.value) return 'pending'
    return isMcpServerOnline(inst.config?.mcp_server || inst.name) ? 'online' : 'offline'
  }
  return inst.enabled ? 'online' : 'offline'
}

function connPillClass(inst: ConnectorInstance): string {
  return connState(inst) === 'online' ? 'hc-conn-pill--green' : 'hc-conn-pill--grey'
}

function connPillText(inst: ConnectorInstance): string {
  const st = connState(inst)
  if (st === 'online') return t('connections.legend.connected')
  if (st === 'pending') return t('connections.connectors.checking', '检测中…')
  // offline：MCP 类 = 未就绪（server 未连上）；其它本地实例 = 已停用
  return isMcpConnectorType(inst.type)
    ? t('connections.connectors.notReady', '未就绪')
    : t('connections.channels.disabled')
}

// MCP 探针失败 code → 本地化可读提示（探针编排已下沉 @/api/mcp-probe，i18n 隔离留在 view）。
function mcpProbeErrorText(err: McpProbeError): string {
  const key: Record<McpProbeFailureCode, string> = {
    tool_missing: 'connections.connectors.mcpProbeToolMissing',
    no_input_schema: 'connections.connectors.mcpProbeNoInputSchema',
    no_sql_arg: 'connections.connectors.mcpProbeNoSqlArg',
  }
  return t(key[err.code], { tool: err.toolName ?? '' })
}

// 测试连接：token 类 → 真实复验（拉一次资源即验证 token 仍有效）；
//           mcp 类 → 查后端 MCP 服务真实在线状态（并同步徽章，二者结果一致）。
const testingId = ref<string | null>(null)
async function testConnector(inst: ConnectorInstance) {
  testingId.value = inst.id
  try {
    const cid = connectorIdOf(inst)
    if (cid) {
      const res = await getConnectorResources(cid)
      toast.success(t('connections.connectors.testOk', { n: res.length }))
      return
    }
    if (isMcpConnectorType(inst.type)) {
      // 未配置（该类型 spec 字段全空）→ MCP server 永远不会起来，等待无用；引导去「编辑填写连接信息」，
      // 而非误报「首次下载中、稍后再试」（那是已配置但 server 仍在启动的短暂过渡态，语义不同）。
      // 用 connectorConfigured（按 spec 字段）而非 connectorTarget（仅 host/path/url）——后者会把
      // 已配好 token 的语雀 / app_id 的飞书文档误判为未配置（bug-20260628）。
      if (!connectorConfigured(inst)) {
        toast.info(t('connections.connectors.mcpTestNotConfigured', '连接器尚未配置，请先编辑填写连接信息'))
        return
      }
      const serverName = inst.config?.mcp_server || inst.name
      const online = await ensureMcpConnectorOnline(inst, serverName, {
        refreshStatus: refreshMcpStatus,
        isServerOnline: isMcpServerOnline,
      })
      if (!online) {
        toast.info(t('connections.connectors.mcpConnecting', '已添加，正在后台连接（首次需下载组件，稍后可在卡片测试）'))
        return
      }
      await runMcpConnectorProbe(inst, serverName)
      toast.success(t('connections.connectors.mcpTestConnected', '已连接，MCP 服务在线'))
    }
  } catch (e) {
    // BUG-20260704：探针失败（典型：MCP 子进程已退出）后重新拉取状态真值——后端 CallTool
    // 此时已把该 server 标记断连（30s 内自动重连自愈），徽章须立即从「已连接」翻「未就绪」，
    // 不能与同屏的测试失败 toast 自相矛盾（loadMcpStatus 自带失败降级，不会二次抛错）。
    if (isMcpConnectorType(inst.type)) void loadMcpStatus()
    if (e instanceof McpProbeError) {
      toast.error(`${t('connections.connectors.testFail', '连接失败')}: ${mcpProbeErrorText(e)}`)
      return
    }
    const { messageFromUnknownError } = await import('@/utils/errors')
    toast.error(`${t('connections.connectors.testFail', '连接失败')}: ${messageFromUnknownError(e)}`)
  } finally {
    testingId.value = null
  }
}

// ── 浏览资源（token 连接器真实拉取仓库 / 页面列表）──────────────
const resourcesModalFor = ref<ConnectorInstance | null>(null)
const resourcesLoading = ref(false)
const resourcesList = ref<ConnectorResource[]>([])
const resourcesError = ref('')

async function browseResources(inst: ConnectorInstance) {
  const cid = connectorIdOf(inst)
  if (!cid) return
  resourcesModalFor.value = inst
  resourcesLoading.value = true
  resourcesError.value = ''
  resourcesList.value = []
  try {
    resourcesList.value = await getConnectorResources(cid)
  } catch (e) {
    const { messageFromUnknownError } = await import('@/utils/errors')
    resourcesError.value = messageFromUnknownError(e)
  } finally {
    resourcesLoading.value = false
  }
}

function closeResources() {
  resourcesModalFor.value = null
}

// 停用 / 启用：直接改 store（本地态，立即持久化）。
async function toggleConnector(inst: ConnectorInstance) {
  await updateInstance(inst.id, { enabled: !inst.enabled })
  if (inst.type === 'localFolder') {
    try {
      await syncLocalFolderAllowedPaths(getEnabledLocalFolderAllowedPaths(connectorInstances.value))
    } catch (e) {
      const { messageFromUnknownError } = await import('@/utils/errors')
      toast.error(messageFromUnknownError(e))
    }
  }
}
</script>

<template>
  <div class="hc-connections">
    <!-- 顶栏：与其它内容页统一用共享 PageToolbar（seg + 搜索框 + 操作，同高/同边框/同内边距） -->
    <PageToolbar
      :search-placeholder="t('connections.searchPlaceholder')"
      :search-value="searchQuery"
      @search="searchQuery = $event"
    >
      <template #tabs>
        <SegmentedControl
          :model-value="activeTab"
          :segments="tabs"
          @update:model-value="activeTab = $event as ConnTab"
        />
      </template>
      <template #actions>
        <button class="hc-btn hc-btn-primary" type="button" data-testid="connections-add" @click="addCurrent">
          <Plus :size="14" />
          {{ t('connections.add') }}
        </button>
      </template>
    </PageToolbar>

    <!-- 通道与账号：原型式 Connection 卡片流（锚点 prototype data-cx=0） -->
    <div v-if="activeTab === 'channels'" class="hc-conn-panel">
      <ConnectionChannelCards ref="channelCardsRef" :filter="searchQuery" @count="channelCount = $event" />
    </div>

    <!-- 数据连接器：我已添加的连接器实例列表（支持同类型多个，顶栏「添加」开两步弹窗） -->
    <div v-if="activeTab === 'connectors'" class="hc-conn-panel">
      <!-- 空状态：还没添加任何连接器实例 -->
      <EmptyState
        v-if="filteredConnectorInstances.length === 0"
        :icon="Database"
        :title="t('connections.connectors.emptyTitle', '还没有数据连接')"
        :description="t('connections.connectors.emptyDesc', '点右上角添加，连接数据库 / 云存储 / 文档等数据源')"
      />

      <!-- 实例卡列表 -->
      <div v-else class="hc-conn-grid">
        <div
          v-for="inst in filteredConnectorInstances"
          :key="inst.id"
          class="hc-conn-card"
          :data-testid="`connector-card-${inst.type}`"
        >
          <div class="hc-conn-card__top">
            <div class="hc-conn-card__logo">
              <img v-if="instanceLogo(inst)" :src="instanceLogo(inst)!" :alt="inst.name" />
              <!-- 缺图 → 首字母 monogram tile（accent-subtle 底） -->
              <span v-else class="hc-conn-card__mono">{{ instanceMono(inst) }}</span>
            </div>
            <div class="hc-conn-card__head">
              <div class="hc-conn-card__name">{{ inst.name }}</div>
              <div class="hc-conn-card__desc">{{ instanceSub(inst) }}</div>
            </div>
            <span class="hc-conn-pill" :class="connPillClass(inst)">
              {{ connPillText(inst) }}
            </span>
          </div>
          <div class="hc-conn-card__caps">
            <span class="hc-conn-cap hc-conn-cap--read">{{ t('connections.cap.read') }}</span>
            <!-- 连接方式标签：原生 / MCP / OAuth -->
            <span class="hc-conn-method" :class="`hc-conn-method--${instanceMethodClass(inst)}`">
              {{ instanceMethodLabel(inst) }}
            </span>
          </div>
          <div class="hc-conn-card__actions">
            <!-- 测试：token(真实复验) / mcp(真实状态) 才显示；native/oauth 无可测对象 -->
            <button
              v-if="canTest(inst)"
              class="hc-conn-btn hc-conn-btn--ghost"
              :disabled="testingId === inst.id"
              :data-testid="`connector-test-${inst.type}`"
              @click="testConnector(inst)"
            >
              <Zap :size="13" />
              {{ testingId === inst.id ? t('connections.connectors.testing', '测试中…') : t('connections.channels.test') }}
            </button>
            <!-- token 类(github/notion)：浏览真实资源 -->
            <button
              v-if="connectorIdOf(inst)"
              class="hc-conn-btn hc-conn-btn--ghost"
              :data-testid="`connector-browse-${inst.type}`"
              @click="browseResources(inst)"
            >
              <FolderOpen :size="13" />
              {{ t('connections.connectors.browse', '浏览资源') }}
            </button>
            <!-- 非 token：可编辑（mcp 编辑=重注册）；启停仅对 native/oauth 本地实例 -->
            <template v-else>
              <button
                class="hc-conn-btn hc-conn-btn--ghost"
                :data-testid="`connector-edit-${inst.type}`"
                @click="openConnectorEdit(inst)"
              >
                <Pencil :size="13" />
                {{ t('common.edit') }}
              </button>
              <button
                v-if="canToggle(inst)"
                class="hc-conn-btn hc-conn-btn--ghost"
                :data-testid="`connector-toggle-${inst.type}`"
                @click="toggleConnector(inst)"
              >
                {{ inst.enabled ? t('connections.channels.disable') : t('connections.channels.enable') }}
              </button>
            </template>
            <button class="hc-conn-btn hc-conn-btn--danger" :data-testid="`connector-delete-${inst.type}`" @click="deleteTarget = inst">
              <Trash2 :size="13" />
              {{ t('connections.channels.delete', '删除') }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 连接器配置弹层：两步向导（选类型 → 填配置 → 保存） -->
    <ConnectorConfigModal
      v-if="connectorModalOpen"
      :instance="editingConnector"
      :types="connectorTypes"
      @close="connectorModalOpen = false"
      @saved="() => {}"
    />

    <!-- 删除连接器确认（不可逆，含密钥清理） -->
    <ConfirmDialog
      :open="!!deleteTarget"
      :confirmation-key="deleteTarget?.id"
      :danger="true"
      :title="t('connections.connectors.deleteConfirmTitle', '删除连接器')"
      :message="t('connections.connectors.deleteConfirmMessage', '确定删除该数据连接器？此操作不可恢复。')"
      :confirm-text="t('connections.channels.delete', '删除')"
      @confirm="confirmDeleteConnector"
      @cancel="deleteTarget = null"
    />

    <!-- 浏览资源弹层：token 连接器真实拉取的仓库 / 页面列表 -->
    <Teleport to="body">
      <Transition name="hc-modal" appear>
        <div v-if="resourcesModalFor" class="hc-res-overlay" @click.self="closeResources">
          <div class="hc-res-modal">
            <div class="hc-res-modal__head">
              <h2 class="hc-res-modal__title">{{ resourcesModalFor.name }} · {{ t('connections.connectors.resources', '资源') }}</h2>
              <button class="hc-conn-btn hc-conn-btn--ghost" @click="closeResources"><X :size="16" /></button>
            </div>
            <div class="hc-res-modal__body">
              <div v-if="resourcesLoading" class="hc-res-state">{{ t('common.loading', '加载中…') }}</div>
              <div v-else-if="resourcesError" class="hc-res-state hc-res-state--err">{{ resourcesError }}</div>
              <div v-else-if="resourcesList.length === 0" class="hc-res-state">{{ t('connections.connectors.resourcesEmpty', '没有可读取的资源') }}</div>
              <ul v-else class="hc-res-list">
                <li v-for="r in resourcesList" :key="r.id" class="hc-res-item">
                  <div class="hc-res-item__main">
                    <div class="hc-res-item__title">{{ r.title }}</div>
                    <div v-if="r.desc" class="hc-res-item__desc">{{ r.desc }}</div>
                  </div>
                  <span v-if="r.kind" class="hc-res-item__kind">{{ r.kind }}</span>
                  <a v-if="r.url" :href="r.url" target="_blank" rel="noopener" class="hc-res-item__link"><ExternalLink :size="13" /></a>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.hc-connections {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 顶栏改用共享 PageToolbar 组件（geometry 与其它内容页一致），原 .hc-conn-tabbar 自定义样式已移除 */

.hc-conn-panel {
  flex: 1;
  overflow-y: auto;
  /* 对齐原型 .content padding:16px 26px 48px */
  padding: 16px 26px 48px;
  display: flex;
  flex-direction: column;
}

/* 数据连接器 tab note（锚点 prototype .cxsec .note，margin-bottom 对齐 10px） */
.hc-conn-note {
  font-size: 12px;
  color: var(--hc-text-muted);
  margin: 0 0 10px;
}

/* 分组：组名 + 网格（组间留白） */
.hc-conn-group {
  margin-bottom: 22px;
}

/* 组名（锚点 prototype .conn-glabel：小号、大写、字距、muted） */
.hc-conn-group__title {
  margin: 0 0 8px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--hc-text-muted);
}

.hc-conn-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 16px;
  max-width: 1280px;
}

.hc-conn-card {
  border-radius: var(--hc-radius-lg, 12px);
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-card);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  /* 锚点 prototype .cxcard：静置柔阴影，hover 蓝调抬升（官网气质） */
  box-shadow: var(--hc-shadow-sm);
  transition:
    transform 0.28s var(--hc-ease-out),
    box-shadow 0.28s var(--hc-ease-out),
    border-color 0.2s var(--hc-ease-out);
}

.hc-conn-card:hover {
  border-color: var(--hc-border-hl);
  box-shadow: var(--hc-shadow-md);
  transform: translateY(-2px);
}

.hc-conn-card__top {
  display: flex;
  align-items: center;
  gap: 12px;
}

.hc-conn-card__logo {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  /* 浅底 tile：官方品牌 logo 多为单色（Simple Icons 黑色 path），
     白底在浅/深主题下都能让品牌字形清晰可读。 */
  background: var(--hc-brand-tile);
  border: 1px solid var(--hc-brand-tile-border);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.hc-conn-card__logo img {
  width: 22px;
  height: 22px;
  object-fit: contain;
}

/* 缺图 fallback：首字母 monogram（accent-subtle 底，accent 字） */
.hc-conn-card__mono {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  border-radius: inherit;
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
  font-size: 16px;
  font-weight: 600;
}

.hc-conn-card__head {
  flex: 1;
  min-width: 0;
}

.hc-conn-card__name {
  font-size: 14px;
  font-weight: 600;
  color: var(--hc-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hc-conn-card__desc {
  font-size: 12px;
  color: var(--hc-text-muted);
  margin-top: 2px;
}

.hc-conn-pill {
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
}

.hc-conn-pill--grey {
  background: var(--hc-bg-hover);
  color: var(--hc-text-muted);
}

/* 已启用：绿色 pill（对齐通道卡 .hc-cxpill--green） */
.hc-conn-pill--green {
  background: color-mix(in srgb, var(--hc-success) 14%, transparent);
  color: var(--hc-success);
}

.hc-conn-card__caps {
  display: flex;
  gap: 6px;
}

.hc-conn-cap {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 6px;
}

/* 读取 cap：靛蓝（锚点 prototype .cap.read，令牌 --hc-cap-read） */
.hc-conn-cap--read {
  background: color-mix(in srgb, var(--hc-cap-read) 18%, transparent);
  color: var(--hc-cap-read);
}

/* 连接方式标签：原生（中性）/ MCP（accent）/ OAuth（success） */
.hc-conn-method {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 6px;
}

.hc-conn-method--native {
  background: var(--hc-bg-active);
  color: var(--hc-text-secondary);
}

.hc-conn-method--mcp {
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
}

.hc-conn-method--oauth {
  background: color-mix(in srgb, var(--hc-success) 14%, transparent);
  color: var(--hc-success);
}

.hc-conn-method--token {
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
}

/* 浏览资源弹层 */
.hc-res-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}
.hc-res-modal {
  width: 540px;
  max-width: calc(100vw - 48px);
  max-height: 80vh;
  border-radius: 16px;
  background: var(--hc-bg-elevated, var(--hc-bg-main));
  border: 1px solid var(--hc-border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.hc-res-modal__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--hc-border);
}
.hc-res-modal__title {
  font-size: 15px;
  font-weight: 600;
  color: var(--hc-text-primary);
  margin: 0;
}
.hc-res-modal__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 0;
}
.hc-res-state {
  padding: 32px 18px;
  text-align: center;
  font-size: 13px;
  color: var(--hc-text-secondary);
}
.hc-res-state--err { color: var(--hc-amber); }
.hc-res-list { list-style: none; margin: 0; padding: 0; }
.hc-res-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 18px;
  border-bottom: 1px solid var(--hc-border);
}
.hc-res-item:last-child { border-bottom: none; }
.hc-res-item__main { flex: 1; min-width: 0; }
.hc-res-item__title { font-size: 13.5px; font-weight: 500; color: var(--hc-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hc-res-item__desc { font-size: 12px; color: var(--hc-text-secondary); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hc-res-item__kind { font-size: 11px; color: var(--hc-text-muted); flex-shrink: 0; }
.hc-res-item__link { color: var(--hc-accent); display: inline-flex; flex-shrink: 0; }

.hc-conn-card__actions {
  display: flex;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--hc-border);
}

.hc-conn-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  border: none;
  cursor: pointer;
  background: var(--hc-accent);
  color: var(--hc-text-inverse);
  transition: background 0.15s, opacity 0.15s;
}

.hc-conn-btn:hover {
  opacity: 0.9;
}

.hc-conn-btn--ghost {
  background: var(--hc-bg-hover);
  color: var(--hc-text-secondary);
}

.hc-conn-btn--ghost:hover {
  background: var(--hc-bg-active);
  color: var(--hc-text-primary);
  opacity: 1;
}

.hc-conn-btn--danger {
  background: var(--hc-bg-hover);
  color: var(--hc-error);
}

.hc-conn-btn--danger:hover {
  background: color-mix(in srgb, var(--hc-error) 12%, transparent);
  color: var(--hc-error);
  opacity: 1;
}
</style>
