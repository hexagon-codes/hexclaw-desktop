<script setup lang="ts">
/**
 * 通道与账号卡片流：连接页 tab1 的原型式 Connection 卡片流。
 * 渲染已添加的 IM / 邮箱实例，状态 pill / 能力 chip / 测试·编辑·停用·删除操作。
 * 邮箱不再常驻占位卡，统一走顶部「+添加」弹窗（含邮箱类型）。
 * 配置 / 编辑复用 ChannelConfigModal；测试 / 停用 / 删除复用 im-channels API。
 * 锚点 = prototype/app.html connections 屏 data-cx=0（通道与账号）。
 */
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Zap, Pencil, Trash2, Plug } from 'lucide-vue-next'
import {
  getIMInstances,
  updateIMInstance,
  deleteIMInstance,
  testSavedIMInstanceDelivery,
  listIMInstancesHealth,
  getChannelMeta,
  getRequiredFieldLabels,
  CHANNEL_CONFIG_FIELDS,
} from '@/api/im-channels'
import type { IMInstance, IMChannelType, IMInstanceHealth } from '@/api/im-channels'
import { getCronJobs } from '@/api/tasks'
import type { CronJob } from '@/types'
import { backendScopeKey } from '@/services/backend-context'
import ChannelConfigModal from '@/components/channels/ChannelConfigModal.vue'
import ChannelAgentBinding from '@/components/channels/ChannelAgentBinding.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import EmptyState from '@/components/common/EmptyState.vue'

const { t, locale } = useI18n()

// 顶栏搜索词（来自 ConnectionsView PageToolbar）：仅过滤渲染，不影响 count 徽标（保持总数）。
const props = withDefaults(defineProps<{ filter?: string }>(), { filter: '' })

// 把卡片数上抛给连接屏顶栏 tab 计数（锚点 prototype .seg .segc）：
// 真实实例数 + 邮箱占位卡（无邮箱实例时算 1）。
const emit = defineEmits<{ count: [n: number] }>()

const instances = ref<IMInstance[]>([])
const loading = ref(true)
const errorMsg = ref('')
const busyId = ref<string | null>(null)
const testResults = ref<Record<string, { success: boolean; message: string }>>({})

// 后台定时任务引用数据与健康态均优雅降级：拉取失败时留空且不阻塞卡片。
// 定时任务引用数据不投影到卡片可见 UI；health 按实例 name 索引。
const cronJobs = ref<CronJob[]>([])
const healthByName = ref<Record<string, IMInstanceHealth>>({})
let active = false
let viewVersion = 0
let healthRequest = 0
let refreshVersion = 0
let refreshTimer: ReturnType<typeof setTimeout> | undefined
let testController: AbortController | undefined
const resultTimers = new Set<ReturnType<typeof setTimeout>>()

function stopHealthRefresh() {
  refreshVersion++
  if (refreshTimer !== undefined) clearTimeout(refreshTimer)
  refreshTimer = undefined
}

function deactivate() {
  active = false
  viewVersion++
  stopHealthRefresh()
  testController?.abort()
  testController = undefined
  for (const timer of resultTimers) clearTimeout(timer)
  resultTimers.clear()
}

// 弹层状态：editing=要编辑的实例（null=新建）；presetType=新建时预选类型
const modalOpen = ref(false)
const editing = ref<IMInstance | null>(null)
const presetType = ref<IMChannelType | null>(null)

async function load() {
  const version = viewVersion
  stopHealthRefresh()
  healthByName.value = {}
  loading.value = true
  errorMsg.value = ''
  try {
    const list = await getIMInstances()
    if (!active || version !== viewVersion) return
    instances.value = list
  } catch (e) {
    if (!active || version !== viewVersion) return
    errorMsg.value = e instanceof Error ? e.message : t('imChannels.loadFailed')
  } finally {
    if (active && version === viewVersion) loading.value = false
  }
  if (!active || version !== viewVersion) return
  // 定时任务引用数据 / 健康态的任一拉取失败都只优雅退化，
  // 不写 errorMsg、不阻塞卡片渲染。
  void loadReferences()
  startHealthRefresh()
}

