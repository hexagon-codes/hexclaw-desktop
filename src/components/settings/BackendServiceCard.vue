<script setup lang="ts">
import { computed } from 'vue'
import { Link } from 'lucide-vue-next'
import { backendContext, backendPanelOpen } from '@/services/backend-context'
import { useAppStore } from '@/stores/app'
const app = useAppStore()
const remote = computed(() => backendContext.value?.kind === 'remote')
</script>

<template>
  <section class="runtime-service-card" data-runtime-service-summary>
    <div class="runtime-service-card__top">
      <div class="runtime-service-card__identity">
        <span class="backend-live-dot" :class="{ 'backend-live-dot--disconnected': !app.sidecarReady }" />
        <div><strong>{{ remote ? '远端服务' : '本机服务' }}</strong>
          <span class="runtime-service-card__meta">{{ remote ? backendContext?.apiBase : 'HexClaw 后端服务' }} · {{ remote ? 'API v1' : '自动管理' }}</span>
        </div>
      </div>
      <span class="backend-status-pill" :class="{ 'backend-status-pill--warning': !app.sidecarReady }">{{ app.sidecarReady ? '已连接' : '未连接' }}</span>
    </div>
    <div class="runtime-service-card__foot">
      <span class="runtime-service-card__hint">会话、知识库和模型配置归属当前服务。</span>
      <button v-if="!remote && !app.sidecarReady" class="btn btn-secondary runtime-service-card__manage" :disabled="app.isRestarting" @click="app.restartSidecar()">{{ app.isRestarting ? '重启中…' : '重启服务' }}</button>
      <button class="btn btn-secondary runtime-service-card__manage" @click="backendPanelOpen = true"><Link :size="14" />管理后端服务</button>
    </div>
  </section>
</template>
<style scoped src="./backend-service.css"></style>
