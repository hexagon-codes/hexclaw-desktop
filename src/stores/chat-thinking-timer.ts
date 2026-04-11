import { watch, type Ref } from 'vue'

export function createChatThinkingTimerController(params: {
  streamingReasoningStartTime: Ref<number>
  streamingThinkingElapsed: Ref<number>
  thinkingTimer: Ref<ReturnType<typeof setInterval> | null>
}) {
  const {
    streamingReasoningStartTime,
    streamingThinkingElapsed,
    thinkingTimer,
  } = params

  function clearThinkingTimer() {
    if (thinkingTimer.value) {
      clearInterval(thinkingTimer.value)
      thinkingTimer.value = null
    }
    streamingThinkingElapsed.value = 0
  }

  function bindThinkingTimer() {
    return watch(() => streamingReasoningStartTime.value, (value) => {
      clearThinkingTimer()
      if (!value) return
      thinkingTimer.value = setInterval(() => {
        streamingThinkingElapsed.value = Math.round((Date.now() - value) / 1000)
      }, 1000)
    })
  }

  return {
    clearThinkingTimer,
    bindThinkingTimer,
  }
}
