<script setup lang="ts">
import { ref, nextTick, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { MessageSquarePlus } from 'lucide-vue-next'
import { useChatStore } from '@/stores/chat'
import { useAgentsStore } from '@/stores/agents'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'
import MessageActions from '@/components/chat/MessageActions.vue'
import ChatInput from '@/components/chat/ChatInput.vue'
import SessionList from '@/components/chat/SessionList.vue'
import EmptyState from '@/components/common/EmptyState.vue'

const { t } = useI18n()
const chatStore = useChatStore()
const agentsStore = useAgentsStore()

const messagesEndRef = ref<HTMLDivElement>()
const chatInputRef = ref<InstanceType<typeof ChatInput>>()
const showSessions = ref(true)
const hoveredMsgId = ref<string | null>(null)

onMounted(() => {
  chatStore.loadSessions()
  agentsStore.loadRoles()
})

async function handleSend(text: string) {
  await chatStore.sendMessage(text)
  await nextTick()
  scrollToBottom()
}

async function handleRetry(msgIndex: number) {
  // 找到该 assistant 消息之前的最后一条 user 消息
  const msgs = chatStore.messages
  for (let i = msgIndex - 1; i >= 0; i--) {
    if (msgs[i]?.role === 'user') {
      // 移除该 assistant 消息及之后的消息
      chatStore.messages.splice(msgIndex)
      await chatStore.sendMessage(msgs[i]!.content)
      await nextTick()
      scrollToBottom()
      break
    }
  }
}

function handleEdit(msgIndex: number) {
  const msg = chatStore.messages[msgIndex]
  if (!msg || msg.role !== 'user') return
  // 将消息内容填入输入框，移除该消息及之后的消息
  const content = msg.content
  chatStore.messages.splice(msgIndex)
  chatInputRef.value?.setInput(content)
}

function scrollToBottom() {
  messagesEndRef.value?.scrollIntoView({ behavior: 'smooth' })
}

watch(() => chatStore.messages.length, () => {
  nextTick(scrollToBottom)
})

watch(() => chatStore.streamingContent, () => {
  nextTick(scrollToBottom)
})

function newSession() {
  chatStore.newSession()
}
</script>

<template>
  <div class="flex h-full">
    <!-- 会话列表侧栏 -->
    <div
      v-show="showSessions"
      class="w-[260px] flex-shrink-0 border-r flex flex-col"
      :style="{ borderColor: 'var(--hc-border)', background: 'var(--hc-bg-sidebar)' }"
    >
      <div class="p-3 flex items-center justify-between">
        <span class="text-sm font-medium" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('chat.sessions') }}</span>
        <button
          class="p-1.5 rounded-md hover:bg-white/5 transition-colors"
          :style="{ color: 'var(--hc-text-secondary)' }"
          :title="t('chat.newSession')"
          @click="newSession"
        >
          <MessageSquarePlus :size="16" />
        </button>
      </div>
      <SessionList />
    </div>

    <!-- 聊天主区域 -->
    <div class="flex-1 flex flex-col min-w-0">
      <!-- 消息区域 -->
      <div class="flex-1 overflow-y-auto px-4 py-6">
        <div v-if="chatStore.messages.length === 0 && !chatStore.streaming" class="h-full flex items-center justify-center">
          <EmptyState
            :icon="MessageSquarePlus"
            :title="t('chat.startChat')"
            :description="t('chat.startChatDesc')"
          />
        </div>

        <div v-else class="max-w-3xl mx-auto space-y-6">
          <!-- 消息列表 -->
          <div
            v-for="(msg, idx) in chatStore.messages"
            :key="msg.id"
            class="group flex gap-3"
            :class="msg.role === 'user' ? 'justify-end' : 'justify-start'"
            @mouseenter="hoveredMsgId = msg.id"
            @mouseleave="hoveredMsgId = null"
          >
            <!-- Agent 消息 -->
            <div v-if="msg.role === 'assistant'" class="max-w-[85%]">
              <div class="text-xs mb-1" :style="{ color: 'var(--hc-text-muted)' }">
                {{ msg.agent_name || 'Agent' }}
              </div>
              <div
                class="rounded-xl px-4 py-3 text-sm leading-relaxed"
                :style="{ background: 'var(--hc-bg-card)', color: 'var(--hc-text-primary)' }"
              >
                <MarkdownRenderer :content="msg.content" />
              </div>
              <div class="mt-1 h-6">
                <MessageActions
                  v-show="hoveredMsgId === msg.id"
                  role="assistant"
                  :content="msg.content"
                  @retry="handleRetry(idx)"
                />
              </div>
            </div>

            <!-- 用户消息 -->
            <div v-else-if="msg.role === 'user'" class="max-w-[85%]">
              <div
                class="rounded-xl px-4 py-3 text-sm leading-relaxed"
                :style="{ background: 'var(--hc-accent)', color: '#fff' }"
              >
                {{ msg.content }}
              </div>
              <div class="mt-1 h-6 flex justify-end">
                <MessageActions
                  v-show="hoveredMsgId === msg.id"
                  role="user"
                  :content="msg.content"
                  @edit="handleEdit(idx)"
                />
              </div>
            </div>
          </div>

          <!-- 流式输出中 -->
          <div v-if="chatStore.streaming" class="flex gap-3 justify-start">
            <div class="max-w-[85%]">
              <div class="text-xs mb-1" :style="{ color: 'var(--hc-text-muted)' }">Agent</div>
              <div
                class="rounded-xl px-4 py-3 text-sm leading-relaxed"
                :style="{ background: 'var(--hc-bg-card)', color: 'var(--hc-text-primary)' }"
              >
                <MarkdownRenderer
                  v-if="chatStore.streamingContent"
                  :content="chatStore.streamingContent"
                />
                <span v-else class="inline-flex gap-1">
                  <span class="w-2 h-2 rounded-full bg-current animate-bounce" style="animation-delay: 0ms" />
                  <span class="w-2 h-2 rounded-full bg-current animate-bounce" style="animation-delay: 150ms" />
                  <span class="w-2 h-2 rounded-full bg-current animate-bounce" style="animation-delay: 300ms" />
                </span>
              </div>
            </div>
          </div>

          <div ref="messagesEndRef" />
        </div>
      </div>

      <!-- 输入区域 -->
      <div class="border-t p-4" :style="{ borderColor: 'var(--hc-border)' }">
        <div class="max-w-3xl mx-auto">
          <ChatInput
            ref="chatInputRef"
            :streaming="chatStore.streaming"
            @send="handleSend"
            @stop="chatStore.stopStreaming()"
          />
        </div>
      </div>
    </div>
  </div>
</template>