async function loadReferences() {
  const version = viewVersion
  try {
    const { jobs } = await getCronJobs()
    if (active && version === viewVersion) cronJobs.value = jobs
  } catch {
    if (active && version === viewVersion) cronJobs.value = []
  }
}

async function loadHealth() {
  const version = viewVersion
  const request = ++healthRequest
  try {
    const list = await listIMInstancesHealth()
    if (!active || version !== viewVersion || request !== healthRequest) return
    const map: Record<string, IMInstanceHealth> = {}
    for (const h of list) map[h.name] = h
    healthByName.value = map
  } catch {
    if (active && version === viewVersion && request === healthRequest) healthByName.value = {}
  }
}

// 刷新只读健康状态；握手期间最多等待十二秒，不触发启用或消息投递。
function startHealthRefresh() {
  stopHealthRefresh()
  const version = refreshVersion
  const deadline = Date.now() + 12_000
  async function refresh() {
    if (!active || version !== refreshVersion) return
    await loadHealth()
    if (!active || version !== refreshVersion || Date.now() >= deadline) return
    if (instances.value.some((inst) => inst.enabled && !isIncomplete(inst) &&
      (!healthByName.value[inst.name] || healthByName.value[inst.name]?.connection_state === 'connecting'))) {
      refreshTimer = setTimeout(() => { void refresh() }, 1000)
    }
  }
  void refresh()
}

function activate() {
  if (active) return
  active = true
  void load()
}

onMounted(activate)
onActivated(activate)
onDeactivated(deactivate)
onBeforeUnmount(deactivate)
watch(() => backendScopeKey(), () => {
  const wasActive = active
  deactivate()
  instances.value = []
  healthByName.value = {}
  testResults.value = {}
  errorMsg.value = ''
  busyId.value = null
  if (wasActive) activate()
})

const existingNames = computed(() => instances.value.map((i) => i.name))

// 通道卡片数 = 真实实例数，上抛给顶栏 tab 计数徽标（始终用总数，不受搜索影响）。
// 邮箱不再常驻占位卡，统一走顶部「+添加」弹窗（含邮箱类型）添加。
const cardCount = computed(() => instances.value.length)
watch(cardCount, (n) => emit('count', n), { immediate: true })

// 顶栏搜索过滤：按实例名 / 类型 / 显示名匹配（空查询时原样返回）。
const filteredInstances = computed(() => {
  const q = props.filter.trim().toLowerCase()
  if (!q) return instances.value
  return instances.value.filter(
    (i) =>
      i.name.toLowerCase().includes(q) ||
      i.type.toLowerCase().includes(q) ||
      metaName(i).toLowerCase().includes(q),
  )
})

function metaName(inst: IMInstance) {
  const meta = getChannelMeta(inst.type)
  return inst.name || (locale.value === 'zh-CN' ? meta.name : meta.nameEn)
}

function isIncomplete(inst: IMInstance): boolean {
  return getRequiredFieldLabels(inst).length > 0
}

// 只有后端明确的鉴权拒绝能投影为凭证失效，网络与握手错误不作凭据判断。
function hasCredentialError(inst: IMInstance): boolean {
  const h = healthByName.value[inst.name]
  return h?.connection_state === 'credential_invalid'
}

// 绿色只由真实健康结果决定；尚未取得结果时保持未连接。
function statusKind(inst: IMInstance): 'green' | 'amber' | 'red' | 'grey' {
  if (isIncomplete(inst)) return 'amber'
  if (!inst.enabled) return 'grey'
  if (hasCredentialError(inst)) return 'red'
  const h = healthByName.value[inst.name]
  if (h?.healthy === true) return 'green'
  return h?.connection_state === 'connecting' ? 'amber' : 'grey'
}

function statusLabel(inst: IMInstance): string {
  const kind = statusKind(inst)
  if (kind === 'red') return t('connections.legend.invalid')
  if (kind === 'amber') return isIncomplete(inst) ? t('connections.legend.unconfigured') : t('imChannels.connecting')
  if (kind === 'green') return t('connections.legend.connected')
  return inst.enabled ? t('imChannels.notConnected') : t('connections.channels.disabled')
}

