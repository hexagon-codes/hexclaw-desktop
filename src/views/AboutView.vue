<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import logoUrl from '@/assets/logo.png'
import hexagonLogoUrl from '@/assets/hexagon-logo.svg'

const { t } = useI18n()

const techStack = [
  { name: 'Tauri v2', detail: 'Rust', color: '#f74c00' },
  { name: 'Vue 3', detail: 'TypeScript', color: '#42b883' },
  { name: 'Go Sidecar', detail: 'hexclaw serve', color: '#00add8' },
]

const ecosystem = [
  { name: 'toolkit', emoji: '🛠', url: 'https://github.com/hexagon-codes/toolkit' },
  { name: 'ai-core', emoji: '🧠', url: 'https://github.com/hexagon-codes/ai-core' },
  { name: 'hexagon', emoji: '🔷', url: 'https://github.com/hexagon-codes/hexagon', hl: true },
  { name: 'hexclaw', emoji: '🦀', url: 'https://github.com/everyday-items/hexclaw' },
  { name: 'hexclaw-desktop', emoji: '🖥', url: 'https://github.com/hexagon-codes/hexclaw-desktop', hl: true },
  { name: 'hexagon-ui', emoji: '📊', url: 'https://github.com/hexagon-codes/hexagon-ui' },
]
</script>

<template>
  <div class="hc-about" data-tauri-drag-region>
    <!-- Hero -->
    <header class="hc-about__hero">
      <div class="hc-about__hero-pattern" />
      <div class="hc-about__identity">
        <img :src="logoUrl" alt="HexClaw" class="hc-about__logo" draggable="false" />
        <h1 class="hc-about__name">HexClaw Desktop</h1>
        <p class="hc-about__tagline">{{ t('about.subtitle', '企业级安全的个人 AI Agent 桌面客户端') }}</p>
      </div>
      <div class="hc-about__version">
        <span class="hc-about__version-tag">v0.0.2</span>
        <span class="hc-about__version-sep">·</span>
        <span class="hc-about__version-meta">Build 1</span>
        <span class="hc-about__version-sep">·</span>
        <span class="hc-about__version-meta">Apache-2.0</span>
      </div>
    </header>

    <!-- Body -->
    <main class="hc-about__body">
      <!-- Engine -->
      <section class="hc-about__engine">
        <img :src="hexagonLogoUrl" alt="Hexagon" class="hc-about__engine-logo" draggable="false" />
        <div class="hc-about__engine-info">
          <span class="hc-about__engine-sup">POWERED BY</span>
          <span class="hc-about__engine-name">Hexagon AI Agent Engine</span>
        </div>
        <span class="hc-about__engine-caps">ReAct · Tool {{ t('about.dispatch', '调度') }} · {{ t('about.declarative', '声明式编排') }}</span>
      </section>

      <!-- Tech Stack -->
      <section class="hc-about__stack">
        <div v-for="item in techStack" :key="item.name" class="hc-about__stack-row">
          <span class="hc-about__dot" :style="{ background: item.color }" />
          <span class="hc-about__stack-name">{{ item.name }}</span>
          <span class="hc-about__stack-detail">{{ item.detail }}</span>
        </div>
      </section>

      <!-- Ecosystem -->
      <section class="hc-about__eco">
        <h2 class="hc-about__section-title">HEXAGON {{ t('about.ecoLabel', '开源生态') }}</h2>
        <div class="hc-about__eco-grid">
          <a
            v-for="item in ecosystem"
            :key="item.name"
            :href="item.url"
            target="_blank"
            class="hc-about__eco-node"
            :class="{ 'hc-about__eco-node--hl': item.hl }"
          >
            <span class="hc-about__eco-emoji">{{ item.emoji }}</span>
            <span class="hc-about__eco-label">{{ item.name }}</span>
          </a>
        </div>
      </section>

      <!-- Links -->
      <nav class="hc-about__links">
        <a href="https://hexclaw.net" target="_blank">{{ t('about.website', '官网') }} · hexclaw.net</a>
        <span class="hc-about__links-sep" />
        <a href="https://github.com/hexagon-codes/hexclaw-desktop" target="_blank">GitHub</a>
        <span class="hc-about__links-sep" />
        <a href="mailto:support@hexclaw.net">{{ t('about.feedback', '反馈') }} · support@hexclaw.net</a>
      </nav>

      <!-- Footer -->
      <footer class="hc-about__footer">
        Copyright &copy; 2025–2026 hexagon-codes · Open-source under the Apache License 2.0.
      </footer>
    </main>
  </div>
</template>

<style scoped>
.hc-about {
  width: 100%;
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--hc-bg-main, #f5f5f5);
  overflow: hidden;
  user-select: none;
  -webkit-app-region: drag;
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif;
  -webkit-font-smoothing: antialiased;
}

