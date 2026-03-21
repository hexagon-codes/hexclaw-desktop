<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import logoUrl from '@/assets/logo.png'
import hexagonLogoUrl from '@/assets/hexagon-logo.svg'

const { t } = useI18n()

defineProps<{
  visible: boolean
}>()

const emit = defineEmits<{
  close: []
}>()

const techStack = [
  { name: 'Tauri v2', detail: 'Rust', color: '#f74c00' },
  { name: 'Vue 3', detail: 'TypeScript', color: '#42b883' },
  { name: 'Go Sidecar', detail: 'hexclaw serve', color: '#00add8' },
  { name: t('about.securityGateway', '安全网关'), detail: 'PII · ' + t('about.injectionGuard', '注入检测'), color: '#f5a623' },
]

const ecosystem = [
  { name: 'toolkit', sub: t('about.ecoInfra', '基础设施'), emoji: '🛠', url: 'https://github.com/hexagon-codes/toolkit' },
  { name: 'ai-core', sub: t('about.ecoLlm', 'LLM 适配'), emoji: '🧠', url: 'https://github.com/hexagon-codes/ai-core' },
  { name: 'hexagon', sub: t('about.ecoAgent', 'Agent 框架'), emoji: '🔷', url: 'https://github.com/hexagon-codes/hexagon' },
  { name: 'hexclaw', sub: t('about.ecoBackend', '后端服务'), emoji: '🦀', url: 'https://github.com/everyday-items/hexclaw' },
  { name: 'hexclaw-desktop', sub: t('about.ecoDesktop', '桌面客户端'), emoji: '🖥', url: 'https://github.com/hexagon-codes/hexclaw-desktop' },
  { name: 'hexagon-ui', sub: t('about.ecoConsole', 'Agent 观测台'), emoji: '📊', url: 'https://github.com/hexagon-codes/hexagon-ui' },
]
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="visible" class="hc-about-modal-backdrop" @click.self="emit('close')">
        <div class="hc-about-modal">
          <div class="hc-about-modal__chrome">
            <div class="hc-about-modal__dots">
              <span class="hc-about-modal__dot hc-about-modal__dot--red" title="Close" @click="emit('close')" />
              <span class="hc-about-modal__dot hc-about-modal__dot--yellow" title="Minimize" @click="emit('close')" />
              <span class="hc-about-modal__dot hc-about-modal__dot--green" title="Maximize" />
            </div>
            <span class="hc-about-modal__chrome-title">{{ t('about.title', '关于 HexClaw') }}</span>
          </div>

          <div class="hc-about-modal__hero">
            <img :src="logoUrl" alt="HexClaw" class="hc-about-modal__logo" />
            <div class="hc-about-modal__name">HexClaw Desktop</div>
            <div class="hc-about-modal__subtitle">{{ t('about.subtitle', '企业级安全的个人 AI Agent 桌面客户端') }}</div>
            <div class="hc-about-modal__meta">
              <span class="hc-about-modal__pill">v0.0.2</span>
              <span>Build 1</span>
              <span>Apache-2.0</span>
            </div>
          </div>

          <div class="hc-about-modal__body">
            <!-- Powered By -->
            <div class="hc-about-modal__powered">
              <img :src="hexagonLogoUrl" alt="Hexagon" class="hc-about-modal__powered-mark" />
              <div class="hc-about-modal__powered-info">
                <span class="hc-about-modal__powered-sup">POWERED BY</span>
                <span class="hc-about-modal__powered-name">Hexagon AI Agent Engine</span>
              </div>
              <span class="hc-about-modal__powered-caps">ReAct · Tool {{ t('about.dispatch', '调度') }} · {{ t('about.declarative', '声明式编排') }}</span>
            </div>

            <!-- Tech Stack -->
            <div class="hc-about-modal__tech">
              <div v-for="item in techStack" :key="item.name" class="hc-about-modal__tech-item">
                <span class="hc-about-modal__tech-dot" :style="{ background: item.color }" />
                <span class="hc-about-modal__tech-name">{{ item.name }}</span>
                <span class="hc-about-modal__tech-detail">{{ item.detail }}</span>
              </div>
            </div>

            <!-- Ecosystem -->
            <div class="hc-about-modal__eco-section">
              <div class="hc-about-modal__eco-title">HEXAGON {{ t('about.ecoLabel', '开源生态') }}</div>
              <div class="hc-about-modal__eco-grid">
                <a
                  v-for="item in ecosystem"
                  :key="item.name"
                  :href="item.url"
                  target="_blank"
                  class="hc-about-modal__eco-node"
                >
                  <span class="hc-about-modal__eco-emoji">{{ item.emoji }}</span>
                  <span class="hc-about-modal__eco-name">{{ item.name }}</span>
                  <span class="hc-about-modal__eco-sub">{{ item.sub }}</span>
                </a>
              </div>
            </div>

            <!-- Links -->
            <div class="hc-about-modal__links">
              <a href="https://hexclaw.net" target="_blank">{{ t('about.website', '官网') }} · hexclaw.net</a>
              <span class="hc-about-modal__links-sep">·</span>
              <a href="https://github.com/hexagon-codes/hexclaw-desktop" target="_blank">GitHub</a>
              <span class="hc-about-modal__links-sep">·</span>
              <a href="mailto:support@hexclaw.net">{{ t('about.feedback', '反馈') }} · support@hexclaw.net</a>
              <span class="hc-about-modal__links-sep">·</span>
              <a href="mailto:ai@hexclaw.net">{{ t('about.brandAi', '河蟹 AI') }} · ai@hexclaw.net</a>
            </div>

            <div class="hc-about-modal__footer">
              Copyright © 2025–2026 hexagon-codes · Open-source under the Apache License 2.0.
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.hc-about-modal-backdrop {
  position: fixed; inset: 0; z-index: 1000;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,0.45); backdrop-filter: blur(6px);
}
.hc-about-modal {
  width: min(520px, 92%); max-height: 85vh;
  background: var(--hc-bg-elevated); border: 1px solid var(--hc-border);
  border-radius: var(--hc-radius-xl, 16px); overflow: hidden;
  box-shadow: 0 24px 64px rgba(0,0,0,0.2);
  display: flex; flex-direction: column;
}
.hc-about-modal__chrome {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 16px; border-bottom: 1px solid var(--hc-border);
}
.hc-about-modal__dots { display: flex; gap: 6px; }
.hc-about-modal__dot {
  width: 12px; height: 12px; border-radius: 50%; cursor: pointer;
}
.hc-about-modal__dot--red { background: #ff5f57; }
.hc-about-modal__dot--yellow { background: #febc2e; }
.hc-about-modal__dot--green { background: #28c840; }
.hc-about-modal__chrome-title {
  flex: 1; text-align: center; font-size: 12px;
  font-weight: 600; color: var(--hc-text-muted);
}

/* Hero */
.hc-about-modal__hero {
  padding: 34px 28px 22px; text-align: center;
  background: linear-gradient(150deg, #1a5580, #4a9ad0);
}
.hc-about-modal__logo {
  width: 74px; height: 74px; border-radius: 18px;
  box-shadow: 0 6px 24px rgba(0,0,0,0.25);
}
.hc-about-modal__name {
  margin-top: 12px; font-size: 20px; font-weight: 700; color: #fff;
}
.hc-about-modal__subtitle {
  margin-top: 8px; font-size: 12px; color: rgba(255,255,255,0.55);
}
.hc-about-modal__meta {
  margin-top: 16px; display: flex; align-items: center;
  justify-content: center; gap: 8px; font-size: 11px; color: rgba(255,255,255,0.4);
}
.hc-about-modal__pill {
  font-weight: 600; color: #fff; background: rgba(255,255,255,0.14);
  padding: 2px 10px; border-radius: 5px;
}

/* Body */
.hc-about-modal__body {
  flex: 1; overflow-y: auto; padding: 16px 20px;
  display: flex; flex-direction: column; gap: 14px;
}

/* Powered */
.hc-about-modal__powered {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 14px; border-radius: 12px;
  background: linear-gradient(135deg, rgba(90,159,212,0.08), rgba(90,159,212,0.02));
  border: 1px solid rgba(90,159,212,0.22);
}
.hc-about-modal__powered-mark { width: 42px; height: 42px; border-radius: 10px; }
.hc-about-modal__powered-info { display: flex; flex-direction: column; flex: 1; }
.hc-about-modal__powered-sup {
  font-size: 9px; font-weight: 700; letter-spacing: 1.2px; color: #5a9fd4; opacity: 0.6;
}
.hc-about-modal__powered-name { font-size: 14px; font-weight: 700; color: var(--hc-text-primary); }
.hc-about-modal__powered-caps { font-size: 10px; color: var(--hc-text-muted); white-space: nowrap; }

/* Tech */
.hc-about-modal__tech {
  display: grid; grid-template-columns: 1fr 1fr; gap: 6px;
}
.hc-about-modal__tech-item {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 12px; border-radius: 10px;
  background: var(--hc-bg-card); border: 1px solid var(--hc-border);
}
.hc-about-modal__tech-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.hc-about-modal__tech-name { font-size: 12px; font-weight: 600; color: var(--hc-text-primary); }
.hc-about-modal__tech-detail { font-size: 10px; color: var(--hc-text-muted); margin-left: auto; }

/* Ecosystem */
.hc-about-modal__eco-section {
  padding: 14px; border-radius: 14px;
  background: var(--hc-bg-card); border: 1px solid var(--hc-border);
}
.hc-about-modal__eco-title {
  font-size: 10px; font-weight: 600; letter-spacing: 1.2px;
  color: var(--hc-text-muted); opacity: 0.7; margin-bottom: 10px;
}
.hc-about-modal__eco-grid {
  display: grid; grid-template-columns: repeat(3, 1fr);
  gap: 6px;
}
.hc-about-modal__eco-node {
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  padding: 6px 10px; border-radius: 10px;
  background: var(--hc-bg-elevated); border: 1px solid var(--hc-border);
  text-decoration: none; transition: border-color 0.15s, background 0.15s; cursor: pointer;
}
.hc-about-modal__eco-node:hover {
  border-color: rgba(90,159,212,0.35);
  background: rgba(90,159,212,0.06);
}
.hc-about-modal__eco-emoji { font-size: 16px; }
.hc-about-modal__eco-name {
  font-size: 10px; font-weight: 600; color: var(--hc-text-primary);
  font-family: 'SF Mono', 'Fira Code', monospace;
}
.hc-about-modal__eco-sub { font-size: 9px; color: var(--hc-text-muted); }

/* Links */
.hc-about-modal__links {
  display: flex; gap: 6px; justify-content: center; align-items: center;
  flex-wrap: wrap; margin-top: auto;
}
.hc-about-modal__links a {
  font-size: 11px; color: #5a9fd4; text-decoration: none;
}
.hc-about-modal__links a:hover { text-decoration: underline; }
.hc-about-modal__links-sep {
  font-size: 10px; color: var(--hc-text-muted); opacity: 0.35;
}

/* Footer */
.hc-about-modal__footer {
  text-align: center; font-size: 10px; color: var(--hc-text-muted); opacity: 0.5;
  padding-top: 10px; border-top: 1px solid var(--hc-divider);
}

/* Transition */
.modal-enter-active, .modal-leave-active { transition: opacity 0.2s; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
</style>
