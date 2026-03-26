<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Users, Share2, Upload, Download, Globe, Lock,
  Copy, ExternalLink, Trash2, UserPlus, Loader2, RefreshCw,
} from 'lucide-vue-next'
import PageHeader from '@/components/common/PageHeader.vue'
import {
  getSharedAgents,
  deleteSharedAgent,
  getTeamMembers,
  inviteTeamMember,
  removeTeamMember,
  exportAllConfig,
  importConfig,
  type SharedAgent,
  type TeamMember,
  type ExportBundle,
} from '@/api/team'

useI18n()

const activeTab = ref<'shared' | 'team' | 'import'>('shared')
const loading = ref(false)
const errorMsg = ref('')

// ─── 共享 Agent ──────────────────────────────────────
const sharedAgents = ref<SharedAgent[]>([])

async function loadSharedAgents() {
  loading.value = true
  errorMsg.value = ''
  try {
    sharedAgents.value = await getSharedAgents()
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : '加载共享 Agent 失败'
  } finally {
    loading.value = false
  }
}

async function handleDeleteAgent(id: string) {
  if (!confirm('确定删除该共享 Agent？')) return
  try {
    await deleteSharedAgent(id)
    sharedAgents.value = sharedAgents.value.filter(a => a.id !== id)
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : '删除失败'
  }
}

function copyShareLink(agent: SharedAgent) {
  navigator.clipboard.writeText(`hexclaw://agent/${agent.id}`)
}

function exportAgent(agent: SharedAgent) {
  const data = JSON.stringify(agent, null, 2)
  const blob = new Blob([data], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${agent.name}.json`
  a.click()
  URL.revokeObjectURL(url)
}

// ─── 团队成员 ────────────────────────────────────────
const teamMembers = ref<TeamMember[]>([])
const showInvite = ref(false)
const inviteEmail = ref('')
const inviteRole = ref<'member' | 'viewer'>('member')
const inviting = ref(false)

async function loadTeamMembers() {
  loading.value = true
  try {
    teamMembers.value = await getTeamMembers()
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : '加载团队成员失败'
  } finally {
    loading.value = false
  }
}

async function handleInvite() {
  if (!inviteEmail.value.trim()) return
  inviting.value = true
  try {
    const member = await inviteTeamMember({ email: inviteEmail.value.trim(), role: inviteRole.value })
    teamMembers.value.push(member)
    showInvite.value = false
    inviteEmail.value = ''
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : '邀请失败'
  } finally {
    inviting.value = false
  }
}

async function handleRemoveMember(id: string) {
  if (id === 'self') return
  if (!confirm('确定移除该成员？')) return
  try {
    await removeTeamMember(id)
    teamMembers.value = teamMembers.value.filter(m => m.id !== id)
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : '移除失败'
  }
}

// ─── 导入导出 ────────────────────────────────────────
const importing = ref(false)
const exporting = ref(false)

async function handleExportAll() {
  exporting.value = true
  try {
    const bundle = await exportAllConfig()
    const data = JSON.stringify(bundle, null, 2)
    const blob = new Blob([data], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `hexclaw-export-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : '导出失败'
  } finally {
    exporting.value = false
  }
}

async function handleImportFile() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.json'
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return
    importing.value = true
    try {
      const text = await file.text()
      const bundle = JSON.parse(text) as ExportBundle
      const result = await importConfig(bundle)
      await loadSharedAgents()
      errorMsg.value = '' // clear errors
      alert(`成功导入 ${result.imported} 项配置`)
    } catch (e) {
      errorMsg.value = e instanceof Error ? e.message : '导入失败，请检查文件格式'
    } finally {
      importing.value = false
    }
  }
  input.click()
}

// ─── 角色标签 ────────────────────────────────────────
const roleLabel: Record<string, string> = {
  admin: '管理员',
  member: '成员',
  viewer: '只读',
}

