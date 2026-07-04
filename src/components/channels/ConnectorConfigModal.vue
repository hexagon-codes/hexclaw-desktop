<script setup lang="ts">
/**
 * 数据连接器配置弹层：新建 / 编辑连接器实例（两步向导）。
 * 结构 / 样式镜像 ChannelConfigModal.vue（同 Teleport + overlay + .hc-im-modal + step1/step2），
 * 复用同一套设计令牌，避免重复实现弹层几何与交互。
 *   - 第 1 步（仅新建）：类型选择器——把 types 平铺渲染成扁平网格（无分组标题），点击进第 2 步。
 *   - 第 2 步：按连接方式 / 类型给字段（数据库类 → host/port/database/user/password；
 *     native → 路径/URL）。语雀/飞书已改走 mcp（token/app 凭证 → MCP server），无 OAuth 占位。实例名字段始终有。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { X, Eye, EyeOff, CheckCircle2, AlertCircle, Loader2 } from 'lucide-vue-next'
import { useConnectorInstances, type ConnectorInstance } from '@/composables/useConnectorInstances'
import {
  getEnabledLocalFolderAllowedPaths,
  syncLocalFolderAllowedPaths,
} from '@/composables/useLocalFolderAllowedPathsSync'
import { useToast } from '@/composables/useToast'
import { createConnector, testConnector as apiTestConnector } from '@/api/connectors'
import { addMcpServer, removeMcpServer } from '@/api/mcp'
import { MCP_CONNECTOR_SPECS, buildMcpServerConfig } from '@/config/mcp-connectors'

/** 类型选择器单源：父级从 CONNECTOR_TYPES 投影而来（含 logo / monogram 命中）。 */
export interface ConnectorTypeItem {
  id: string
  // token = §15.1 真实只读接入(GitHub/Notion，token 加密存后端)；其余为本地配置类。
  method: 'native' | 'mcp' | 'oauth' | 'token'
  logo: string | null
  monogram: string
  name: string
}

const props = defineProps<{
  /** null = 新建；传入实例 = 编辑该实例 */
  instance: ConnectorInstance | null
  /** 类型选择器数据源（父级传扁平 CONNECTOR_TYPES 投影，不分组） */
  types: ConnectorTypeItem[]
}>()

const emit = defineEmits<{
  close: []
  /** 成功创建 / 更新后通知父组件 */
  saved: []
}>()

const { t } = useI18n()
const toast = useToast()
const { list, addInstance, updateInstance } = useConnectorInstances()

const mode = computed<'create' | 'edit'>(() => (props.instance ? 'edit' : 'create'))

const step = ref<1 | 2>(1)
const formType = ref<string>('')
const formName = ref('')
const formEnabled = ref(false)
const formConfig = ref<Record<string, string>>({})
const showSecrets = ref<Record<string, boolean>>({})
const saving = ref(false)

// 当前类型在 types 里的元数据（logo / 显示名 / method），用于第 2 步表头。
const currentItem = computed<ConnectorTypeItem | null>(
  () => props.types.find((it) => it.id === formType.value) ?? null,
)

const currentName = computed(() => currentItem.value?.name ?? formType.value)
const currentMethod = computed<'native' | 'mcp' | 'oauth' | 'token'>(() => currentItem.value?.method ?? 'native')

// ── token 类(GitHub/Notion 真实只读接入) ──────────────────────
const formToken = ref('')
const showToken = ref(false)
const testing = ref(false)
const testState = ref<'idle' | 'ok' | 'fail'>('idle')
const testDetail = ref('')

/** 真实测试连接：调后端 /connectors/test（无状态验证 token，不持久化）。 */
async function runTokenTest() {
  if (testing.value || !formToken.value.trim()) return
  testing.value = true
  testState.value = 'idle'
  try {
    const res = await apiTestConnector(formType.value, formToken.value.trim())
    testState.value = res.ok ? 'ok' : 'fail'
    testDetail.value = res.detail
  } catch (e) {
    testState.value = 'fail'
    const { messageFromUnknownError } = await import('@/utils/errors')
    testDetail.value = messageFromUnknownError(e)
  } finally {
    testing.value = false
  }
}

