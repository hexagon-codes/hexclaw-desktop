import { watch, type Ref } from 'vue'

export function createChatThinkingTimerController(params: {
  streamingReasoningStartTime: Ref<number>
  streamingReasoningEndTime: Ref<number>
  streamingThinkingElapsed: Ref<number>
  thinkingTimer: Ref<ReturnType<typeof setInterval> | null>
}) {
  const {
    streamingReasoningStartTime,
    streamingReasoningEndTime,
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
    const stopStartTime = watch(() => streamingReasoningStartTime.value, (value) => {
      clearThinkingTimer()
      if (!value) return
      thinkingTimer.value = setInterval(() => {
        streamingThinkingElapsed.value = Math.round((Date.now() - value) / 1000)
      }, 1000)
    })

    const stopEndTime = watch(() => streamingReasoningEndTime.value, (value) => {
      if (!value || !streamingReasoningStartTime.value) return
      if (thinkingTimer.value) {
        clearInterval(thinkingTimer.value)
        thinkingTimer.value = null
      }
      streamingThinkingElapsed.value = Math.round((value - streamingReasoningStartTime.value) / 1000)
    })

    return () => { stopStartTime(); stopEndTime() }
  }

  return {
    clearThinkingTimer,
    bindThinkingTimer,
  }
}
