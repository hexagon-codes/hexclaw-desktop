<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Link } from 'lucide-vue-next'
import { backendContext, backendPanelOpen } from '@/services/backend-context'
import { useAppStore } from '@/stores/app'
const app = useAppStore()
const { t } = useI18n()
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
        <div><strong>{{ t(remote ? 'settings.service.cloudTitle' : 'settings.service.localTitle') }}</strong>
          <span class="runtime-service-card__meta"><span class="backend-version" :class="{ 'backend-version--pending': !app.backendVersion }" data-backend-version><bdi v-if="app.backendVersion" dir="ltr">{{ app.backendVersion.startsWith('v') ? app.backendVersion : 'v' + app.backendVersion }}</bdi><template v-else>{{ t('settings.service.versionPending') }}</template></span> · <bdi v-if="remote" dir="ltr">{{ serviceHost }}</bdi><template v-else>{{ t('settings.service.lifecycle') }}</template></span>
        </div>
      </div>
      <span class="backend-status-pill" :class="{ 'backend-status-pill--warning': !app.sidecarReady }">{{ t(app.sidecarReady ? 'settings.system.connected' : 'settings.service.disconnected') }}</span>
    </div>
    <div class="runtime-service-card__foot">
      <span class="runtime-service-card__hint">{{ t(remote ? 'settings.service.cloudStorage' : 'settings.service.localStorage') }}<br v-if="remote" /><span v-if="remote">{{ t('settings.service.hostedHint') }}</span></span>
      <button v-if="!remote && !app.sidecarReady" class="btn btn-secondary runtime-service-card__manage" :disabled="app.isRestarting" @click="app.restartSidecar()">{{ t(app.isRestarting ? 'settings.service.restarting' : 'settings.service.restart') }}</button>
      <button class="btn btn-secondary runtime-service-card__manage" @click="backendPanelOpen = true"><Link :size="14" />{{ t('settings.service.settings') }}</button>
    </div>
  </section>
</template>
<style scoped src="./backend-service.css"></style>
