<script setup lang="ts">
import { computed, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import logoUrl from '@/assets/logo.png'
import hexagonWordmarkUrl from '@/assets/hexagon-wordmark.jpg'

const { t } = useI18n()

watchEffect(() => {
  document.title = t('about.title', '关于 河蟹 AI')
})

const appName = computed(() => t('about.brandAi', '河蟹 AI'))

const techStack = computed(() => [
  { name: 'Tauri v2', detail: 'Rust', color: '#f36b2a' },
  { name: 'Vue 3', detail: 'TypeScript', color: '#4fc67e' },
  { name: 'Go Sidecar', detail: 'HexClaw Serve', color: '#2eb3e8' },
  {
    name: t('about.securityGateway', '安全网关'),
    detail: `PII · ${t('about.injectionGuard', '注入检测')}`,
    color: '#f2b53b',
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
</script>

<template>
  <div class="hc-about-page" data-tauri-drag-region>
    <header class="hc-about-page__hero">
      <div class="hc-about-page__hero-pattern" />

      <div class="hc-about-page__hero-mark">
        <img :src="logoUrl" alt="HexClaw" class="hc-about-page__logo" draggable="false" />
      </div>

      <h1 class="hc-about-page__name">{{ appName }}</h1>
      <p class="hc-about-page__subtitle">
        {{ t('about.subtitle', '企业级安全的个人 AI Agent 桌面客户端') }}
      </p>

      <div class="hc-about-page__meta">
        <span class="hc-about-page__meta-pill">v0.0.2</span>
        <span class="hc-about-page__meta-text">Build 1</span>
        <span class="hc-about-page__meta-text">Apache-2.0</span>
      </div>
    </header>

    <main class="hc-about-page__body">
      <section class="hc-about-page__engine">
        <div class="hc-about-page__engine-brand">
          <div class="hc-about-page__engine-copy">
            <span class="hc-about-page__engine-kicker">POWERED BY</span>
            <img
              :src="hexagonWordmarkUrl"
              alt="Hexagon AI Agent Engine"
              class="hc-about-page__engine-wordmark"
              draggable="false"
            />
          </div>
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
  background: linear-gradient(180deg, #fbfcfe 0%, #f5f7fb 100%);
  color: #24415f;
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif;
  -webkit-font-smoothing: antialiased;
  -webkit-app-region: drag;
}

.hc-about-page__hero {
  position: relative;
  flex-shrink: 0;
  overflow: hidden;
  padding: 24px 24px 16px;
  text-align: center;
  background:
    radial-gradient(circle at 50% -10%, rgba(255, 255, 255, 0.22), rgba(255, 255, 255, 0) 34%),
    linear-gradient(145deg, #3a77b2 0%, #468aca 48%, #5ca7e2 100%);
  border-bottom: 1px solid rgba(76, 130, 181, 0.18);
}

.hc-about-page__hero-pattern {
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: 0.12;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='104' viewBox='0 0 120 104'%3E%3Cpath d='M30 1h60l29 51-29 51H30L1 52 30 1z' fill='none' stroke='white' stroke-width='0.9'/%3E%3C/svg%3E");
  background-size: 120px 104px;
}

.hc-about-page__hero-mark,
.hc-about-page__name,
.hc-about-page__subtitle,
.hc-about-page__meta {
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
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.2), rgba(255, 255, 255, 0.1));
  border: 1px solid rgba(255, 255, 255, 0.16);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.14),
    0 16px 34px rgba(22, 77, 126, 0.18);
  backdrop-filter: blur(10px);
}

.hc-about-page__logo {
  width: 62px;
  height: 62px;
  object-fit: contain;
}

.hc-about-page__name {
  margin: 0;
  font-size: 18px;
  line-height: 1.2;
  font-weight: 700;
  color: #ffffff;
}

.hc-about-page__subtitle {
  margin: 7px 0 0;
  font-size: 11px;
  line-height: 1.45;
  color: rgba(255, 255, 255, 0.6);
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
  background: rgba(255, 255, 255, 0.16);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.18);
}

.hc-about-page__meta-text {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.7);
}

.hc-about-page__body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 12px 14px 8px;
  display: flex;
  flex-direction: column;
  gap: 9px;
  -webkit-app-region: no-drag;
}

.hc-about-page__engine,
.hc-about-page__eco {
  background: #ffffff;
  border: 1px solid #dbe5f0;
  border-radius: 18px;
  box-shadow: 0 8px 24px rgba(51, 83, 123, 0.05);
}

.hc-about-page__engine {
  padding: 10px 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.hc-about-page__engine-brand {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
}

.hc-about-page__engine-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.hc-about-page__engine-kicker {
  font-size: 8px;
  font-weight: 800;
  letter-spacing: 2.8px;
  color: #4c89c9;
}

.hc-about-page__engine-wordmark {
  display: block;
  width: 196px;
  max-width: 100%;
  height: auto;
}

.hc-about-page__engine-caps {
  flex-shrink: 0;
  font-size: 9px;
  color: #8398b2;
  white-space: nowrap;
  text-align: right;
}

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
  background: linear-gradient(180deg, #f4f8fc 0%, #edf2f8 100%);
  border: 1px solid #d7e1ed;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.85);
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
  color: #2f445d;
}

.hc-about-page__tech-detail {
  min-width: 0;
  margin-left: auto;
  text-align: right;
  font-size: 10px;
  font-weight: 700;
  color: #9aaabd;
  letter-spacing: 1.2px;
  text-transform: uppercase;
}

.hc-about-page__eco {
  padding: 10px 10px 9px;
}

.hc-about-page__eco-title {
  margin: 0 0 9px;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 2.5px;
  color: #90a2b7;
}

.hc-about-page__eco-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.hc-about-page__eco-card {
  min-height: 72px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding: 8px 8px;
  border-radius: 14px;
  border: 1px solid #e3e8f0;
  background: linear-gradient(180deg, #ffffff 0%, #fbfdff 100%);
  text-decoration: none;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.94);
  transition: border-color 0.15s ease, transform 0.15s ease;
}

.hc-about-page__eco-card:hover {
  transform: translateY(-1px);
  border-color: #c8d8ea;
}

.hc-about-page__eco-emoji {
  font-size: 17px;
  line-height: 1;
}

.hc-about-page__eco-name {
  font-size: 11px;
  font-weight: 700;
  color: #2f445d;
  text-align: center;
}

.hc-about-page__eco-sub {
  font-size: 10px;
  color: #93a3b7;
  text-align: center;
}

.hc-about-page__links {
  margin-top: 1px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 6px 12px;
  padding-top: 0;
}

.hc-about-page__links a {
  font-size: 11px;
  font-weight: 600;
  color: #4c89c9;
  text-decoration: none;
  white-space: nowrap;
}

.hc-about-page__links a:hover {
  text-decoration: underline;
}

.hc-about-page__footer {
  margin-top: -1px;
  text-align: center;
  font-size: 10px;
  line-height: 1.35;
  color: #98a7b9;
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