// ─── 初始化 ──────────────────────────────────────────
onMounted(async () => {
  await Promise.all([loadSharedAgents(), loadTeamMembers()])
})
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <PageHeader title="团队协作" description="共享智能体配置、团队知识库和协作管理">
      <template #actions>
        <button class="hc-btn hc-btn-ghost" @click="loadSharedAgents(); loadTeamMembers()">
          <RefreshCw :size="14" />
        </button>
        <button class="hc-btn hc-btn-primary" @click="showInvite = true">
          <UserPlus :size="14" />
          邀请成员
        </button>
      </template>
    </PageHeader>

    <div v-if="errorMsg" class="mx-6 mt-2 px-4 py-2 rounded-lg text-sm flex items-center justify-between" style="background: #ef444420; color: #ef4444;">
      <span>{{ errorMsg }}</span>
      <button class="text-xs underline ml-4" @click="errorMsg = ''">关闭</button>
    </div>

    <!-- Tabs -->
    <div class="hc-team__tabs">
      <button
        class="hc-team__tab"
        :class="{ 'hc-team__tab--active': activeTab === 'shared' }"
        @click="activeTab = 'shared'"
      >
        <Share2 :size="14" /> 共享智能体
      </button>
      <button
        class="hc-team__tab"
        :class="{ 'hc-team__tab--active': activeTab === 'team' }"
        @click="activeTab = 'team'"
      >
        <Users :size="14" /> 团队成员
      </button>
      <button
        class="hc-team__tab"
        :class="{ 'hc-team__tab--active': activeTab === 'import' }"
        @click="activeTab = 'import'"
      >
        <Download :size="14" /> 导入/导出
      </button>
    </div>

    <div class="hc-team__body">
      <!-- Loading -->
      <div v-if="loading" class="flex items-center justify-center py-12">
        <Loader2 :size="20" class="animate-spin" style="color: var(--hc-text-muted);" />
      </div>

      <!-- Shared Agents -->
      <template v-else-if="activeTab === 'shared'">
        <div v-if="sharedAgents.length === 0" class="hc-team__empty">
          <Share2 :size="28" style="color: var(--hc-text-muted);" />
          <p>暂无共享智能体</p>
          <span>将你的 Agent 配置共享给团队成员</span>
        </div>
        <div v-else class="hc-team__grid">
          <div
            v-for="agent in sharedAgents"
            :key="agent.id"
            class="hc-team__card hc-card"
          >
            <div class="hc-team__card-header">
              <span class="hc-team__card-name">{{ agent.name }}</span>
              <span class="hc-team__visibility" :class="`hc-team__visibility--${agent.visibility}`">
                <Globe v-if="agent.visibility === 'public'" :size="10" />
                <Users v-else-if="agent.visibility === 'team'" :size="10" />
                <Lock v-else :size="10" />
                {{ agent.visibility === 'public' ? '公开' : agent.visibility === 'team' ? '团队' : '私有' }}
              </span>
            </div>
            <p class="hc-team__card-desc">{{ agent.description }}</p>
            <div class="hc-team__card-meta">
              <span>{{ agent.author }}</span>
              <span>{{ agent.downloads }} 次使用</span>
            </div>
            <div class="hc-team__card-actions">
              <button class="hc-btn hc-btn-ghost" @click="copyShareLink(agent)">
                <Copy :size="12" /> 复制链接
              </button>
              <button class="hc-btn hc-btn-ghost" @click="exportAgent(agent)">
                <Download :size="12" /> 导出
              </button>
              <button class="hc-btn hc-btn-ghost hc-btn-danger" @click="handleDeleteAgent(agent.id)">
                <Trash2 :size="12" />
              </button>
            </div>
          </div>
        </div>
      </template>

      <!-- Team Members -->
      <template v-else-if="activeTab === 'team'">
        <div class="hc-team__members">
          <div
            v-for="member in teamMembers"
            :key="member.id"
            class="hc-team__member"
          >
            <div class="hc-team__avatar">{{ member.name[0] }}</div>
            <div class="hc-team__member-info">
              <span class="hc-team__member-name">{{ member.name }}</span>
              <span class="hc-team__member-email">{{ member.email }}</span>
            </div>
            <span class="hc-team__role" :class="`hc-team__role--${member.role}`">
              {{ roleLabel[member.role] }}
            </span>
            <span class="hc-team__member-active">{{ member.last_active }}</span>
            <button
              v-if="member.id !== 'self'"
              class="hc-btn hc-btn-ghost hc-btn-sm hc-btn-danger"
              @click="handleRemoveMember(member.id)"
            >
              <Trash2 :size="12" />
            </button>
          </div>
        </div>
      </template>

      <!-- Import/Export -->
      <template v-else>
        <div class="hc-team__import">
          <div class="hc-team__import-card hc-card" @click="handleImportFile">
            <Upload :size="24" style="color: var(--hc-accent);" />
            <h4>导入智能体配置</h4>
            <p>从 JSON 文件导入智能体、工作流或知识库配置</p>
            <button class="hc-btn hc-btn-secondary" :disabled="importing">
              <Loader2 v-if="importing" :size="12" class="animate-spin" />
              {{ importing ? '导入中...' : '选择文件' }}
            </button>
          </div>
          <div class="hc-team__import-card hc-card" @click="handleExportAll">
            <Download :size="24" style="color: #10b981;" />
            <h4>导出全部配置</h4>
            <p>导出所有智能体、工作流和技能配置到 JSON 文件</p>
            <button class="hc-btn hc-btn-secondary" :disabled="exporting">
              <Loader2 v-if="exporting" :size="12" class="animate-spin" />
              {{ exporting ? '导出中...' : '导出全部' }}
            </button>
          </div>
          <div class="hc-team__import-card hc-card" @click="$router.push('/skills')">
            <ExternalLink :size="24" style="color: #8b5cf6;" />
            <h4>社区模板库</h4>
            <p>浏览 ClawHub 技能市场，导入社区共享的优质智能体模板</p>
            <button class="hc-btn hc-btn-secondary">浏览模板</button>
          </div>
        </div>
      </template>
    </div>

    <!-- Invite Modal -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="showInvite" class="hc-modal-overlay" @click.self="showInvite = false">
          <div class="hc-modal" style="max-width: 400px;">
            <div class="hc-modal__header">
              <h2 class="hc-modal__title">邀请团队成员</h2>
              <button class="hc-modal__close" @click="showInvite = false">✕</button>
            </div>
            <div class="hc-modal__body">
              <div class="hc-field">
                <label class="hc-field__label">邮箱地址</label>
                <input
                  v-model="inviteEmail"
                  type="email"
                  class="hc-input"
                  placeholder="user@example.com"
                  @keyup.enter="handleInvite"
                />
              </div>
              <div class="hc-field">
                <label class="hc-field__label">角色</label>
                <select v-model="inviteRole" class="hc-input">
                  <option value="member">成员</option>
                  <option value="viewer">只读</option>
                </select>
              </div>
            </div>
            <div class="hc-modal__footer">
              <button class="hc-btn hc-btn-secondary" @click="showInvite = false">取消</button>
              <button
                class="hc-btn hc-btn-primary"
                :disabled="!inviteEmail.trim() || inviting"
                @click="handleInvite"
              >
                <Loader2 v-if="inviting" :size="12" class="animate-spin" />
                {{ inviting ? '发送中...' : '发送邀请' }}
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.hc-team__tabs {
  display: flex;
  gap: 0;
  padding: 0 24px;
  border-bottom: 1px solid var(--hc-border);
}