/* ── Hero ── */
.hc-about__hero {
  position: relative;
  padding: 36px 28px 22px;
  text-align: center;
  flex-shrink: 0;
  overflow: hidden;
  background:
    radial-gradient(circle at 50% 10%, rgba(255,255,255,0.12), rgba(255,255,255,0) 28%),
    linear-gradient(135deg, #2d6f9f 0%, #4094d7 100%);
}

.hc-about__hero-pattern {
  position: absolute;
  inset: 0;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='104'%3E%3Cpath d='M60 0l52 30v60L60 120 8 90V30z' fill='none' stroke='white' stroke-width='0.7' opacity='0.08'/%3E%3C/svg%3E");
  background-size: 120px 104px;
  mix-blend-mode: screen;
  pointer-events: none;
}

.hc-about__identity {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
}

.hc-about__logo {
  width: 72px;
  height: 72px;
  border-radius: 18px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.25);
}

.hc-about__name {
  font-size: 22px;
  font-weight: 700;
  color: #fff;
  margin: 0;
  letter-spacing: -0.3px;
}

.hc-about__tagline {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.6);
  margin: 0;
}

.hc-about__version {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.hc-about__version-tag {
  font-size: 12px;
  font-weight: 600;
  color: #fff;
  background: rgba(255, 255, 255, 0.14);
  padding: 2px 10px;
  border-radius: 5px;
  backdrop-filter: blur(6px);
}

.hc-about__version-sep {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.3);
}

.hc-about__version-meta {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.45);
}

/* ── Body ── */
.hc-about__body {
  flex: 1;
  padding: 14px 20px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow: hidden;
  -webkit-app-region: no-drag;
}

/* ── Engine ── */
.hc-about__engine {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: 10px;
  background: linear-gradient(135deg, rgba(90, 159, 212, 0.08) 0%, rgba(90, 159, 212, 0.02) 100%);
  border: 1px solid rgba(90, 159, 212, 0.22);
  flex-shrink: 0;
}

.hc-about__engine-logo {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  flex-shrink: 0;
}

.hc-about__engine-info {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}

.hc-about__engine-sup {
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 1.6px;
  color: #5a9fd4;
  opacity: 0.6;
}

.hc-about__engine-name {
  font-size: 13px;
  font-weight: 700;
  color: var(--hc-text-primary, #e8e8e8);
}

.hc-about__engine-caps {
  font-size: 10px;
  color: var(--hc-text-muted, #888);
  white-space: nowrap;
  flex-shrink: 0;
}

/* ── Stack ── */
.hc-about__stack {
  display: flex;
  gap: 5px;
  flex-shrink: 0;
}

.hc-about__stack-row {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  border-radius: 7px;
  background: var(--hc-bg-card, rgba(255, 255, 255, 0.04));
  border: 1px solid var(--hc-border, rgba(255, 255, 255, 0.06));
}

.hc-about__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.hc-about__stack-name {
  font-size: 11px;
  font-weight: 600;
  color: var(--hc-text-primary, #e8e8e8);
}

.hc-about__stack-detail {
  font-size: 10px;
  color: var(--hc-text-muted, #888);
  margin-left: auto;
}

/* ── Ecosystem ── */
.hc-about__eco {
  flex-shrink: 0;
}

.hc-about__section-title {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 1.2px;
  color: var(--hc-text-muted, #888);
  margin: 0 0 8px;
  opacity: 0.7;
}

.hc-about__eco-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 5px;
}

.hc-about__eco-node {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 8px 4px;
  border-radius: 8px;
  background: var(--hc-bg-card, rgba(255, 255, 255, 0.04));
  border: 1px solid var(--hc-border, rgba(255, 255, 255, 0.06));
  text-decoration: none;
  transition: border-color 0.15s;
  cursor: pointer;
  -webkit-app-region: no-drag;
}

.hc-about__eco-node:hover {
  border-color: rgba(90, 159, 212, 0.3);
}

.hc-about__eco-node--hl {
  border-color: rgba(90, 159, 212, 0.3);
  background: rgba(90, 159, 212, 0.06);
}

.hc-about__eco-emoji {
  font-size: 16px;
  line-height: 1;
}

.hc-about__eco-label {
  font-size: 9px;
  font-weight: 600;
  color: var(--hc-text-primary, #e8e8e8);
  font-family: 'SF Mono', 'Menlo', monospace;
  text-align: center;
  word-break: break-all;
}

/* ── Links ── */
.hc-about__links {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: auto;
  flex-shrink: 0;
}

.hc-about__links a {
  font-size: 11px;
  font-weight: 500;
  color: #5a9fd4;
  text-decoration: none;
}

.hc-about__links a:hover {
  text-decoration: underline;
}

.hc-about__links-sep {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--hc-text-muted, #666);
  opacity: 0.35;
}

/* ── Footer ── */
.hc-about__footer {
  text-align: center;
  font-size: 10px;
  color: var(--hc-text-muted, #666);
  opacity: 0.5;
  padding-top: 8px;
  border-top: 1px solid var(--hc-divider, rgba(255, 255, 255, 0.06));
  line-height: 1.5;
  flex-shrink: 0;
}
</style>
