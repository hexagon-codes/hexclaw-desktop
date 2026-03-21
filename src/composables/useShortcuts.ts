import { onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useChatStore } from '@/stores/chat'
import { navigationItems } from '@/config/navigation'

export function useShortcuts() {
  const router = useRouter()
  const chatStore = useChatStore()

  const numKeyRoutes: Record<string, string> = {}
  navigationItems.forEach((item, idx) => {
    if (idx < 9) numKeyRoutes[String(idx + 1)] = item.path
  })

  function handleKeydown(e: KeyboardEvent) {
    const meta = e.metaKey || e.ctrlKey

    if (!meta) return

    const targetRoute = numKeyRoutes[e.key]
    if (targetRoute) {
      e.preventDefault()
      router.push(targetRoute)
      return
    }

    switch (e.key) {
      case 'n':
        if (!e.shiftKey) {
          e.preventDefault()
          chatStore.newSession()
          router.push('/chat')
        }
        break
      case ',':
        e.preventDefault()
        router.push('/settings')
        break
    }
  }

  onMounted(() => {
    window.addEventListener('keydown', handleKeydown)
  })

  onUnmounted(() => {
    window.removeEventListener('keydown', handleKeydown)
  })
}
