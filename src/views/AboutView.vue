<script setup lang="ts">
import logoUrl from '@/assets/logo.png'
import hexagonLogoUrl from '@/assets/hexagon-logo.svg'
</script>

<template>
  <div class="hc-about" data-tauri-drag-region>
    <!-- Hero -->
    <header class="hc-about__hero">
      <div class="hc-about__hero-bg" />
      <svg class="hc-about__hex-deco" viewBox="0 0 300 300" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <polygon points="150,10 278,84 278,216 150,290 22,216 22,84" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="1" />
        <polygon points="150,45 245,95 245,205 150,255 55,205 55,95" fill="none" stroke="rgba(255,255,255,0.035)" stroke-width="0.8" />
        <polygon points="150,78 215,112 215,188 150,222 85,188 85,112" fill="none" stroke="rgba(255,255,255,0.02)" stroke-width="0.6" />
      </svg>

      <div class="hc-about__identity">
        <img :src="logoUrl" alt="HexClaw" class="hc-about__logo" draggable="false" />
        <h1 class="hc-about__name">HexClaw Desktop</h1>
        <p class="hc-about__tagline">企业级安全的个人 AI Agent 桌面客户端</p>
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
        <span class="hc-about__engine-caps">ReAct · Tool 调度 · 声明式编排</span>
      </section>

      <!-- Tech Stack -->
      <section class="hc-about__stack">
        <div class="hc-about__stack-row">
          <span class="hc-about__dot" style="background:#f74c00" />
          <span class="hc-about__stack-name">Tauri v2</span>
          <span class="hc-about__stack-detail">Rust</span>
        </div>
        <div class="hc-about__stack-row">
          <span class="hc-about__dot" style="background:#42b883" />
          <span class="hc-about__stack-name">Vue 3</span>
          <span class="hc-about__stack-detail">TypeScript</span>
        </div>
        <div class="hc-about__stack-row">
          <span class="hc-about__dot" style="background:#00add8" />
          <span class="hc-about__stack-name">Go Sidecar</span>
          <span class="hc-about__stack-detail">hexclaw serve</span>
        </div>
        <div class="hc-about__stack-row">
          <span class="hc-about__dot" style="background:#f5a623" />
          <span class="hc-about__stack-name">安全网关</span>
          <span class="hc-about__stack-detail">PII · 注入检测</span>
        </div>
      </section>

      <!-- Ecosystem -->
      <section class="hc-about__eco">
        <h2 class="hc-about__section-title">HEXAGON 开源生态</h2>
        <div class="hc-about__eco-chain">
          <a href="https://github.com/hexagon-codes/toolkit" target="_blank" class="hc-about__eco-node">
            <span class="hc-about__eco-emoji">🛠</span>
            <span class="hc-about__eco-label">toolkit</span>
            <span class="hc-about__eco-sub">基础设施</span>
          </a>
          <span class="hc-about__eco-arrow">→</span>
          <a href="https://github.com/hexagon-codes/ai-core" target="_blank" class="hc-about__eco-node">
            <span class="hc-about__eco-emoji">🧠</span>
            <span class="hc-about__eco-label">ai-core</span>
            <span class="hc-about__eco-sub">LLM 适配</span>
          </a>
          <span class="hc-about__eco-arrow">→</span>
          <a href="https://github.com/hexagon-codes/hexagon" target="_blank" class="hc-about__eco-node hc-about__eco-node--hl">
            <span class="hc-about__eco-emoji">🔷</span>
            <span class="hc-about__eco-label">hexagon</span>
            <span class="hc-about__eco-sub">Agent 框架</span>
          </a>
          <span class="hc-about__eco-arrow">→</span>
          <a href="https://github.com/everyday-items/hexclaw" target="_blank" class="hc-about__eco-node">
            <span class="hc-about__eco-emoji">🦀</span>
            <span class="hc-about__eco-label">hexclaw</span>
            <span class="hc-about__eco-sub">后端服务</span>
          </a>
        </div>
        <div class="hc-about__eco-apps">
          <a href="https://github.com/hexagon-codes/hexclaw-desktop" target="_blank" class="hc-about__eco-app hc-about__eco-app--current">
            hexclaw-desktop<span>桌面客户端</span>
          </a>
          <a href="https://github.com/hexagon-codes/hexclaw-ui" target="_blank" class="hc-about__eco-app">
            hexclaw-ui<span>Web 客户端</span>
          </a>
          <a href="https://github.com/hexagon-codes/hexagon-ui" target="_blank" class="hc-about__eco-app">
            hexagon-ui<span>Agent 观测台</span>
          </a>
        </div>
      </section>

      <!-- Links -->
      <nav class="hc-about__links">
        <a href="https://github.com/hexagon-codes/hexclaw-desktop/releases" target="_blank">Release Notes</a>
        <span class="hc-about__links-sep" />
        <a href="https://github.com/hexagon-codes/hexclaw-desktop" target="_blank">GitHub</a>
        <span class="hc-about__links-sep" />
        <a href="https://github.com/hexagon-codes/hexclaw-desktop/issues" target="_blank">反馈问题</a>
        <span class="hc-about__links-sep" />
        <a href="mailto:ai@hexclaw.net">河蟹 AI · ai@hexclaw.net</a>
        <span class="hc-about__links-sep" />
        <a href="mailto:support@hexclaw.net">河蟹支持 · support@hexclaw.net</a>
      </nav>

      <!-- Footer -->
      <footer class="hc-about__footer">
        Copyright &copy; 2025–2026 hexagon-codes. Open-source under the Apache License 2.0.
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
  background: var(--hc-bg-main, #1a1a2e);
  overflow: hidden;
  user-select: none;
  -webkit-app-region: drag;
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif;
  -webkit-font-smoothing: antialiased;
}

