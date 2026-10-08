<script setup lang="ts">
import { computed } from 'vue'
import { Link } from 'lucide-vue-next'
import { backendContext, backendPanelOpen } from '@/services/backend-context'
import { useAppStore } from '@/stores/app'
const app = useAppStore()
const remote = computed(() => backendContext.value?.kind === 'remote')
const serviceHost = computed(() => {
  try { return new URL(backendContext.value?.apiBase ?? '').host } catch { return '—' }
})
</script>

<template>
  <section class="runtime-service-card" data-runtime-service-summary>
    <div class="runtime-service-card__top">
      <div class="runtime-service-card__identity">
        <span class="backend-live-dot" :class="{ 'backend-live-dot--disconnected': !app.sidecarReady }" />
        <div><strong>{{ remote ? 'HexClaw 服务 · 云端' : 'HexClaw 服务 · 本机' }}</strong>
          <span class="runtime-service-card__meta"><span class="backend-version" :class="{ 'backend-version--pending': !app.backendVersion }" data-backend-version>{{ app.backendVersion ? (app.backendVersion.startsWith('v') ? app.backendVersion : 'v' + app.backendVersion) : '版本待检查' }}</span> · {{ remote ? serviceHost : '随应用启停' }}</span>
        </div>
      </div>
      <span class="backend-status-pill" :class="{ 'backend-status-pill--warning': !app.sidecarReady }">{{ app.sidecarReady ? '已连接' : '未连接' }}</span>
    </div>
    <div class="runtime-service-card__foot">
      <span class="runtime-service-card__hint">{{ remote ? '会话、知识库与模型配置存储在云端服务器。' : '会话、知识库与模型配置存储在这台设备上。' }}<br v-if="remote" /><span v-if="remote">数据由你的服务器托管</span></span>
      <button v-if="!remote && !app.sidecarReady" class="btn btn-secondary runtime-service-card__manage" :disabled="app.isRestarting" @click="app.restartSidecar()">{{ app.isRestarting ? '重启中…' : '重启服务' }}</button>
      <button class="btn btn-secondary runtime-service-card__manage" @click="backendPanelOpen = true"><Link :size="14" />服务设置</button>
    </div>
  </section>
</template>
<style scoped src="./backend-service.css"></style>
