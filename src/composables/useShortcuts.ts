import { onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useChatStore } from '@/stores/chat'

/** 应用内快捷键绑定 */
export function useShortcuts() {
  const router = useRouter()
  const chatStore = useChatStore()

  function handleKeydown(e: KeyboardEvent) {
    const meta = e.metaKey || e.ctrlKey

    if (!meta) return

    switch (e.key) {
      // ⌘1~9 切换侧边栏页面
      case '1':
        e.preventDefault()
        router.push('/chat')
        break
      case '2':
        e.preventDefault()
        router.push('/agents')
        break
      case '3':
        e.preventDefault()
        router.push('/tasks')
        break
      case '4':
        e.preventDefault()
        router.push('/skills')
        break
      case '5':
        e.preventDefault()
        router.push('/logs')
        break
      case '6':
        e.preventDefault()
        router.push('/knowledge')
        break
      case '7':
        e.preventDefault()
        router.push('/settings')
        break
      // ⌘N 新建对话
      case 'n':
        if (!e.shiftKey) {
          e.preventDefault()
          chatStore.newSession()
          router.push('/chat')
        }
        break
      // ⌘, 打开设置
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