// 能力 chip：按 provider 派生，镜像后端 connectionCapabilities（email 只收 receive；IM 收+发）。
// 不再对所有通道硬编码 ['receive','send']——否则 email 卡片谎报"发送"，与投递能力闸门不一致。
function capsFor(inst: IMInstance): Array<'receive' | 'send'> {
  return inst.type === 'email' ? ['receive'] : ['receive', 'send']
}

function metaSub(inst: IMInstance): string {
  const fields = CHANNEL_CONFIG_FIELDS[inst.type] || []
  // 取首个非密钥已填字段做副标题，未填则提示尚未配置
  for (const f of fields) {
    if (f.secret) continue
    const v = inst.config[f.key]?.trim()
    if (v) return `${locale.value === 'zh-CN' ? f.label : f.labelEn} ${v}`
  }
  return t('connections.channels.notConfigured')
}

function openCreate() {
  editing.value = null
  presetType.value = null
  modalOpen.value = true
}

function openEdit(inst: IMInstance) {
  editing.value = inst
  presetType.value = null
  modalOpen.value = true
}

function onSaved() {
  void load()
}

async function toggleEnabled(inst: IMInstance) {
  if (busyId.value) return
  if (!inst.enabled && isIncomplete(inst)) {
    errorMsg.value = t('imChannels.enableNeedConfig')
    return
  }
  busyId.value = inst.id
  const version = viewVersion
  try {
    await updateIMInstance(inst.id, { enabled: !inst.enabled })
    if (!active || version !== viewVersion) return
    await load()
  } catch (e) {
    if (!active || version !== viewVersion) return
    errorMsg.value = e instanceof Error ? e.message : t('imChannels.updateFailed')
  } finally {
    if (active && version === viewVersion) busyId.value = null
  }
}

// 删除确认目标（非空 = 待删实例）。删除不可逆，先弹 ConfirmDialog。
const deleteTarget = ref<IMInstance | null>(null)

async function confirmDeleteInstance() {
  const inst = deleteTarget.value
  if (!inst) return
  busyId.value = inst.id
  try {
    await deleteIMInstance(inst.id)
    deleteTarget.value = null
    await load()
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('imChannels.deleteFailed', '删除失败')
  } finally {
    busyId.value = null
  }
}

async function testInstance(inst: IMInstance) {
  if (busyId.value) return
  busyId.value = inst.id
  const version = viewVersion
  const controller = new AbortController()
  testController = controller
  delete testResults.value[inst.id]
  try {
    const result = await testSavedIMInstanceDelivery(inst, t('connections.test.message'), controller.signal)
    if (!active || version !== viewVersion) return
    testResults.value[inst.id] = result
  } catch (e) {
    if (!active || version !== viewVersion) return
    testResults.value[inst.id] = {
      success: false,
      message: e instanceof Error ? e.message : t('imChannels.testFailed'),
    }
  } finally {
    if (active && version === viewVersion) {
      busyId.value = null
      testController = undefined
      startHealthRefresh()
      const timer = setTimeout(() => {
        delete testResults.value[inst.id]
        resultTimers.delete(timer)
      }, 5000)
      resultTimers.add(timer)
    }
  }
}

// 顶栏「添加」按钮（连接屏 channels tab）委托到这里（锚点 prototype addCurrentConn）。
defineExpose({ openCreate })
</script>

