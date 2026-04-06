<script setup lang="ts">
import { computed, onMounted, ref, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import logoUrl from '@/assets/logo.png'
import hexagonLogoUrl from '@/assets/hexagon-engine-logo.png'
import { useAutoUpdate } from '@/composables/useAutoUpdate'
import { useToast } from '@/composables/useToast'

const { t } = useI18n()
const toast = useToast()
const {
  updateAvailable,
  updateVersion,
  checking,
  downloading,
  checkError,
  lastCheckedAt,
  checkForUpdate,
  installUpdate,
} = useAutoUpdate()

watchEffect(() => {
  document.title = t('about.title', '关于 河蟹 AI')
})

const appVersion = ref('v0.3.1')
const appName = computed(() => t('about.brandAi', '河蟹 AI'))

const techStack = computed(() => [
  { name: 'Tauri v2 · Vue 3', detail: 'Rust · TypeScript', color: '#f36b2a' },
  { name: 'Go Sidecar', detail: 'HexClaw Serve', color: '#00add8' },
  { name: 'Ollama', detail: t('about.capLocalInference', '本地推理'), color: '#7c7c7c' },
  {
    name: t('about.securityGateway', '安全网关'),
    detail: `PII · ${t('about.injectionGuard', '注入检测')}`,
    color: '#f5a623',
  },
])

const ecosystem = computed(() => [
  { name: 'toolkit', sub: t('about.ecoInfra', '基础设施'), emoji: '🛠', url: 'https://github.com/hexagon-codes/toolkit' },
  { name: 'ai-core', sub: t('about.ecoLlm', 'LLM 适配'), emoji: '🧠', url: 'https://github.com/hexagon-codes/ai-core' },
  { name: 'hexagon', sub: t('about.ecoAgent', 'Agent 框架'), emoji: '🔷', url: 'https://github.com/hexagon-codes/hexagon' },
  { name: 'hexclaw', sub: t('about.ecoBackend', '后端服务'), emoji: '🦀', url: 'https://github.com/everyday-items/hexclaw' },
  { name: 'hexclaw-desktop', sub: t('about.ecoDesktop', '桌面客户端'), emoji: '🖥', url: 'https://github.com/hexagon-codes/hexclaw-desktop' },
  { name: 'hexagon-ui', sub: t('about.ecoConsole', 'Agent 观测台'), emoji: '📊', url: 'https://github.com/hexagon-codes/hexagon-ui' },
])

function formatUpdaterErrorMessage(message: string, install = false) {
  const normalized = message.toLowerCase()
  if (normalized.includes('valid release json')) {
    return t('about.updateInvalidFeed', '当前更新源未提供有效版本信息')
  }
  if (normalized.includes('failed to fetch') || normalized.includes('network') || normalized.includes('dns')) {
    return t('about.updateSourceUnavailable', '暂时无法连接更新源')
  }
  return install
    ? t('about.updateInstallFailed', '安装更新失败')
    : t('about.updateCheckFailed', '检查更新失败')
}

const updateStatusTone = computed(() => {
  if (updateAvailable.value) return 'available'
  if (checkError.value) return 'error'
  if (lastCheckedAt.value) return 'success'
  return 'idle'
})

const updateStatusText = computed(() => {
  if (downloading.value) {
    return t('about.updateInstalling', '正在安装更新')
  }
  if (checking.value) {
    return t('about.updateChecking', '正在检查更新')
  }
  if (updateAvailable.value && updateVersion.value) {
    return t('about.updateAvailableDetail', {
      version: updateVersion.value,
    })
  }
  if (checkError.value) {
    return formatUpdaterErrorMessage(checkError.value)
  }
  if (lastCheckedAt.value) {
    return t('about.updateUpToDate', '当前已是最新版本')
  }
  return ''
})

const showUpdateStatus = computed(() => updateStatusText.value.length > 0)

async function handleCheckUpdate() {
  const result = await checkForUpdate()

  if (result.status === 'available' && result.version) {
    toast.info(t('about.updateAvailableToast', { version: result.version }))
    return
  }

  if (result.status === 'up-to-date') {
    toast.success(t('about.updateUpToDate', '当前已是最新版本'))
    return
  }

  toast.error(formatUpdaterErrorMessage(result.error || '', false))
}

async function handleInstallUpdate() {
  const result = await installUpdate()
  if (result.status === 'no-update') {
    toast.info(t('about.updateUpToDate', '当前已是最新版本'))
    return
  }

  if (result.status === 'error') {
    toast.error(formatUpdaterErrorMessage(result.error || '', true))
  }
}

onMounted(() => {
  import('@tauri-apps/api/app').then(({ getVersion }) =>
    getVersion().then((v) => (appVersion.value = 'v' + v)),
  ).catch(() => {})
})
</script>

<template>
  <div class="hc-about-page" data-tauri-drag-region>
    <header class="hc-about-page__hero">
      <div class="hc-about-page__hero-pattern" />

      <div class="hc-about-page__hero-mark">
        <img :src="logoUrl" alt="HexClaw" class="hc-about-page__logo" draggable="false" />
      </div>

      <h1 class="hc-about-page__name">{{ appName }}</h1>
      <p class="hc-about-page__tagline">
        {{ t('about.fullStack', '全栈开源') }} · Apache-2.0 {{ t('about.license', '协议') }}
      </p>
      <p class="hc-about-page__subtitle">
        {{ t('about.subtitle', '企业级安全的个人 AI Agent 桌面客户端') }}
      </p>

      <div class="hc-about-page__meta">
        <span class="hc-about-page__meta-pill">{{ appVersion }}</span>
        <button
          class="hc-about-page__meta-action hc-about-page__meta-action--secondary"
          type="button"
          :disabled="checking || downloading"
          @click="handleCheckUpdate"
        >
          {{ checking ? t('about.updateChecking', '正在检查更新') : t('about.checkUpdates', '检查更新') }}
        </button>
        <button
          v-if="updateAvailable"
          class="hc-about-page__meta-action hc-about-page__meta-action--primary"
          type="button"
          :disabled="checking || downloading"
          @click="handleInstallUpdate"
        >
          {{ downloading ? t('about.updateInstalling', '正在安装更新') : t('about.installUpdate', '下载并安装') }}
        </button>
        <span class="hc-about-page__meta-text">Apache-2.0</span>
      </div>
      <p
        v-if="showUpdateStatus"
        class="hc-about-page__update-note"
        :class="`hc-about-page__update-note--${updateStatusTone}`"
      >
        {{ updateStatusText }}
      </p>
    </header>

    <main class="hc-about-page__body">
      <section class="hc-about-page__engine">
        <img
          :src="hexagonLogoUrl"
          alt="Hexagon"
          class="hc-about-page__engine-mark"
          draggable="false"
        />
        <div class="hc-about-page__engine-info">
          <span class="hc-about-page__engine-kicker">POWERED BY</span>
          <span class="hc-about-page__engine-name">Hexagon AI Agent Engine</span>
        </div>
        <span class="hc-about-page__engine-caps">
          ReAct · Tool {{ t('about.dispatch', '调度') }} · {{ t('about.declarative', '声明式编排') }}
        </span>
      </section>

      <section class="hc-about-page__tech">
        <article v-for="item in techStack" :key="item.name" class="hc-about-page__tech-item">
          <span class="hc-about-page__tech-dot" :style="{ background: item.color }" />
          <span class="hc-about-page__tech-name">{{ item.name }}</span>
          <span class="hc-about-page__tech-detail">{{ item.detail }}</span>
        </article>
      </section>

      <section class="hc-about-page__eco">
        <h2 class="hc-about-page__eco-title">HEXAGON {{ t('about.ecoLabel', '开源生态') }}</h2>

        <div class="hc-about-page__eco-grid">
          <a
            v-for="item in ecosystem"
            :key="item.name"
            :href="item.url"
            target="_blank"
            rel="noreferrer"
            class="hc-about-page__eco-card"
          >
            <span class="hc-about-page__eco-emoji">{{ item.emoji }}</span>
            <span class="hc-about-page__eco-name">{{ item.name }}</span>
            <span class="hc-about-page__eco-sub">{{ item.sub }}</span>
          </a>
        </div>
      </section>

      <nav class="hc-about-page__links">
        <a href="https://hexclaw.net" target="_blank" rel="noreferrer">{{ t('about.website', '官网') }} · hexclaw.net</a>
        <a href="https://github.com/hexagon-codes/hexclaw-desktop" target="_blank" rel="noreferrer">GitHub</a>
        <a href="mailto:support@hexclaw.net">{{ t('about.feedback', '反馈') }} · support@hexclaw.net</a>
        <a href="mailto:ai@hexclaw.net">{{ t('about.brandAi', '河蟹 AI') }} · ai@hexclaw.net</a>
      </nav>

      <footer class="hc-about-page__footer">
        Copyright &copy; 2025–2026 hexagon-codes · Open-source under the Apache License 2.0.
      </footer>
    </main>
  </div>
</template>

<style scoped>
.hc-about-page {
  width: 100%;
  height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
  overflow: hidden;
  user-select: none;
  background: linear-gradient(180deg, #f8fafe 0%, #eef3f9 100%);
  color: #1a3a5c;
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif;
  -webkit-font-smoothing: antialiased;
  -webkit-app-region: drag;
}

/* ── Hero ── */
.hc-about-page__hero {
  position: relative;
  flex-shrink: 0;
  overflow: hidden;
  padding: 24px 24px 16px;
  text-align: center;
  background:
    radial-gradient(ellipse at 50% -20%, rgba(255, 255, 255, 0.18) 0%, transparent 60%),
    linear-gradient(160deg, #1a5580 0%, #3a7ab5 40%, #4a9ad0 100%);
  border-bottom: 1px solid rgba(76, 130, 181, 0.12);
}

.hc-about-page__hero-pattern {
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: 0.08;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='104' viewBox='0 0 120 104'%3E%3Cpath d='M30 1h60l29 51-29 51H30L1 52 30 1z' fill='none' stroke='white' stroke-width='0.9'/%3E%3C/svg%3E");
  background-size: 120px 104px;
}

.hc-about-page__hero-mark,
.hc-about-page__name,
.hc-about-page__tagline,
.hc-about-page__subtitle,
.hc-about-page__meta,
.hc-about-page__update-note {
  position: relative;
  z-index: 1;
}

.hc-about-page__hero-mark {
  width: 86px;
  height: 86px;
  margin: 0 auto 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 24px;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.18), rgba(255, 255, 255, 0.08));
  border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.12),
    0 16px 34px rgba(22, 77, 126, 0.2);
  backdrop-filter: blur(10px);
}

