<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import AppLayout from '@/components/layout/AppLayout.vue'
import ToastProvider from '@/components/common/ToastProvider.vue'
import ErrorBoundary from '@/components/common/ErrorBoundary.vue'
import { useShortcuts } from '@/composables/useShortcuts'
import { useTheme } from '@/composables/useTheme'
import { useAutoUpdate } from '@/composables/useAutoUpdate'
import { useToast } from '@/composables/useToast'
import { useNotificationCenter } from '@/composables/useNotificationCenter'
import { useLocalFolderAllowedPathsSync } from '@/composables/useLocalFolderAllowedPathsSync'
import { installScrollReveal } from '@/utils/scroll-reveal'

const route = useRoute()
const router = useRouter()
const isBlankLayout = computed(() => route.meta.layout === 'blank')
const { t } = useI18n()
const toast = useToast()
const { checkForUpdate } = useAutoUpdate()
const notificationCenter = useNotificationCenter()

const toastRef = ref<InstanceType<typeof ToastProvider>>()

// 注册应用内快捷键 (⌘1~7 切页, ⌘N 新对话, ⌘, 设置)
useShortcuts()
// 初始化主题
useTheme()
// 本地目录连接器授权需要在应用启动时同步到 HexClaw FileAccess，不能依赖用户打开连接页。
useLocalFolderAllowedPathsSync()

// 全局 toast
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__hcToast = toastRef
}

// 通知中心：订阅全局异步事件（审批 / 记忆 / 重连 / 引擎状态）→ 通知台账
notificationCenter.start()

// 监听 Tauri 托盘导航事件 (替代不安全的 window.eval)
let unlistenNavigate: (() => void) | null = null
let teardownScrollReveal: (() => void) | undefined
onMounted(async () => {
  // 滚动条「滚动中浮现」：一处捕获监听覆盖全应用滚动容器（见 utils/scroll-reveal）。
  teardownScrollReveal = installScrollReveal()

  try {
    const { listen } = await import('@tauri-apps/api/event')
    unlistenNavigate = await listen<string>('navigate', (event) => {
      router.push(event.payload)
    })
  } catch {
    // 非 Tauri 环境 (浏览器开发模式)
  }

  const updateResult = await checkForUpdate()
  if (updateResult.status === 'available' && updateResult.version) {
    toast.info(t('about.updateAvailableToast', { version: updateResult.version }))
  }
})
onUnmounted(() => {
  unlistenNavigate?.()
  notificationCenter.stop()
  teardownScrollReveal?.()
})
</script>

<template>
  <ErrorBoundary>
    <AppLayout v-if="!isBlankLayout">
      <RouterView v-slot="{ Component, route: viewRoute }">
        <component :is="Component" :key="viewRoute.path" />
      </RouterView>
    </AppLayout>
    <RouterView v-else />
  </ErrorBoundary>
  <ToastProvider ref="toastRef" />
</template>
