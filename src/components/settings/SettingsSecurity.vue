<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { SecurityConfig } from '@/types/settings'

const { t } = useI18n()

const props = defineProps<{ security: SecurityConfig }>()
const emit = defineEmits<{ patch: [Partial<SecurityConfig>] }>()

function togglePii() {
  emit('patch', { pii_filter: !props.security.pii_filter })
}

function toggleInjection() {
  emit('patch', { injection_detection: !props.security.injection_detection })
}

function toggleConversationEncrypt() {
  emit('patch', { conversation_encrypt: !props.security.conversation_encrypt })
}

function toggleSecureStorage() {
  emit('patch', { secure_storage: !(props.security.secure_storage ?? true) })
}

function toggleKeyRotation() {
  emit('patch', { key_rotation: !props.security.key_rotation })
}
</script>

<template>
  <div class="hc-settings-section-wrap">
    <div class="hc-settings-section">
      <div class="hc-settings-section__title">{{ t('settings.security.gateway', '安全网关') }}</div>
      <div class="hc-settings-row">
        <div>
          <div class="hc-settings-row__label">{{ t('settings.security.piiFilter', 'PII 过滤') }}</div>
          <div class="hc-settings-row__desc">{{ t('settings.security.piiFilterDesc', '自动检测并遮蔽个人身份信息（身份证、手机号、银行卡等）') }}</div>
        </div>
        <div class="hc-toggle" :class="{ 'hc-toggle--on': security.pii_filter }" role="switch" :aria-checked="security.pii_filter" @click="togglePii" />
      </div>
      <div class="hc-settings-row">
        <div>
          <div class="hc-settings-row__label">{{ t('settings.security.injectionDetect', '注入检测') }}</div>
          <div class="hc-settings-row__desc">{{ t('settings.security.injectionDetectDesc', '识别并阻断 Prompt 注入、越狱攻击等恶意输入') }}</div>
        </div>
        <div class="hc-toggle" :class="{ 'hc-toggle--on': security.injection_detection }" role="switch" :aria-checked="security.injection_detection" @click="toggleInjection" />
      </div>
      <div class="hc-settings-row">
        <div>
          <div class="hc-settings-row__label">{{ t('settings.security.conversationEncrypt', '会话加密') }}</div>
          <div class="hc-settings-row__desc">{{ t('settings.security.conversationEncryptDesc', '对本地数据库中的会话记录进行 AES-256 加密存储') }}</div>
        </div>
        <div class="hc-toggle" :class="{ 'hc-toggle--on': security.conversation_encrypt }" role="switch" :aria-checked="!!security.conversation_encrypt" @click="toggleConversationEncrypt" />
      </div>
    </div>
    <div class="hc-settings-section">
      <div class="hc-settings-section__title">{{ t('settings.security.keyMgmt', 'API 密钥管理') }}</div>
      <div class="hc-settings-row">
        <div>
          <div class="hc-settings-row__label">{{ t('settings.security.secureStorage', '安全存储') }}</div>
          <div class="hc-settings-row__desc">{{ t('settings.security.secureStorageDesc', '使用系统 Keychain / Credential Manager 存储密钥') }}</div>
        </div>
        <div class="hc-toggle" :class="{ 'hc-toggle--on': security.secure_storage ?? true }" role="switch" :aria-checked="security.secure_storage ?? true" @click="toggleSecureStorage" />
      </div>
      <div class="hc-settings-row">
        <div>
          <div class="hc-settings-row__label">{{ t('settings.security.keyRotation', '密钥轮换提醒') }}</div>
          <div class="hc-settings-row__desc">{{ t('settings.security.keyRotationDesc', '密钥使用超过 90 天后提醒更换') }}</div>
        </div>
        <div class="hc-toggle" :class="{ 'hc-toggle--on': security.key_rotation }" role="switch" :aria-checked="!!security.key_rotation" @click="toggleKeyRotation" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.hc-settings-section-wrap { padding: 16px; }
.hc-settings-section { margin-bottom: 24px; }
.hc-settings-section__title {
  font-size: 13px; font-weight: 700; color: var(--hc-text-primary);
  margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid var(--hc-border);
}
.hc-settings-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 0; border-bottom: 1px solid rgba(0,0,0,0.03);
}
.hc-settings-row__label { font-size: 13px; color: var(--hc-text-primary); }
.hc-settings-row__desc { font-size: 11px; color: var(--hc-text-muted); margin-top: 2px; }
.hc-toggle {
  width: 36px; height: 20px; border-radius: 10px;
  background: var(--hc-border); position: relative; cursor: pointer;
  transition: background 0.2s; flex-shrink: 0;
}
.hc-toggle--on { background: var(--hc-accent); }
.hc-toggle::after {
  content: ''; width: 16px; height: 16px; border-radius: 50%;
  background: #fff; position: absolute; top: 2px; left: 2px;
  transition: transform 0.2s;
}
.hc-toggle--on::after { transform: translateX(16px); }
</style>