.hc-about-page__logo {
  width: 62px;
  height: 62px;
  object-fit: contain;
}

.hc-about-page__name {
  margin: 0;
  font-size: 20px;
  line-height: 1.2;
  font-weight: 800;
  color: #ffffff;
  letter-spacing: -0.01em;
}

.hc-about-page__tagline {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.4;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.75);
}

.hc-about-page__subtitle {
  margin: 4px 0 0;
  font-size: 11px;
  line-height: 1.45;
  color: rgba(255, 255, 255, 0.5);
}

.hc-about-page__meta {
  margin-top: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  flex-wrap: wrap;
}

.hc-about-page__meta-pill {
  padding: 4px 11px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  color: #ffffff;
  background: rgba(255, 255, 255, 0.14);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12);
}

.hc-about-page__meta-text {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.55);
}

.hc-about-page__meta-action {
  height: 28px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.12);
  color: #ffffff;
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
  -webkit-app-region: no-drag;
  transition: background 0.15s ease, transform 0.15s ease, border-color 0.15s ease;
}

.hc-about-page__meta-action:hover:not(:disabled) {
  transform: translateY(-1px);
}

.hc-about-page__meta-action:disabled {
  opacity: 0.65;
  cursor: default;
}

.hc-about-page__meta-action--secondary:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.18);
}