.hc-team__tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 16px;
  font-size: 13px;
  font-weight: 500;
  color: var(--hc-text-secondary);
  border: none;
  background: transparent;
  border-bottom: 1.5px solid transparent;
  cursor: pointer;
  margin-bottom: -1px;
  transition: color 0.15s;
}

.hc-team__tab--active {
  color: var(--hc-text-primary);
  border-bottom-color: var(--hc-accent);
}

.hc-team__body {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
}

.hc-team__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 48px 0;
  text-align: center;
}
.hc-team__empty p { font-size: 14px; font-weight: 500; color: var(--hc-text-primary); margin: 0; }
.hc-team__empty span { font-size: 12px; color: var(--hc-text-muted); }

.hc-team__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
  max-width: 900px;
}

.hc-team__card {
  padding: 16px;
  border: 1px solid var(--hc-border);
}

.hc-team__card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.hc-team__card-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--hc-text-primary);
}

.hc-team__visibility {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 100px;
}

.hc-team__visibility--public { color: var(--hc-success); background: rgba(50,213,131,0.1); }
.hc-team__visibility--team { color: var(--hc-accent); background: var(--hc-accent-subtle); }
.hc-team__visibility--private { color: var(--hc-text-muted); background: var(--hc-bg-hover); }

.hc-team__card-desc {
  font-size: 13px;
  color: var(--hc-text-secondary);
  line-height: 1.5;
  margin: 0 0 10px;
}