<template>
  <div class="hc-cxstream">
    <div
      v-if="errorMsg"
      class="hc-cxstream__alert"
    >
      <span>{{ errorMsg }}</span>
      <button
        class="hc-cxstream__alert-close"
        @click="errorMsg = ''"
      >
        {{ t('common.close') }}
      </button>
    </div>

    <!-- 空状态：还没添加任何通道 / 账号（邮箱占位卡已移除，统一走顶部「+添加」） -->
    <EmptyState
      v-if="!loading && filteredInstances.length === 0"
      :icon="Plug"
      :title="t('connections.channels.emptyTitle', '还没有通道或账号')"
      :description="t('connections.channels.emptyDesc', '点右上角「添加」，连接 IM / 邮箱账号')"
    />

    <div v-else class="hc-cxstream__grid">

      <!-- 已存在实例卡（按顶栏搜索过滤） -->
      <div
        v-for="inst in filteredInstances"
        :key="inst.id"
        class="hc-cxcard"
        :data-testid="`channel-card-${inst.type}`"
      >
        <div class="hc-cxcard__top">
          <div
            class="hc-cxcard__logo hc-cxcard__logo--brand"
            :style="{ borderColor: getChannelMeta(inst.type).color + '33' }"
          >
            <img :src="getChannelMeta(inst.type).logo" :alt="metaName(inst)" />
          </div>
          <div class="hc-cxcard__head">
            <div class="hc-cxcard__name">{{ metaName(inst) }}</div>
            <div class="hc-cxcard__meta">{{ metaSub(inst) }}</div>
          </div>
          <span class="hc-cxpill" :class="`hc-cxpill--${statusKind(inst)}`">
            {{ statusLabel(inst) }}
          </span>
        </div>

        <div class="hc-cxcard__caps">
          <span
            v-for="c in capsFor(inst)"
            :key="c"
            class="hc-cxcap"
            :class="`hc-cxcap--${c}`"
          >
            {{ c === 'receive' ? t('connections.cap.receive') : t('connections.cap.send') }}
          </span>
        </div>

        <!-- 接待 Agent 绑定（活页面入口）：通道绑 Agent，模型为 Agent 内聚属性；裸模型走折叠「高级」。 -->
        <ChannelAgentBinding :instance="inst" />

        <div
          v-if="testResults[inst.id]"
          class="hc-cxcard__testresult"
          :class="testResults[inst.id]!.success ? 'is-ok' : 'is-err'"
          :data-testid="`channel-test-result-${inst.type}`"
        >
          {{ testResults[inst.id]!.message }}
        </div>

        <div class="hc-cxcard__actions">
          <button
            class="hc-cxbtn hc-cxbtn--ok"
            :disabled="busyId === inst.id"
            :data-testid="`channel-test-${inst.type}`"
            @click="testInstance(inst)"
          >
            <Zap :size="13" />
            {{ t('connections.channels.test') }}
          </button>
          <button class="hc-cxbtn" @click="openEdit(inst)">
            <Pencil :size="13" />
            {{ t('common.edit') }}
          </button>
          <button
            class="hc-cxbtn hc-cxbtn--ghost"
            :disabled="busyId === inst.id"
            @click="toggleEnabled(inst)"
          >
            {{ inst.enabled ? t('connections.channels.disable') : t('connections.channels.enable') }}
          </button>
          <button
            class="hc-cxbtn hc-cxbtn--danger"
            :disabled="busyId === inst.id"
            @click="deleteTarget = inst"
          >
            <Trash2 :size="13" />
            {{ t('connections.channels.delete', '删除') }}
          </button>
        </div>
      </div>
    </div>

    <ConfirmDialog
      :open="!!deleteTarget"
      :confirmation-key="deleteTarget?.id"
      :danger="true"
      :title="t('connections.channels.deleteConfirmTitle', '删除连接')"
      :message="t('connections.channels.deleteConfirmMessage', '确定删除该连接？此操作不可恢复。')"
      :confirm-text="t('connections.channels.delete', '删除')"
      @confirm="confirmDeleteInstance"
      @cancel="deleteTarget = null"
    />

    <ChannelConfigModal
      v-if="modalOpen"
      :instance="editing"
      :preset-type="presetType"
      :existing-names="existingNames"
      @close="modalOpen = false"
      @saved="onSaved"
    />
  </div>
</template>

<style scoped>
.hc-cxstream {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 通道与账号 tab note（锚点 prototype .cxsec .note） */
.hc-cxstream__note {
  font-size: 12px;
  color: var(--hc-text-secondary);
  margin: 0;
}

.hc-cxstream__alert {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  border-radius: var(--hc-radius-md, 10px);
  background: color-mix(in srgb, var(--hc-error) 10%, transparent);
  color: var(--hc-error);
  font-size: 12.5px;
}

.hc-cxstream__alert button {
  border: none;
  background: transparent;
  color: inherit;
  text-decoration: underline;
  cursor: pointer;
  font-size: 12px;
}

.hc-cxstream__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 14px;
}