.hc-about-page__meta-action--primary {
  background: rgba(87, 213, 140, 0.2);
  border-color: rgba(87, 213, 140, 0.34);
}

.hc-about-page__meta-action--primary:hover:not(:disabled) {
  background: rgba(87, 213, 140, 0.28);
}

.hc-about-page__update-note {
  margin: 10px auto 0;
  max-width: 420px;
  font-size: 11px;
  line-height: 1.45;
  text-align: center;
  -webkit-app-region: no-drag;
}

.hc-about-page__update-note--available {
  color: rgba(220, 255, 230, 0.92);
}

.hc-about-page__update-note--success {
  color: rgba(255, 255, 255, 0.72);
}

.hc-about-page__update-note--error {
  color: rgba(255, 226, 226, 0.92);
}

.hc-about-page__update-note--idle {
  color: rgba(255, 255, 255, 0.62);
}

/* ── Body ── */
.hc-about-page__body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 12px 14px 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  -webkit-app-region: no-drag;
}

/* ── Engine (Powered By) — mirrors hexclaw.net .engine-bar ── */
.hc-about-page__engine {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 15px;
  border-radius: 18px;
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.9), rgba(223, 242, 254, 0.76));
  border: 1px solid #d4e2f0;
  box-shadow: 0 16px 36px rgba(95, 179, 234, 0.08);
}

