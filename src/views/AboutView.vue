<script setup lang="ts">
import { computed, onMounted, ref, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import { Wrench, BrainCircuit, Hexagon, Server, Monitor, BarChart3 } from 'lucide-vue-next'
import logoUrl from '@/assets/logo.png'
import hexagonLogoUrl from '@/assets/hexagon-engine-logo.png'
import { useAutoUpdate } from '@/composables/useAutoUpdate'
import { useToast } from '@/composables/useToast'
import { getVersion } from '@/api/system'
import { getOllamaStatus } from '@/api/ollama'

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

// 关于窗口标题跟随设置语言：document.title + Tauri 原生标题栏（后者不随 document.title 自动变）。
// 放在 watchEffect 内，切换语言时实时更新；非 Tauri(浏览器 dev) 静默跳过。
watchEffect(() => {
  const title = t('about.title', '关于河蟹')
  document.title = title
  import('@tauri-apps/api/window')
    .then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title))
    .catch(() => {})
})

const appVersion = ref('—')
const engineVersion = ref('')
// HexClaw 后端（Go sidecar = hexclaw 二进制）展示版本：优先取 sidecar 上报的 engine_version；
// 开发构建上报「(devel)」（未注入版本 ldflag）或为空时，回退到随包发布的桌面端版本（生态锁步发版）。
const hexclawVersion = computed(() => {
  const v = engineVersion.value
  if (v && !v.toLowerCase().includes('devel')) return v
  return appVersion.value !== '—' ? appVersion.value : ''
})
// Ollama 版本运行时由 getOllamaStatus() 上报真实 bundle 版本（与 engineVersion 同套路）；
// 不在前端硬编码——版本唯一源头是 Makefile OLLAMA_VERSION → bundle 二进制自报。
const ollamaVersion = ref('')
const appName = computed(() => t('about.brandAi', '河蟹 AI'))

const techStack = computed(() => [
  { name: 'Tauri v2 · Vue 3', detail: 'Rust · TypeScript', color: '#f36b2a' },
  { name: `HexClaw${hexclawVersion.value ? ' ' + hexclawVersion.value : ''}`, detail: 'Go Sidecar', color: '#00add8' },
  { name: `Ollama${ollamaVersion.value ? ' ' + ollamaVersion.value : ''}`, detail: t('about.capLocalInference', '本地推理'), color: '#7c7c7c' },
  {
    name: t('about.securityGateway', '安全网关'),
    detail: `PII · ${t('about.injectionGuard', '注入检测')}`,
    color: '#f5a623',
  },
])

const ecosystem = computed(() => [
  { name: 'toolkit', sub: t('about.ecoInfra', '基础设施'), icon: Wrench, url: 'https://github.com/hexagon-codes/toolkit' },
  { name: 'ai-core', sub: t('about.ecoLlm', 'LLM 适配'), icon: BrainCircuit, url: 'https://github.com/hexagon-codes/ai-core' },
  { name: 'hexagon', sub: t('about.ecoAgent', 'Agent 框架'), icon: Hexagon, url: 'https://github.com/hexagon-codes/hexagon' },
  { name: 'hexclaw', sub: t('about.ecoBackend', '后端服务'), icon: Server, url: 'https://github.com/everyday-items/hexclaw' },
  { name: 'hexclaw-desktop', sub: t('about.ecoDesktop', '桌面客户端'), icon: Monitor, url: 'https://github.com/hexagon-codes/hexclaw-desktop' },
  { name: 'hexagon-ui', sub: t('about.ecoConsole', 'Agent 观测台'), icon: BarChart3, url: 'https://github.com/hexagon-codes/hexagon-ui' },
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

  getVersion().then((info) => {
    if (info?.engine_version) {
      const v = info.engine_version
      engineVersion.value = v.startsWith('v') ? v : `v${v}`
    }
  }).catch(() => {})

  getOllamaStatus().then((status) => {
    if (status?.version) ollamaVersion.value = `v${status.version}`
  }).catch(() => {})
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
          <span class="hc-about-page__engine-name">Hexagon AI Agent</span>
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
            <component :is="item.icon" :size="18" class="hc-about-page__eco-emoji" />
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
  /* 对齐官网 hexclaw.net hero：顶部中心放射柔光（近白→浅蓝渐隐，取官网同款蓝 #aadbf8/#80c4f0）
     叠在浅近白蓝基底（官网 body 渐变）上，上部一抹蓝 glow、下部回到近白。 */
  background:
    radial-gradient(ellipse 100% 44% at 50% 0%, rgba(223, 242, 254, 0.95) 0%, rgba(170, 219, 248, 0.55) 34%, rgba(128, 196, 240, 0.3) 54%, rgba(232, 246, 255, 0) 82%),
    linear-gradient(180deg, #f4fbff 0%, #edf7ff 18%, #e8f6ff 100%);
  color: #1a3a5c;
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', sans-serif;
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
  /* 透明融入整页，与官网一体化（不再是独立蓝块、不再有硬分隔线） */
  background: transparent;
}

.hc-about-page__hero-pattern {
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: 0.28;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='104' viewBox='0 0 120 104'%3E%3Cpath d='M30 1h60l29 51-29 51H30L1 52 30 1z' fill='none' stroke='%234a9dd0' stroke-width='0.9' stroke-opacity='0.18'/%3E%3C/svg%3E");
  background-size: 120px 104px;
}

.hc-about-page__hero-mark,
.hc-about-page__name,
.hc-about-page__tagline,
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
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.92), rgba(255, 255, 255, 0.72));
  border: 1px solid rgba(95, 179, 234, 0.22);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.7),
    0 16px 34px rgba(22, 77, 126, 0.12);
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
  color: #12324c;
  letter-spacing: -0.01em;
}

.hc-about-page__tagline {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.4;
  font-weight: 500;
  color: rgba(18, 50, 76, 0.78);
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
  color: #12324c;
  background: rgba(255, 255, 255, 0.78);
  border: 1px solid rgba(95, 179, 234, 0.22);
}

.hc-about-page__meta-text {
  font-size: 11px;
  color: rgba(18, 50, 76, 0.55);
}

.hc-about-page__meta-action {
  height: 28px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid rgba(95, 179, 234, 0.28);
  background: rgba(255, 255, 255, 0.7);
  color: #1f5a86;
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
  background: rgba(255, 255, 255, 0.95);
  border-color: rgba(95, 179, 234, 0.4);
}

.hc-about-page__meta-action--primary {
  background: rgba(16, 168, 100, 0.12);
  border-color: rgba(16, 168, 100, 0.34);
  color: #0f8f57;
}

.hc-about-page__meta-action--primary:hover:not(:disabled) {
  background: rgba(16, 168, 100, 0.2);
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
  color: #0f8f57;
}

.hc-about-page__update-note--success {
  color: rgba(18, 50, 76, 0.72);
}

.hc-about-page__update-note--error {
  color: #c0392b;
}

.hc-about-page__update-note--idle {
  color: rgba(18, 50, 76, 0.62);
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
  color: #2a4562;
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