.hc-cxcard {
  border-radius: var(--hc-radius-lg, 14px);
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-card);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-shadow: var(--hc-shadow-sm);
  transition:
    transform 0.28s var(--hc-ease-out),
    box-shadow 0.28s var(--hc-ease-out),
    border-color 0.2s var(--hc-ease-out);
}

.hc-cxcard:hover {
  border-color: var(--hc-border-hl);
  box-shadow: var(--hc-shadow-md);
  transform: translateY(-2px);
}

.hc-cxcard__top {
  display: flex;
  align-items: center;
  gap: 12px;
}

.hc-cxcard__logo {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: var(--hc-bg-hover);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--hc-accent);
}

/* 官方品牌 logo tile：浅底（单色 Simple Icons 黑色字形在浅/深主题下都清晰）。 */
.hc-cxcard__logo--brand {
  background: var(--hc-brand-tile);
  border: 1px solid var(--hc-brand-tile-border);
}

.hc-cxcard__logo img {
  width: 22px;
  height: 22px;
  object-fit: contain;
}

.hc-cxcard__head {
  flex: 1;
  min-width: 0;
}

.hc-cxcard__name {
  font-size: 14px;
  font-weight: 600;
  color: var(--hc-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hc-cxcard__meta {
  font-size: 12px;
  color: var(--hc-text-muted);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hc-cxpill {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  font-weight: 600;
  padding: 3px 9px;
  border-radius: 999px;
}

.hc-cxpill::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.hc-cxpill--green {
  background: color-mix(in srgb, var(--hc-success) 14%, transparent);
  color: var(--hc-success);
}

.hc-cxpill--amber {
  background: color-mix(in srgb, var(--hc-warning) 14%, transparent);
  color: var(--hc-warning);
}

.hc-cxpill--red {
  background: color-mix(in srgb, var(--hc-error) 12%, transparent);
  color: var(--hc-error);
}

.hc-cxpill--grey {
  background: var(--hc-bg-active);
  color: var(--hc-text-muted);
}

.hc-cxcard__caps {
  display: flex;
  align-items: center;
  gap: 6px;
}

.hc-cxcap {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 6px;
}

.hc-cxcap--receive {
  background: color-mix(in srgb, var(--hc-accent) 12%, transparent);
  color: var(--hc-accent);
}

.hc-cxcap--send {
  background: color-mix(in srgb, var(--hc-success) 12%, transparent);
  color: var(--hc-success);
}

.hc-cxcard__testresult {
  font-size: 12px;
  padding: 6px 10px;
  border-radius: 8px;
}

.hc-cxcard__testresult.is-ok {
  background: color-mix(in srgb, var(--hc-success) 8%, transparent);
  color: var(--hc-success);
}

.hc-cxcard__testresult.is-err {
  background: color-mix(in srgb, var(--hc-error) 8%, transparent);
  color: var(--hc-error);
}

.hc-cxcard__actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  padding-top: 10px;
  border-top: 1px solid var(--hc-border);
}

.hc-cxbtn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  border: 1px solid var(--hc-border);
  cursor: pointer;
  background: var(--hc-bg-card);
  color: var(--hc-text-secondary);
  transition:
    background 0.15s,
    color 0.15s,
    opacity 0.15s;
}

.hc-cxbtn:hover:not(:disabled) {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}

.hc-cxbtn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.hc-cxbtn--primary {
  background: var(--hc-accent);
  color: var(--hc-text-inverse);
  border-color: transparent;
}

.hc-cxbtn--primary:hover:not(:disabled) {
  opacity: 0.9;
  background: var(--hc-accent);
  color: var(--hc-text-inverse);
}

.hc-cxbtn--ok {
  color: var(--hc-success);
  border-color: color-mix(in srgb, var(--hc-success) 32%, transparent);
}

.hc-cxbtn--ok:hover:not(:disabled) {
  background: color-mix(in srgb, var(--hc-success) 10%, transparent);
  color: var(--hc-success);
}

.hc-cxbtn--ghost {
  background: transparent;
}

.hc-cxbtn--danger {
  background: transparent;
  color: var(--hc-error);
  border-color: color-mix(in srgb, var(--hc-error) 32%, transparent);
}

.hc-cxbtn--danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--hc-error) 10%, transparent);
  color: var(--hc-error);
}
</style>
