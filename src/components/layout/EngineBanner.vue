<script setup lang="ts">
/**
 * 引擎降级 banner：sidecar 未连接时（非 running/非 starting）顶部常驻提示，
 * 替代满屏 500，进入降级模式（聊天与设置仍可浏览）。
 * 锚点 = prototype/app.html #engineBanner（.engine-banner）。
 */
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { AlertTriangle } from 'lucide-vue-next'
import { useAppStore } from '@/stores/app'

const router = useRouter()
const { t } = useI18n()
const appStore = useAppStore()

// 仅在引擎确已停止时显示（starting 走加载态、running 正常）
const visible = computed(() => appStore.sidecarStatus === 'stopped')

function goLogs() {
  router.push('/logs')
}

function reconnect() {
  void appStore.restartSidecar()
}

function startSetup() {
  router.push('/welcome')
}
</script>

<template>
  <Transition name="hc-eb">
    <div v-if="visible" class="hc-engine-banner" role="alert">
      <AlertTriangle :size="16" class="hc-engine-banner__ic" />
      <div class="hc-engine-banner__msg">
        <b>{{ t('engineBanner.title') }}</b>
        <span class="hc-engine-banner__txt">{{ t('engineBanner.desc') }}</span>
      </div>
      <div class="hc-engine-banner__sp" />
      <button class="hc-engine-banner__btn" type="button" @click="goLogs">
        {{ t('engineBanner.viewLogs') }}
      </button>
      <button
        class="hc-engine-banner__btn"
        type="button"
        :disabled="appStore.isRestarting"
        @click="reconnect"
      >
        {{ t('engineBanner.reconnect') }}
      </button>
      <button class="hc-engine-banner__btn hc-engine-banner__btn--primary" type="button" @click="startSetup">
        {{ t('engineBanner.startSetup') }}
      </button>
    </div>
  </Transition>
</template>

<style scoped>
/* 锚点 prototype .engine-banner：琥珀降级条 */
.hc-engine-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  padding: 9px 16px 9px 18px;
  font-size: 12.5px;
  color: var(--hc-warning);
  background: color-mix(in srgb, var(--hc-warning) 12%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--hc-warning) 32%, transparent);
  position: relative;
  z-index: 2;
}

.hc-engine-banner__ic {
  flex-shrink: 0;
}

.hc-engine-banner__msg {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
  min-width: 0;
}

.hc-engine-banner__msg b {
  color: var(--hc-warning);
}

.hc-engine-banner__txt {
  color: var(--hc-text-secondary);
}

.hc-engine-banner__sp {
  flex: 1;
}

.hc-engine-banner__btn {
  font: inherit;
  font-size: 12.5px;
  padding: 5px 11px;
  border-radius: 8px;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  border: 1px solid color-mix(in srgb, var(--hc-warning) 42%, transparent);
  background: transparent;
  color: var(--hc-warning);
  transition: background 0.15s, opacity 0.15s;
}

.hc-engine-banner__btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--hc-warning) 16%, transparent);
}

.hc-engine-banner__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.hc-engine-banner__btn--primary {
  background: var(--hc-warning);
  color: var(--hc-bg-elevated);
  border-color: transparent;
  font-weight: 600;
}

.hc-engine-banner__btn--primary:hover:not(:disabled) {
  background: var(--hc-warning);
  opacity: 0.9;
}

.hc-eb-enter-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.hc-eb-leave-active {
  transition: opacity 0.15s ease;
}
.hc-eb-enter-from,
.hc-eb-leave-to {
  opacity: 0;
}
.hc-eb-enter-from {
  transform: translateY(-4px);
}
</style>