.hc-team__card-meta {
  display: flex;
  gap: 12px;
  font-size: 11px;
  color: var(--hc-text-muted);
  margin-bottom: 10px;
}

.hc-team__card-actions {
  display: flex;
  gap: 4px;
}

.hc-btn-danger { color: var(--hc-error, #ef4444) !important; }
.hc-btn-danger:hover { background: rgba(239, 68, 68, 0.1) !important; }

/* Members */
.hc-team__members {
  max-width: 600px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.hc-team__member {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-radius: var(--hc-radius-md);
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-card);
}

.hc-team__avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--hc-accent);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 600;
  flex-shrink: 0;
}

.hc-team__member-info {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.hc-team__member-name { font-size: 13px; font-weight: 500; color: var(--hc-text-primary); }
.hc-team__member-email { font-size: 11px; color: var(--hc-text-muted); }

.hc-team__role {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 100px;
  font-weight: 500;
}

.hc-team__role--admin { color: var(--hc-accent); background: var(--hc-accent-subtle); }
.hc-team__role--member { color: var(--hc-success); background: rgba(50,213,131,0.1); }
.hc-team__role--viewer { color: var(--hc-text-muted); background: var(--hc-bg-hover); }

.hc-team__member-active {
  font-size: 11px;
  color: var(--hc-text-muted);
  min-width: 60px;
  text-align: right;
}

/* Import/Export */
.hc-team__import {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px;
  max-width: 900px;
}

.hc-team__import-card {
  padding: 24px;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--hc-border);
  cursor: pointer;
  transition: border-color 0.15s;
}

.hc-team__import-card:hover {
  border-color: var(--hc-accent);
}

.hc-team__import-card h4 {
  font-size: 14px;
  font-weight: 600;
  color: var(--hc-text-primary);
  margin: 4px 0 0;
}

.hc-team__import-card p {
  font-size: 12px;
  color: var(--hc-text-muted);
  line-height: 1.5;
  margin: 0 0 8px;
}

/* Modal reuse */
.hc-modal-overlay { position: fixed; top: var(--hc-titlebar-height); left: 0; right: 0; bottom: 0; z-index: var(--hc-z-modal); display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.45); backdrop-filter: blur(4px); }
.hc-modal { width: 100%; border-radius: var(--hc-radius-xl); background: var(--hc-bg-elevated); border: 1px solid var(--hc-border); box-shadow: var(--hc-shadow-float); overflow: hidden; animation: hc-scale-in 0.2s cubic-bezier(0.25,0.1,0.25,1); }
.hc-modal__header { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--hc-divider); }
.hc-modal__title { font-size: 15px; font-weight: 600; color: var(--hc-text-primary); margin: 0; }
.hc-modal__close { padding: 4px; border-radius: var(--hc-radius-sm); border: none; background: transparent; color: var(--hc-text-muted); cursor: pointer; }
.hc-modal__body { padding: 20px; display: flex; flex-direction: column; gap: 14px; }
.hc-modal__footer { display: flex; justify-content: flex-end; gap: 8px; padding: 14px 20px; border-top: 1px solid var(--hc-divider); }
.hc-field { display: flex; flex-direction: column; gap: 6px; }
.hc-field__label { font-size: 13px; font-weight: 500; color: var(--hc-text-secondary); }
.hc-input { padding: 8px 12px; border-radius: var(--hc-radius-md); border: 1px solid var(--hc-border); background: var(--hc-bg-input); color: var(--hc-text-primary); font-size: 13px; outline: none; width: 100%; box-sizing: border-box; }
.hc-input:focus { border-color: var(--hc-accent); }
.modal-enter-active { transition: opacity 0.2s ease-out; }
.modal-leave-active { transition: opacity 0.15s ease-in; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
</style>