.hc-about-page__engine-mark {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  flex-shrink: 0;
  object-fit: contain;
}

.hc-about-page__engine-info {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}

.hc-about-page__engine-kicker {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 1.7px;
  color: #1a5580;
  opacity: 0.72;
}

.hc-about-page__engine-name {
  font-size: 18px;
  font-weight: 700;
  color: #1a3a5c;
  white-space: nowrap;
}

.hc-about-page__engine-caps {
  flex-shrink: 0;
  font-size: 13px;
  color: #7a9ab8;
  white-space: nowrap;
  text-align: right;
}

/* ── Tech Stack ── */
.hc-about-page__tech {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.hc-about-page__tech-item {
  min-height: 0;
  display: grid;
  grid-template-columns: auto auto 1fr;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  border-radius: 12px;
  background: linear-gradient(180deg, #ffffff 0%, #f6f9fc 100%);
  border: 1px solid #dce6f0;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.9);
}

.hc-about-page__tech-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
}

.hc-about-page__tech-name {
  min-width: 0;
  font-size: 12px;
  font-weight: 700;
  color: #2a4562;
}

.hc-about-page__tech-detail {
  min-width: 0;
  margin-left: auto;
  text-align: right;
  font-size: 10px;
  font-weight: 700;
  color: #94a8bc;
  letter-spacing: 1.2px;
  text-transform: uppercase;
}

/* ── Ecosystem ── */
.hc-about-page__eco {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: #ffffff;
  border: 1px solid #dce6f0;
  border-radius: 16px;
  box-shadow: 0 4px 16px rgba(51, 83, 123, 0.04);
  padding: 12px 12px 10px;
}

.hc-about-page__eco-title {
  margin: 0 0 9px;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 2.5px;
  color: #8a9eb5;
}

.hc-about-page__eco-grid {
  flex: 1;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  grid-auto-rows: minmax(72px, 1fr);
  align-content: stretch;
  gap: 8px;
}

.hc-about-page__eco-card {
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding: 8px;
  border-radius: 12px;
  border: 1px solid #e4ebf2;
  background: linear-gradient(180deg, #ffffff 0%, #f9fbfd 100%);
  text-decoration: none;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.94);
  transition: border-color 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease;
}

.hc-about-page__eco-card:hover {
  transform: translateY(-1px);
  border-color: #bdd0e4;
  box-shadow: 0 4px 12px rgba(51, 83, 123, 0.08);
}

.hc-about-page__eco-emoji {
  font-size: 17px;
  line-height: 1;
}

.hc-about-page__eco-name {
  font-size: 11px;
  font-weight: 700;
  color: #2a4562;
  text-align: center;
}

.hc-about-page__eco-sub {
  font-size: 10px;
  color: #8a9eb5;
  text-align: center;
}

/* ── Links ── */
.hc-about-page__links {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 6px 12px;
  padding-top: 2px;
}

.hc-about-page__links a {
  font-size: 11px;
  font-weight: 600;
  color: #4a88bf;
  text-decoration: none;
  white-space: nowrap;
}

.hc-about-page__links a:hover {
  text-decoration: underline;
  color: #3672a8;
}

/* ── Footer ── */
.hc-about-page__footer {
  margin-top: 2px;
  padding-bottom: 2px;
  text-align: center;
  font-size: 10px;
  line-height: 1.35;
  color: #94a8bc;
}

@media (max-width: 460px) {
  .hc-about-page__engine {
    flex-direction: column;
    align-items: flex-start;
  }

  .hc-about-page__engine-caps {
    white-space: normal;
  }

  .hc-about-page__tech,
  .hc-about-page__eco-grid {
    grid-template-columns: 1fr;
  }
}
</style>
