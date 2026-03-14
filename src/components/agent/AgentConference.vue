<script setup lang="ts">
import { ref, computed } from 'vue'
import { X, Play, Pause, Users, Bot, ArrowRight, Loader2 } from 'lucide-vue-next'

interface AgentRole {
  id: string
  name: string
  goal: string
}

const props = defineProps<{
  agents: AgentRole[]
}>()

const emit = defineEmits<{
  close: []
}>()

const selectedAgents = ref<string[]>([])
const topic = ref('')
const rounds = ref(3)
const running = ref(false)
const messages = ref<{ agent: string; content: string; round: number }[]>([])
const currentRound = ref(0)

const availableAgents = computed(() => props.agents)

function toggleAgent(id: string) {
  const idx = selectedAgents.value.indexOf(id)
  if (idx >= 0) selectedAgents.value.splice(idx, 1)
  else selectedAgents.value.push(id)
}

function agentName(id: string) {
  return props.agents.find(a => a.id === id)?.name || id
}

async function startConference() {
  if (selectedAgents.value.length < 2 || !topic.value.trim()) return
  running.value = true
  messages.value = []
  currentRound.value = 0

  // 模拟多轮对话
  for (let r = 1; r <= rounds.value; r++) {
    currentRound.value = r
    for (const agentId of selectedAgents.value) {
      await new Promise(res => setTimeout(res, 800))
      messages.value.push({
        agent: agentName(agentId),
        content: `[第 ${r} 轮] ${agentName(agentId)} 关于「${topic.value}」的分析观点...`,
        round: r,
      })
    }
  }
  running.value = false
}

function stopConference() {
  running.value = false
}
</script>

<template>
  <Teleport to="body">
    <div class="hc-conf-overlay" @click.self="emit('close')">
      <div class="hc-conf">
        <div class="hc-conf__header">
          <div class="hc-conf__header-left">
            <Users :size="16" style="color: var(--hc-accent);" />
            <h2 class="hc-conf__title">多 Agent 会议</h2>
          </div>
          <button class="hc-conf__close" @click="emit('close')">
            <X :size="16" />
          </button>
        </div>

        <div class="hc-conf__body">
          <!-- 配置区 -->
          <div class="hc-conf__config">
            <div class="hc-field">
              <label class="hc-field__label">讨论主题</label>
              <input
                v-model="topic"
                class="hc-input"
                placeholder="输入需要讨论的主题..."
                :disabled="running"
              />
            </div>

            <div class="hc-field">
              <label class="hc-field__label">参与 Agent (至少 2 个)</label>
              <div class="hc-conf__agents">
                <button
                  v-for="agent in availableAgents"
                  :key="agent.id"
                  class="hc-conf__agent-chip"
                  :class="{ 'hc-conf__agent-chip--selected': selectedAgents.includes(agent.id) }"
                  :disabled="running"
                  @click="toggleAgent(agent.id)"
                >
                  <Bot :size="12" />
                  {{ agent.name }}
                </button>
              </div>
            </div>

            <div class="hc-conf__row">
              <div class="hc-field" style="flex: 1;">
                <label class="hc-field__label">讨论轮数</label>
                <select v-model.number="rounds" class="hc-input" :disabled="running">
                  <option :value="2">2 轮</option>
                  <option :value="3">3 轮</option>
                  <option :value="5">5 轮</option>
                </select>
              </div>
              <button
                v-if="!running"
                class="hc-btn hc-btn-primary hc-conf__start"
                :disabled="selectedAgents.length < 2 || !topic.trim()"
                @click="startConference"
              >
                <Play :size="14" /> 开始会议
              </button>
              <button
                v-else
                class="hc-btn hc-conf__stop"
                @click="stopConference"
              >
                <Pause :size="14" /> 暂停
              </button>
            </div>
          </div>

          <!-- 对话区 -->
          <div class="hc-conf__messages" v-if="messages.length > 0 || running">
            <div class="hc-conf__divider">
              <span>会议记录</span>
            </div>

            <div
              v-for="(msg, i) in messages"
              :key="i"
              class="hc-conf__msg"
            >
              <div class="hc-conf__msg-avatar">
                <Bot :size="14" />
              </div>
              <div class="hc-conf__msg-body">
                <div class="hc-conf__msg-header">
                  <span class="hc-conf__msg-name">{{ msg.agent }}</span>
                  <span class="hc-conf__msg-round">第 {{ msg.round }} 轮</span>
                </div>
                <div class="hc-conf__msg-content">{{ msg.content }}</div>
              </div>
            </div>

            <div v-if="running" class="hc-conf__thinking">
              <Loader2 :size="14" class="animate-spin" />
              <span>第 {{ currentRound }} 轮讨论中...</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.hc-conf-overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(4px);
}

.hc-conf {
  width: 100%;
  max-width: 680px;
  max-height: 85vh;
  border-radius: var(--hc-radius-xl);
  background: var(--hc-bg-elevated);
  border: 1px solid var(--hc-border);
  box-shadow: var(--hc-shadow-float);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: hc-scale-in 0.2s cubic-bezier(0.25, 0.1, 0.25, 1);
}

.hc-conf__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--hc-divider);
}

.hc-conf__header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.hc-conf__title {
  font-size: 15px;
  font-weight: 600;
  color: var(--hc-text-primary);
  margin: 0;
}

.hc-conf__close {
  padding: 4px;
  border-radius: var(--hc-radius-sm);
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  cursor: pointer;
}

.hc-conf__body {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.hc-conf__config {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.hc-conf__agents {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.hc-conf__agent-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 12px;
  border-radius: 100px;
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-card);
  color: var(--hc-text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}

.hc-conf__agent-chip--selected {
  background: var(--hc-accent);
  color: #fff;
  border-color: var(--hc-accent);
}

.hc-conf__row {
  display: flex;
  align-items: flex-end;
  gap: 12px;
}

.hc-conf__start {
  height: 36px;
  white-space: nowrap;
}

.hc-conf__stop {
  height: 36px;
  white-space: nowrap;
  background: var(--hc-error);
  color: #fff;
  border: none;
  border-radius: var(--hc-radius-md);
  padding: 0 16px;
  font-size: 13px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
}

.hc-conf__divider {
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--hc-text-muted);
  font-size: 11px;
  margin: 8px 0;
}

.hc-conf__divider::before,
.hc-conf__divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--hc-divider);
}

.hc-conf__messages {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.hc-conf__msg {
  display: flex;
  gap: 10px;
}

.hc-conf__msg-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-top: 2px;
}

.hc-conf__msg-body {
  flex: 1;
}

.hc-conf__msg-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 3px;
}

.hc-conf__msg-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--hc-text-primary);
}

.hc-conf__msg-round {
  font-size: 10px;
  color: var(--hc-text-muted);
  padding: 1px 6px;
  background: var(--hc-bg-hover);
  border-radius: 100px;
}

.hc-conf__msg-content {
  font-size: 13px;
  color: var(--hc-text-secondary);
  line-height: 1.5;
}

.hc-conf__thinking {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--hc-text-muted);
  padding: 8px 0;
}

.hc-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.hc-field__label {
  font-size: 13px;
  font-weight: 500;
  color: var(--hc-text-secondary);
}

.hc-input {
  padding: 8px 12px;
  border-radius: var(--hc-radius-md);
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-input);
  color: var(--hc-text-primary);
  font-size: 13px;
  outline: none;
  transition: border-color 0.15s;
}

.hc-input:focus {
  border-color: var(--hc-accent);
}
</style>