/* ── Hero ── */
.hc-about__hero {
  position: relative;
  padding: 40px 32px 22px;
  flex-shrink: 0;
  overflow: hidden;
}

.hc-about__hero-bg {
  position: absolute;
  inset: 0;
  background: linear-gradient(150deg, #1a5580 0%, #2e7db5 40%, #4a9ad0 70%, #6db5e0 100%);
}

.hc-about__hex-deco {
  position: absolute;
  right: -35px;
  top: -35px;
  width: 300px;
  height: 300px;
  transform: rotate(15deg);
  pointer-events: none;
}

.hc-about__identity {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.hc-about__logo {
  width: 80px;
  height: 80px;
  border-radius: 20px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.25);
}

.hc-about__name {
  font-size: 24px;
  font-weight: 700;
  color: #fff;
  margin: 0;
  letter-spacing: -0.3px;
}

.hc-about__tagline {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.55);
  margin: 0;
  letter-spacing: 0.3px;
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
  padding: 16px 24px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  -webkit-app-region: no-drag;
}

/* ── Engine ── */
.hc-about__engine {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 10px;
  background: linear-gradient(135deg, rgba(90, 159, 212, 0.08) 0%, rgba(90, 159, 212, 0.02) 100%);
  border: 1px solid rgba(90, 159, 212, 0.22);
}

.hc-about__engine-logo {
  width: 42px;
  height: 42px;
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
  font-size: 14px;
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
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 5px;
}

.hc-about__stack-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 10px;
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
  font-size: 12px;
  font-weight: 600;
  color: var(--hc-text-primary, #e8e8e8);
}

.hc-about__stack-detail {
  font-size: 10px;
  color: var(--hc-text-muted, #888);
  margin-left: auto;
}

/* ── Ecosystem ── */
.hc-about__section-title {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 1.2px;
  color: var(--hc-text-muted, #888);
  margin: 0 0 8px;
  opacity: 0.7;
}

.hc-about__eco-chain {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  margin-bottom: 8px;
}

.hc-about__eco-node {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 6px 10px;
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
  font-size: 14px;
  line-height: 1;
}

.hc-about__eco-label {
  font-size: 10px;
  font-weight: 600;
  color: var(--hc-text-primary, #e8e8e8);
  font-family: 'SF Mono', 'Menlo', monospace;
}

.hc-about__eco-sub {
  font-size: 9px;
  color: var(--hc-text-muted, #888);
}

.hc-about__eco-arrow {
  font-size: 10px;
  color: var(--hc-text-muted, #666);
  opacity: 0.4;
  flex-shrink: 0;
}

.hc-about__eco-apps {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 5px;
}

.hc-about__eco-app {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 7px 6px;
  border-radius: 7px;
  background: var(--hc-bg-card, rgba(255, 255, 255, 0.04));
  border: 1px solid var(--hc-border, rgba(255, 255, 255, 0.06));
  font-size: 10px;
  font-weight: 600;
  color: var(--hc-text-primary, #e8e8e8);
  font-family: 'SF Mono', 'Menlo', monospace;
  text-decoration: none;
  transition: border-color 0.15s;
  cursor: pointer;
  -webkit-app-region: no-drag;
}

.hc-about__eco-app:hover {
  border-color: rgba(90, 159, 212, 0.3);
}

.hc-about__eco-app--current {
  border-color: rgba(90, 159, 212, 0.25);
  background: rgba(90, 159, 212, 0.05);
}

.hc-about__eco-app span {
  font-size: 9px;
  font-weight: 400;
  color: var(--hc-text-muted, #888);
  font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  margin-top: 2px;
}

/* ── Links ── */
.hc-about__links {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-top: auto;
}

.hc-about__links a {
  font-size: 12px;
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
}
</style>