// 字段方案：按连接方式 / 类型决定第 2 步表单字段（实例名常驻，单独渲染）。
//   - mcp 类（DB host/port/… · 语雀 token · 飞书 app_id/app_secret）→ 字段全来自 mcp-connectors.ts 声明式 schema
//   - native（localFolder/webScrape/rss/fileImport）→ 路径 / URL 单字段
interface ConfigField {
  key: string
  label: string
  placeholder: string
  secret?: boolean
}

// native 单字段：文件夹 / 文件导入给路径，网页抓取 / RSS 给 URL。
function nativeField(type: string): ConfigField {
  if (type === 'webScrape' || type === 'rss') {
    return { key: 'url', label: t('connections.connectors.form.url', 'URL 地址'), placeholder: 'https://example.com' }
  }
  return { key: 'path', label: t('connections.connectors.form.path', '路径'), placeholder: '/path/to/data' }
}

const configFields = computed<ConfigField[]>(() => {
  const type = formType.value
  if (currentMethod.value === 'mcp') {
    // 数据库类走声明式 MCP 连接器 schema（字段 → MYSQL_HOST/连接串 等，单源 mcp-connectors.ts）。
    const spec = MCP_CONNECTOR_SPECS[type]
    if (!spec) return []
    return spec.fields.map((f) => ({
      key: f.key,
      label: t(f.labelKey, f.labelFallback),
      placeholder: f.placeholder,
      secret: f.secret,
    }))
  }
  if (currentMethod.value === 'native') {
    return [nativeField(type)]
  }
  return []
})

function normalizeName(name: string): string {
  return name.trim().toLowerCase()
}

// 默认实例名 = 类型显示名，并对已存在同名去重（生产库 → 生产库 2 → 生产库 3 …）。
function suggestUniqueName(baseName: string): string {
  const trimmed = baseName.trim()
  if (!trimmed) return ''
  const used = new Set(
    list.value
      .filter((i) => i.id !== props.instance?.id)
      .map((i) => normalizeName(i.name)),
  )
  if (!used.has(normalizeName(trimmed))) return trimmed
  let index = 2
  while (used.has(normalizeName(`${trimmed} ${index}`))) index += 1
  return `${trimmed} ${index}`
}

// 初始化表单态：编辑 → 填充实例并直接进第 2 步；新建 → 回到第 1 步类型选择。
function initForm() {
  showSecrets.value = {}
  saving.value = false
  formToken.value = ''
  showToken.value = false
  testState.value = 'idle'
  testDetail.value = ''
  if (props.instance) {
    step.value = 2
    formType.value = props.instance.type
    formName.value = props.instance.name
    formEnabled.value = props.instance.enabled
    formConfig.value = { ...props.instance.config }
    return
  }
  step.value = 1
  formType.value = ''
  formName.value = ''
  formEnabled.value = false
  formConfig.value = {}
}

watch(() => props.instance, initForm, { immediate: true })

function selectType(item: ConnectorTypeItem) {
  formType.value = item.id
  formName.value = suggestUniqueName(item.name)
  formConfig.value = {}
  formEnabled.value = false
  formToken.value = ''
  testState.value = 'idle'
  testDetail.value = ''
  step.value = 2
}

function toggleSecret(key: string) {
  showSecrets.value[key] = !showSecrets.value[key]
}

