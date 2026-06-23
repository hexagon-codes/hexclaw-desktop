<script setup lang="ts">
/**
 * 通道配置弹层：新建 / 编辑 IM 与邮箱通道实例（两步向导 + 内嵌测试连接）。
 * 自包含表单态，从 ConnectionChannelCards / 其它入口复用，避免重复实现弹层逻辑。
 * 锚点 = prototype/app.html 的通道配置弹层。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { X, ExternalLink, Eye, EyeOff, Zap } from 'lucide-vue-next'
import {
  createIMInstance,
  updateIMInstance,
  testIMInstance,
  testSavedIMInstanceRuntime,
  testConnection,
  buildEmailTestConfig,
  getChannelMeta,
  getChannelHelpText,
  getPlatformHookUrl,
  detectEmailProvider,
  CHANNEL_TYPES,
  CHANNEL_CONFIG_FIELDS,
} from '@/api/im-channels'
import type { IMInstance, IMChannelType } from '@/api/im-channels'
import { setClipboard } from '@/api/desktop'

const props = defineProps<{
  /** null = 新建；传入实例 = 编辑该实例 */
  instance: IMInstance | null
  /** 新建时预选的通道类型；传入则跳过第一步类型选择 */
  presetType?: IMChannelType | null
  /** 已存在实例的名称集合，用于新建时生成唯一名 */
  existingNames?: string[]
}>()

const emit = defineEmits<{
  close: []
  /** 成功创建 / 更新后通知父组件刷新列表 */
  saved: []
}>()

const { t, locale } = useI18n()

const mode = computed<'create' | 'edit'>(() => (props.instance ? 'edit' : 'create'))

// 新建弹窗平台选择：全量开放（含 Telegram）。Telegram 全链路已就位——CHANNEL_TYPES + 配置字段(Bot Token)
// + logo + 后端 adapter/telegram + instances 工厂(instances/manager.go) + /connections/test 校验。
const creatableChannelTypes = computed(() => CHANNEL_TYPES)

const step = ref<1 | 2>(1)
const formType = ref<IMChannelType>('feishu')
const formName = ref('')
const formEnabled = ref(false)
const formConfig = ref<Record<string, string>>({})
const showSecrets = ref<Record<string, boolean>>({})
const saving = ref(false)
const testResult = ref<{ success: boolean; message: string } | null>(null)
const testing = ref(false)

const configFields = computed(() => CHANNEL_CONFIG_FIELDS[formType.value] || [])
const currentMeta = computed(() => getChannelMeta(formType.value))

function normalizeName(name: string): string {
  return name.trim().toLowerCase()
}

function suggestUniqueName(baseName: string): string {
  const trimmed = baseName.trim()
  if (!trimmed) return ''
  const used = new Set((props.existingNames || []).map(normalizeName))
  if (!used.has(normalizeName(trimmed))) return trimmed
  let index = 2
  while (used.has(normalizeName(`${trimmed} ${index}`))) index += 1
  return `${trimmed} ${index}`
}

// ─── 邮箱服务商识别（输入账号后按域名自动填充 SMTP / IMAP）──
const emailDetected = computed(() => {
  if (formType.value !== 'email') return null
  return detectEmailProvider(formConfig.value.email || '')
})

const emailDetectHint = computed(() => {
  if (formType.value !== 'email') return null
  const email = (formConfig.value.email || '').trim()
  if (!email || !email.includes('@')) {
    return { kind: 'idle' as const, text: t('connections.email.detectIdle') }
  }
  const p = emailDetected.value
  if (p) {
    return {
      kind: 'ok' as const,
      text: t('connections.email.detectOk', {
        name: p.name,
        smtp: `${p.smtp[0]}:${p.smtp[1]}`,
        imap: `${p.imap[0]}:${p.imap[1]}`,
      }),
    }
  }
  return { kind: 'warn' as const, text: t('connections.email.detectWarn') }
})

