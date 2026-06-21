<script setup lang="ts">
/**
 * 连接（二分法）：通道与账号 / 数据连接器。
 *   - 通道与账号 = 原型式 Connection 卡片流（ConnectionChannelCards，复用 IM 实例数据 + 邮箱）。
 *   - 数据连接器 = GitHub / Notion 令牌只读接入（§15.1，真实后端：token 加密存、真 test、浏览资源）。
 * 锚点 = prototype/app.html 的 connections 屏（data-cx 0/1）。
 */
import { ref, computed } from 'vue'
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
import { deleteConnector, getConnectorResources, type ConnectorResource } from '@/api/connectors'

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

// 通道与账号 tab 计数（由卡片流上抛，锚点 prototype .seg .segc）
const channelCount = ref(0)
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
  removeInstance(target.id)
  deleteTarget.value = null
}

const tabs = computed(() => [
  { key: 'channels', label: t('connections.tabChannels') },
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
  { id: 'yuque', name: '语雀', method: 'oauth' },
  { id: 'feishuDoc', name: '飞书文档', method: 'oauth' },
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

// 实例副标题：优先显示 host，其次 path / url，皆空则提示未配置。
function instanceSub(inst: ConnectorInstance): string {
  const c = inst.config || {}
  const v = c.host?.trim() || c.path?.trim() || c.url?.trim()
  return v || t('connections.channels.notConfigured')
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

// 测试连接：token 类 → 真实复验（拉一次资源即验证 token 仍有效）；其余仍占位。
const testingId = ref<string | null>(null)
async function testConnector(inst: ConnectorInstance) {
  const cid = connectorIdOf(inst)
  if (!cid) {
    toast.info(t('connections.connectors.testStub', '连接测试即将上线'))
    return
  }
  testingId.value = inst.id
  try {
    const res = await getConnectorResources(cid)
    toast.success(t('connections.connectors.testOk', { n: res.length }))
  } catch (e) {
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
function toggleConnector(inst: ConnectorInstance) {
  updateInstance(inst.id, { enabled: !inst.enabled })
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
        <button class="hc-btn hc-btn-primary" type="button" @click="addCurrent">
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
        <div v-for="inst in filteredConnectorInstances" :key="inst.id" class="hc-conn-card">
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
            <span
              class="hc-conn-pill"
              :class="inst.enabled ? 'hc-conn-pill--green' : 'hc-conn-pill--grey'"
            >
              {{ inst.enabled ? t('connections.legend.connected') : t('connections.channels.disabled') }}
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
            <button class="hc-conn-btn hc-conn-btn--ghost" :disabled="testingId === inst.id" @click="testConnector(inst)">
              <Zap :size="13" />
              {{ testingId === inst.id ? t('connections.connectors.testing', '测试中…') : t('connections.channels.test') }}
            </button>
            <!-- token 类(github/notion)：浏览真实资源；本地配置类：编辑 + 启停 -->
            <button v-if="connectorIdOf(inst)" class="hc-conn-btn hc-conn-btn--ghost" @click="browseResources(inst)">
              <FolderOpen :size="13" />
              {{ t('connections.connectors.browse', '浏览资源') }}
            </button>
            <template v-else>
              <button class="hc-conn-btn hc-conn-btn--ghost" @click="openConnectorEdit(inst)">
                <Pencil :size="13" />
                {{ t('common.edit') }}
              </button>
              <button class="hc-conn-btn hc-conn-btn--ghost" @click="toggleConnector(inst)">
                {{ inst.enabled ? t('connections.channels.disable') : t('connections.channels.enable') }}
              </button>
            </template>
            <button class="hc-conn-btn hc-conn-btn--danger" @click="deleteTarget = inst">
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