async function handleSave() {
  if (saving.value) return
  const name = formName.value.trim() || currentName.value

  // 连接名唯一性：MCP 类用 name 作后端 stdio server 的 key，重名会互相覆盖（删一个把另一个也摘了）；
  // 其余类型重名也造成混淆。阻止与其它实例重名（编辑时排除自身）。新建时第一步已 suggestUniqueName，
  // 但用户可手改成重名，故保存处再守一次。
  const nameClash = list.value.some(
    (i) => i.id !== props.instance?.id && normalizeName(i.name) === normalizeName(name),
  )
  if (nameClash) {
    toast.error(t('connections.connectors.nameExists', '连接名称已存在，请改一个'))
    return
  }

  // token 类(GitHub/Notion)：走真实后端——后端验证 token、加密落盘；
  // 本地实例只存 connector_id 引用(绝不存 token，避免明文驻留)。
  if (currentMethod.value === 'token' && mode.value === 'create') {
    if (!formToken.value.trim()) {
      toast.error(t('connections.connectors.tokenRequired', '请先填写访问令牌'))
      return
    }
    saving.value = true
    try {
      const created = await createConnector(formType.value, name, formToken.value.trim())
      addInstance({
        type: formType.value,
        name: created.name || name,
        config: { connector_id: created.id },
        enabled: true,
      })
      toast.success(t('connections.connectors.connected', '已连接'))
      emit('saved')
      emit('close')
    } catch (e) {
      const { messageFromUnknownError } = await import('@/utils/errors')
      toast.error(messageFromUnknownError(e))
    } finally {
      saving.value = false
    }
    return
  }

  // MCP 数据连接器(数据库)：保存即向后端注册/更新 stdio MCP server。
  // 凭证经 env(MySQL/Mongo) 或连接串 arg(Postgres/Redis) 注入；密码字段同时由
  // useConnectorInstances 改走 secure-store（绝不明文落 localStorage）。
  if (currentMethod.value === 'mcp') {
    const spec = MCP_CONNECTOR_SPECS[formType.value]
    const built = spec ? buildMcpServerConfig(formType.value, formConfig.value) : null
    if (!spec || !built) {
      toast.error(t('connections.connectors.mcpUnsupported', '该数据源暂不支持'))
      return
    }
    // 必填校验：无默认值且非选填的字段（如 SQLite 路径）必须填。
    const missing = spec.fields.find(
      (f) => !f.optional && !f.default && !(formConfig.value[f.key] || '').trim(),
    )
    if (missing) {
      toast.error(t('connections.connectors.fieldRequired', { field: t(missing.labelKey, missing.labelFallback) }))
      return
    }
    saving.value = true
    try {
      // ★add 先行：先以新名注册成功，再（编辑改名时）摘除旧 server。
      // 若 add 失败 → 直接进 catch，旧 server 与实例都保持不变（一致），不会出现
      // “旧的删了、新的没建起来”的死状态（先删后加的半失败窗口）。
      const res = await addMcpServer(name, built.command, built.args, { env: built.env })
      if (mode.value === 'edit' && props.instance) {
        const oldName = props.instance.config?.mcp_server
        if (oldName && oldName !== name) {
          try { await removeMcpServer(oldName) } catch { /* 旧 server 可能已不在，忽略 */ }
        }
      }
      const nextConfig = { ...formConfig.value, mcp_server: name }
      if (mode.value === 'create') {
        addInstance({ type: formType.value, name, config: nextConfig, enabled: true })
      } else if (props.instance) {
        updateInstance(props.instance.id, { name, config: nextConfig, enabled: true })
      }
      // 暖装秒连 → 已就绪；冷装首次下载组件 → 后端转后台重连，诚实提示"后台连接中"。
      if (res?.connected === false) {
        toast.info(t('connections.connectors.mcpConnecting', '已添加，正在后台连接（首次需下载组件，稍后可在卡片测试）'))
      } else {
        toast.success(t('connections.connectors.mcpConnected', '数据连接已就绪'))
      }
      emit('saved')
      emit('close')
    } catch (e) {
      const { messageFromUnknownError } = await import('@/utils/errors')
      toast.error(t('connections.connectors.mcpAddFailed', { msg: messageFromUnknownError(e) }))
    } finally {
      saving.value = false
    }
    return
  }

  // 本地配置类(文件 / OAuth stub)：保持既有 localStorage 行为。
  saving.value = true
  try {
    if (mode.value === 'create') {
      addInstance({
        type: formType.value,
        name,
        config: { ...formConfig.value },
        enabled: formEnabled.value,
      })
    } else if (props.instance) {
      updateInstance(props.instance.id, {
        name,
        config: { ...formConfig.value },
        enabled: formEnabled.value,
      })
    }
    if (formType.value === 'localFolder') {
      await syncLocalFolderAllowedPaths(getEnabledLocalFolderAllowedPaths(list.value))
    }
    emit('saved')
    emit('close')
  } catch (e) {
    const { messageFromUnknownError } = await import('@/utils/errors')
    toast.error(messageFromUnknownError(e))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="hc-modal" appear>
      <div class="hc-im-overlay" @click.self="emit('close')">
        <div class="hc-im-modal">
          <div class="hc-im-modal__header">
            <h2 class="hc-im-modal__title">
              <template v-if="mode === 'create' && step === 1">
                {{ t('connections.connectors.newInstance', '添加数据连接') }}
              </template>
              <template v-else-if="mode === 'create' && step === 2">
                {{ t('common.create') }} {{ currentName }}
              </template>
              <template v-else>
                {{ t('common.edit') }} {{ currentName }}
              </template>
            </h2>
            <button
              class="hc-im-btn hc-im-btn--ghost hc-im-btn--icon hc-im-btn--sm"
              @click="emit('close')"
            >
              <X :size="16" />
            </button>
          </div>

          <!-- 第一步：选择连接器类型（扁平网格，无分组标题，所有类型平铺一起） -->
          <div v-if="step === 1" class="hc-im-modal__body">
            <p class="hc-im-modal__subtitle">
              {{ t('connections.connectors.selectType', '选择要连接的数据源类型') }}
            </p>
            <div class="hc-im-type-grid">
              <button
                v-for="it in types"
                :key="it.id"
                class="hc-im-type-card"
                :data-testid="`connector-type-${it.id}`"
                @click="selectType(it)"
              >
                <div class="hc-im-type-card__icon hc-ck-tile">
                  <img v-if="it.logo" :src="it.logo" :alt="it.name" class="hc-im-type-card__logo" />
                  <span v-else class="hc-ck-mono">{{ it.monogram }}</span>
                </div>
                <span class="hc-im-type-card__name">{{ it.name }}</span>
              </button>
            </div>
          </div>

          <!-- 第二步：配置表单 -->
          <div v-else class="hc-im-modal__body">
            <div class="hc-im-modal__type-header">
              <span class="hc-im-type-badge">
                <img v-if="currentItem?.logo" :src="currentItem.logo" :alt="currentName" class="hc-im-badge__logo" />
                {{ currentName }}
              </span>
            </div>

            <!-- 实例名（始终有） -->
            <div class="hc-im-field">
              <label class="hc-im-field__label">{{ t('connections.connectors.form.name', '实例名') }}</label>
              <input
                v-model="formName"
                class="hc-im-input"
                data-testid="connector-name-input"
                :placeholder="t('connections.connectors.form.namePlaceholder', '例如：生产库 / 分析库')"
              />
            </div>

            <!-- 配置字段（按方式 / 类型） -->
            <div v-for="field in configFields" :key="field.key" class="hc-im-field">
              <label class="hc-im-field__label">{{ field.label }}</label>
              <div class="hc-im-input-wrap">
                <input
                  v-model="formConfig[field.key]"
                  :type="field.secret && !showSecrets[field.key] ? 'password' : 'text'"
                  class="hc-im-input"
                  :data-testid="`connector-config-${field.key}`"
                  :placeholder="field.placeholder"
                />
                <button
                  v-if="field.secret"
                  class="hc-im-input-eye"
                  @click="toggleSecret(field.key)"
                >
                  <component :is="showSecrets[field.key] ? EyeOff : Eye" :size="14" />
                </button>
              </div>
            </div>

            <!-- token(GitHub/Notion)：真实只读接入——填访问令牌 + 真实测试连接 -->
            <div v-if="currentMethod === 'token'" class="hc-im-field">
              <label class="hc-im-field__label">{{ t('connections.connectors.form.token', '访问令牌 (Token)') }}</label>
              <div class="hc-im-input-wrap">
                <input
                  v-model="formToken"
                  :type="showToken ? 'text' : 'password'"
                  class="hc-im-input"
                  :placeholder="t('connections.connectors.form.tokenPlaceholder', '粘贴只读访问令牌')"
                />
                <button class="hc-im-input-eye" @click="showToken = !showToken">
                  <component :is="showToken ? EyeOff : Eye" :size="14" />
                </button>
              </div>
              <p class="hc-ck-authhint">
                {{ formType === 'notion'
                  ? t('connections.connectors.tokenHintNotion', '在 Notion 设置 → 连接 → 新建 Integration 生成 token，并把要读取的页面分享给它')
                  : t('connections.connectors.tokenHintGithub', '在 GitHub 设置 → Developer settings → Personal access token 生成只读 token') }}
              </p>
              <div class="hc-ck-testrow">
                <button
                  class="hc-im-btn hc-im-btn--ghost"
                  :disabled="testing || !formToken.trim()"
                  @click="runTokenTest"
                >
                  <Loader2 v-if="testing" :size="14" class="hc-ck-spin" />
                  {{ testing ? t('connections.connectors.testing', '测试中…') : t('connections.channels.test') }}
                </button>
                <span v-if="testState === 'ok'" class="hc-ck-testres hc-ck-testres--ok">
                  <CheckCircle2 :size="13" /> {{ testDetail }}
                </span>
                <span v-else-if="testState === 'fail'" class="hc-ck-testres hc-ck-testres--fail">
                  <AlertCircle :size="13" /> {{ testDetail }}
                </span>
              </div>
            </div>

            <div v-if="currentMethod !== 'token' && currentMethod !== 'mcp'" class="hc-im-field hc-im-field--row">
              <label class="hc-im-field__label">{{ t('common.enable') }}</label>
              <label class="hc-im-toggle" data-testid="connector-enabled-toggle">
                <input v-model="formEnabled" type="checkbox" data-testid="connector-enabled" />
                <span class="hc-im-toggle__slider" />
              </label>
            </div>
          </div>

          <!-- 底栏（第二步常驻） -->
          <div v-if="step === 2" class="hc-im-modal__footer-wrap">
            <div class="hc-im-modal__footer">
              <div class="flex-1" />
              <button
                v-if="mode === 'create'"
                class="hc-im-btn hc-im-btn--ghost"
                @click="step = 1"
              >
                {{ t('imChannels.back', '上一步') }}
              </button>
              <button class="hc-im-btn hc-im-btn--ghost" @click="emit('close')">
                {{ t('common.cancel') }}
              </button>
              <button class="hc-im-btn hc-im-btn--primary" data-testid="connector-save" :disabled="saving" @click="handleSave">
                {{ saving ? '...' : mode === 'create' ? t('common.create') : t('common.save') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.hc-im-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  border: none;
  cursor: pointer;
  transition:
    background 0.15s,
    opacity 0.15s;
  white-space: nowrap;
}

.hc-im-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.hc-im-btn--primary {
  background: var(--hc-accent);
  color: var(--hc-text-inverse);
}

.hc-im-btn--primary:hover:not(:disabled) {
  opacity: 0.9;
}

.hc-im-btn--ghost {
  background: var(--hc-bg-hover);
  color: var(--hc-text-secondary);
}

.hc-im-btn--ghost:hover:not(:disabled) {
  background: var(--hc-bg-active);
  color: var(--hc-text-primary);
}

.hc-im-btn--sm {
  padding: 4px 8px;
  font-size: 12px;
}

.hc-im-btn--icon {
  padding: 4px;
}

.hc-im-toggle {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
  cursor: pointer;
}

.hc-im-toggle input {
  opacity: 0;
  width: 0;
  height: 0;
}

.hc-im-toggle__slider {
  position: absolute;
  inset: 0;
  background: var(--hc-bg-hover);
  border-radius: 10px;
  transition: background 0.2s;
}

.hc-im-toggle__slider::before {
  content: '';
  position: absolute;
  width: 16px;
  height: 16px;
  left: 2px;
  bottom: 2px;
  background: var(--hc-text-inverse);
  border-radius: 50%;
  transition: transform 0.2s;
  box-shadow:
    0 1px 3px rgba(0, 0, 0, 0.06),
    0 1px 2px rgba(0, 0, 0, 0.04);
}

.hc-im-toggle input:checked + .hc-im-toggle__slider {
  background: var(--hc-accent);
}

.hc-im-toggle input:checked + .hc-im-toggle__slider::before {
  transform: translateX(16px);
}

.hc-im-type-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 500;
  padding: 3px 10px;
  border-radius: 6px;
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
}

.hc-im-badge__logo {
  width: 14px;
  height: 14px;
  object-fit: contain;
  vertical-align: middle;
}

.hc-im-overlay {
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

.hc-im-modal {
  width: 520px;
  max-width: calc(100vw - 48px);
  max-height: 86vh;
  border-radius: 16px;
  background: var(--hc-bg-main, #fff);
  border: 1px solid var(--hc-border);
  box-shadow:
    0 20px 40px rgba(0, 0, 0, 0.12),
    0 8px 16px rgba(0, 0, 0, 0.06);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.hc-im-modal__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--hc-border);
}

.hc-im-modal__title {
  font-size: 16px;
  font-weight: 600;
  color: var(--hc-text-primary);
  margin: 0;
  display: flex;
  align-items: center;
  gap: 4px;
}

.hc-im-modal__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 20px;
}

.hc-im-modal__subtitle {
  font-size: 13px;
  color: var(--hc-text-secondary);
  margin: 0 0 16px;
}

.hc-im-modal__footer-wrap {
  flex-shrink: 0;
  border-top: 1px solid var(--hc-border);
}

.hc-im-modal__footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 20px;
}

.hc-im-modal__type-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

/* 类型选择器（第 1 步）：扁平网格（无分组标题，所有类型平铺一起） */
.hc-im-type-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}