watch(
  () => formConfig.value.email,
  () => {
    if (formType.value !== 'email') return
    const p = emailDetected.value
    if (!p) return
    if (!formConfig.value.smtp_host?.trim()) formConfig.value.smtp_host = p.smtp[0]
    if (!formConfig.value.smtp_port?.trim()) formConfig.value.smtp_port = String(p.smtp[1])
    if (!formConfig.value.imap_host?.trim()) formConfig.value.imap_host = p.imap[0]
    if (!formConfig.value.imap_port?.trim()) formConfig.value.imap_port = String(p.imap[1])
  },
)

// 初始化表单态：编辑 → 填充实例；新建+预选类型 → 直接进第二步
function initForm() {
  testResult.value = null
  showSecrets.value = {}
  if (props.instance) {
    step.value = 2
    formType.value = props.instance.type
    formName.value = props.instance.name
    formEnabled.value = props.instance.enabled
    formConfig.value = { ...props.instance.config }
    return
  }
  if (props.presetType) {
    selectType(props.presetType)
    return
  }
  step.value = 1
  formType.value = 'feishu'
  formName.value = ''
  formEnabled.value = false
  formConfig.value = {}
}

watch(() => [props.instance, props.presetType], initForm, { immediate: true })

function selectType(type: IMChannelType) {
  formType.value = type
  const meta = getChannelMeta(type)
  formName.value = suggestUniqueName(locale.value === 'zh-CN' ? meta.name : meta.nameEn)
  formConfig.value = {}
  formEnabled.value = false
  testResult.value = null
  step.value = 2
}

function toggleSecret(key: string) {
  showSecrets.value[key] = !showSecrets.value[key]
}

async function copyWebhookUrl() {
  const text = getPlatformHookUrl({ name: formName.value, type: formType.value })
  try {
    await setClipboard(text)
  } catch {
    // 剪贴板操作失败时静默处理
  }
}

async function handleTest() {
  if (testing.value) return
  testing.value = true
  testResult.value = null
  const tempInstance: IMInstance = {
    id: props.instance?.id || '__test__',
    name: formName.value,
    type: formType.value,
    enabled: formEnabled.value,
    config: formConfig.value,
    createdAt: Date.now(),
  }
  try {
    if (formType.value === 'email') {
      // 邮箱走连接中心统一测试端点；扁平表单字段转 nested smtp/imap（后端读 config.smtp.*）。
      // 不转换会让后端 emailTestConfig 全空 → 邮箱测试 100% 失败（与 IMChannelsView 同款修法）。
      const res = await testConnection({ type: formType.value, config: buildEmailTestConfig(formConfig.value) })
      testResult.value = {
        success: res.ok,
        message:
          res.detail === 'Test endpoint unavailable'
            ? t('connections.test.unavailable')
            : res.detail,
      }
    } else if (mode.value === 'edit' && props.instance) {
      testResult.value = await testSavedIMInstanceRuntime(tempInstance)
    } else {
      testResult.value = await testIMInstance(tempInstance)
    }
  } catch (e) {
    testResult.value = {
      success: false,
      message: e instanceof Error ? e.message : t('imChannels.testFailed'),
    }
  } finally {
    testing.value = false
  }
}

const errorMsg = ref('')