.hc-im-type-card {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-start;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-card);
  cursor: pointer;
  transition:
    border-color 0.15s,
    box-shadow 0.15s,
    transform 0.15s;
}

.hc-im-type-card:hover {
  border-color: var(--hc-accent);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
  transform: translateY(-2px);
}

.hc-im-type-card__icon {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 浅底 tile：官方品牌 logo 多为单色，浅底在双主题下都清晰（对齐 ConnectionsView） */
.hc-ck-tile {
  background: var(--hc-brand-tile);
  border: 1px solid var(--hc-brand-tile-border);
}

/* 缺图 → 首字母 monogram（accent-subtle 底，accent 字） */
.hc-ck-mono {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  border-radius: inherit;
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
  font-size: 14px;
  font-weight: 600;
}

.hc-im-type-card__logo {
  width: 20px;
  height: 20px;
  object-fit: contain;
}

.hc-im-type-card__name {
  font-size: 13px;
  font-weight: 500;
  text-align: left;
  color: var(--hc-text-primary);
}

/* token 测试连接行 */
.hc-ck-testrow {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
  flex-wrap: wrap;
}
.hc-ck-spin {
  animation: hc-ck-spin 0.8s linear infinite;
}
@keyframes hc-ck-spin {
  to { transform: rotate(360deg); }
}
.hc-ck-testres {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
}
.hc-ck-testres--ok { color: var(--hc-spring, #10b981); }
.hc-ck-testres--fail { color: var(--hc-amber, #ef4444); }

/* OAuth 授权占位按钮 + 提示 */
.hc-ck-authbtn {
  width: 100%;
  justify-content: center;
  padding: 9px 12px;
}

.hc-ck-authhint {
  font-size: 12px;
  color: var(--hc-text-muted);
  line-height: 1.5;
  margin: 8px 0 0;
}

.hc-im-field {
  margin-bottom: 12px;
}

.hc-im-field--row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.hc-im-field__label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  color: var(--hc-text-secondary);
  margin-bottom: 6px;
}

.hc-im-field--row .hc-im-field__label {
  margin-bottom: 0;
}

.hc-im-input-wrap {
  position: relative;
}

.hc-im-input {
  width: 100%;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-main);
  color: var(--hc-text-primary);
  font-size: 13px;
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.15s;
}

.hc-im-input:focus {
  border-color: var(--hc-accent);
}

.hc-im-input::placeholder {
  color: var(--hc-text-muted);
}

.hc-im-input-eye {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  color: var(--hc-text-muted);
  cursor: pointer;
  padding: 2px;
  display: flex;
}

.hc-im-input-wrap .hc-im-input {
  padding-right: 32px;
}

.hc-modal-enter-active,
.hc-modal-leave-active {
  transition: opacity 0.2s ease;
}

.hc-modal-enter-active .hc-im-modal,
.hc-modal-leave-active .hc-im-modal {
  transition:
    transform 0.2s ease,
    opacity 0.2s ease;
}

.hc-modal-enter-from,
.hc-modal-leave-to {
  opacity: 0;
}

.hc-modal-enter-from .hc-im-modal,
.hc-modal-leave-to .hc-im-modal {
  transform: scale(0.95);
  opacity: 0;
}
</style>