async function handleSave() {
  if (saving.value) return
  saving.value = true
  errorMsg.value = ''
  try {
    if (mode.value === 'create') {
      await createIMInstance(
        formName.value.trim() || currentMeta.value.name,
        formType.value,
        formConfig.value,
        formEnabled.value,
      )
    } else if (props.instance) {
      const ok = await updateIMInstance(props.instance.id, {
        name: formName.value.trim() || currentMeta.value.name,
        enabled: formEnabled.value,
        config: formConfig.value,
      })
      if (!ok) {
        errorMsg.value = t('imChannels.saveFailedCheck')
        return
      }
    }
    emit('saved')
    emit('close')
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : t('imChannels.saveFailed')
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
                {{ t('imChannels.newChannelInstance') }}
              </template>
              <template v-else-if="mode === 'create' && step === 2">
                <img :src="currentMeta.logo" :alt="currentMeta.name" class="hc-im-modal__logo" />
                {{ t('imChannels.create') }}
                {{ locale === 'zh-CN' ? currentMeta.name : currentMeta.nameEn }}
              </template>
              <template v-else>
                <img :src="currentMeta.logo" :alt="currentMeta.name" class="hc-im-modal__logo" />
                {{ t('common.edit') }}
                {{ locale === 'zh-CN' ? currentMeta.name : currentMeta.nameEn }}
              </template>
            </h2>
            <button
              class="hc-im-btn hc-im-btn--ghost hc-im-btn--icon hc-im-btn--sm"
              @click="emit('close')"
            >
              <X :size="16" />
            </button>
          </div>

          <!-- 第一步：选择平台 -->
          <div v-if="step === 1" class="hc-im-modal__body">
            <p class="hc-im-modal__subtitle">{{ t('imChannels.selectPlatform') }}</p>
            <div class="hc-im-type-grid">
              <button
                v-for="ch in creatableChannelTypes"
                :key="ch.type"
                class="hc-im-type-card"
                @click="selectType(ch.type)"
              >
                <div class="hc-im-type-card__icon" :style="{ background: ch.color + '18' }">
                  <img :src="ch.logo" :alt="ch.name" class="hc-im-type-card__logo" />
                </div>
                <span class="hc-im-type-card__name">{{
                  locale === 'zh-CN' ? ch.name : ch.nameEn
                }}</span>
              </button>
            </div>
          </div>

          <!-- 第二步：配置 -->
          <div v-else class="hc-im-modal__body">
            <div class="hc-im-modal__type-header">
              <span
                class="hc-im-type-badge"
                :style="{ background: currentMeta.color + '20', color: currentMeta.color }"
              >
                <img :src="currentMeta.logo" :alt="currentMeta.name" class="hc-im-badge__logo" />
                {{ locale === 'zh-CN' ? currentMeta.name : currentMeta.nameEn }}
              </span>
              <a
                :href="currentMeta.helpUrl"
                target="_blank"
                rel="noopener"
                class="hc-im-help-link"
              >
                <ExternalLink :size="12" />
                {{ t('imChannels.helpDocs') }}
              </a>
            </div>

            <div class="hc-im-help-box">
              <p class="hc-im-help-box__text">{{ getChannelHelpText(formType, locale) }}</p>
            </div>

            <div class="hc-im-field">
              <label class="hc-im-field__label">{{ t('imChannels.instanceName') }}</label>
              <input
                v-model="formName"
                class="hc-im-input"
                :placeholder="t('imChannels.instanceNamePlaceholder')"
              />
            </div>

            <template v-for="field in configFields" :key="field.key">
              <div class="hc-im-field">
                <label class="hc-im-field__label">
                  {{ locale === 'zh-CN' ? field.label : field.labelEn }}
                </label>
                <div class="hc-im-input-wrap">
                  <input
                    v-model="formConfig[field.key]"
                    :type="field.secret && !showSecrets[field.key] ? 'password' : 'text'"
                    class="hc-im-input"
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

              <div
                v-if="formType === 'email' && field.key === 'email' && emailDetectHint"
                class="hc-im-email-detect"
                :class="`hc-im-email-detect--${emailDetectHint.kind}`"
              >
                {{ emailDetectHint.text }}
              </div>
            </template>

            <div class="hc-im-field hc-im-field--row">
              <label class="hc-im-field__label">{{ t('common.enable') }}</label>
              <label class="hc-im-toggle">
                <input v-model="formEnabled" type="checkbox" />
                <span class="hc-im-toggle__slider" />
              </label>
            </div>

            <div v-if="mode === 'edit' && formName" class="hc-im-field">
              <label class="hc-im-field__label">Webhook URL</label>
              <div class="hc-im-webhook-url">
                <code class="hc-im-webhook-url__text">{{
                  getPlatformHookUrl({ name: formName, type: formType })
                }}</code>
                <button
                  class="hc-im-webhook-url__copy"
                  :title="t('common.copy')"
                  @click="copyWebhookUrl"
                >
                  {{ t('common.copy') }}
                </button>
              </div>
            </div>

            <div
              v-if="errorMsg"
              class="hc-im-test-result hc-im-test-result--err"
            >
              {{ errorMsg }}
            </div>
          </div>

          <!-- 底栏（第二步常驻） -->
          <div v-if="step === 2" class="hc-im-modal__footer-wrap">
            <div
              v-if="testResult"
              class="hc-im-test-result"
              :class="testResult.success ? 'hc-im-test-result--ok' : 'hc-im-test-result--err'"
            >
              {{ testResult.message }}
            </div>
            <div class="hc-im-modal__footer">
              <button class="hc-im-btn hc-im-btn--ghost" :disabled="testing" @click="handleTest">
                <Zap :size="14" />
                {{ testing ? '...' : t('imChannels.testConnection') }}
              </button>
              <div class="flex-1" />
              <button
                v-if="mode === 'create'"
                class="hc-im-btn hc-im-btn--ghost"
                @click="step = 1"
              >
                {{ t('imChannels.back') }}
              </button>
              <button class="hc-im-btn hc-im-btn--ghost" @click="emit('close')">
                {{ t('common.cancel') }}
              </button>
              <button class="hc-im-btn hc-im-btn--primary" :disabled="saving" @click="handleSave">
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

.hc-im-modal__logo {
  width: 20px;
  height: 20px;
  object-fit: contain;
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

.hc-im-modal__footer-wrap .hc-im-test-result {
  margin: 12px 20px 0;
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

.hc-im-help-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--hc-accent);
  text-decoration: none;
}

.hc-im-help-link:hover {
  opacity: 0.8;
}

.hc-im-help-box {
  margin-bottom: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--hc-bg-hover);
}

.hc-im-help-box__text {
  font-size: 12px;
  color: var(--hc-text-secondary);
  line-height: 1.6;
  margin: 0;
}

.hc-im-email-detect {
  margin: -4px 0 12px;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.5;
}

.hc-im-email-detect--idle {
  background: var(--hc-bg-hover);
  color: var(--hc-text-muted);
}

.hc-im-email-detect--ok {
  background: color-mix(in srgb, var(--hc-success) 10%, transparent);
  color: var(--hc-success);
}

.hc-im-email-detect--warn {
  background: color-mix(in srgb, var(--hc-warning) 12%, transparent);
  color: var(--hc-warning);
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

.hc-im-webhook-url {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--hc-bg-input);
  border: 1px solid var(--hc-border);
  border-radius: 8px;
  padding: 6px 10px;
}

.hc-im-webhook-url__text {
  flex: 1;
  font-size: 11px;
  font-family: 'SF Mono', 'Fira Code', monospace;
  color: var(--hc-text-secondary);
  word-break: break-all;
  user-select: all;
}

.hc-im-webhook-url__copy {
  flex-shrink: 0;
  padding: 3px 8px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  border: none;
  background: var(--hc-accent);
  color: white;
  cursor: pointer;
  transition: opacity 0.15s;
}

.hc-im-webhook-url__copy:hover {
  opacity: 0.85;
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

.hc-im-test-result {
  font-size: 13px;
  padding: 8px 12px;
  border-radius: 8px;
}

.hc-im-test-result--ok {
  background: color-mix(in srgb, var(--hc-success) 8%, transparent);
  color: var(--hc-success);
}

.hc-im-test-result--err {
  background: color-mix(in srgb, var(--hc-error) 8%, transparent);
  color: var(--hc-error);
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
