import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const CHAT_DIR = path.resolve(__dirname, '..')
const SRC = path.resolve(CHAT_DIR, '../..')

const actions = fs.readFileSync(path.join(CHAT_DIR, 'MessageActions.vue'), 'utf8')
const toolbar = fs.readFileSync(path.join(CHAT_DIR, 'ChatToolbar.vue'), 'utf8')
const chatView = fs.readFileSync(path.join(SRC, 'views/ChatView.vue'), 'utf8')
const prototype = fs.readFileSync(
  path.resolve(SRC, '../../hexclaw-docs/prototype/app.html'),
  'utf8',
)

describe('prototype chat chrome fidelity', () => {
  it('uses compact role-aware actions with 24px hit targets and 14px icons', () => {
    expect(actions).toMatch(
      /\.hc-msg-actions__btn\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;[^}]*padding:\s*0/s,
    )
    expect(actions).toMatch(/\.hc-msg-actions__btn svg\s*\{[^}]*width:\s*14px;[^}]*height:\s*14px/s)
    expect(actions).not.toContain(':size="16"')
    expect(actions.match(/:size="14"/g)?.length).toBeGreaterThanOrEqual(9)

    const assistantActions = actions.match(/\.hc-msg-actions--assistant\s*\{([^}]*)\}/s)?.[1] ?? ''
    expect(assistantActions).toMatch(/height:\s*24px/)
    expect(assistantActions).toMatch(/padding:\s*0/)
    expect(assistantActions).toMatch(/border:\s*(?:0|none)/)
    expect(assistantActions).toMatch(/background:\s*transparent/)
    expect(assistantActions).toMatch(/box-shadow:\s*none/)
    expect(actions).toMatch(
      /\.hc-msg-actions--assistant \.hc-msg-actions__btn\s*\{[^}]*color:\s*var\(--hc-text-muted\)/s,
    )

    const userActions = actions.match(/\.hc-msg-actions--user\s*\{([^}]*)\}/s)?.[1] ?? ''
    expect(userActions).toMatch(/height:\s*30px/)
    expect(userActions).toMatch(/padding:\s*3px/)
    expect(userActions).toMatch(/border:/)
    expect(userActions).toMatch(/background:/)
    expect(actions).toMatch(
      /\.hc-msg-actions__btn:hover\s*\{[^}]*background:\s*var\(--hc-bg-hover\)/s,
    )
  })

  it('places assistant time after the action group and user time before its hover actions', () => {
    const assistantFooterTag = chatView.match(/<MessageFooter\b[^>]*class="hc-msg__footer"[^>]*>/)
    const userFooterTag = chatView.match(
      /<MessageFooter\b[^>]*class="hc-msg__footer hc-msg__footer--right"[^>]*>/,
    )
    const assistantFooterStart = assistantFooterTag?.index ?? -1
    const userFooterStart = userFooterTag?.index ?? -1
    expect(assistantFooterStart).toBeGreaterThan(-1)
    expect(userFooterStart).toBeGreaterThan(assistantFooterStart)
    expect(assistantFooterTag?.[0]).toContain('v-if="!isLiveAssistantMessage(msg)"')

    const assistantFooter = chatView.slice(assistantFooterStart, userFooterStart)
    const assistantMeta = assistantFooter.indexOf('<div class="hc-msg__meta">')
    const assistantActions = assistantFooter.indexOf('<div class="hc-msg__actions-inline">')
    const assistantComponent = assistantFooter.indexOf('role="assistant"')
    const assistantTime = assistantFooter.indexOf('class="hc-msg__time"')
    expect(assistantMeta).toBeGreaterThan(-1)
    expect(assistantActions).toBeGreaterThan(assistantMeta)
    expect(assistantComponent).toBeGreaterThan(assistantActions)
    expect(assistantTime).toBeGreaterThan(assistantComponent)
    expect(assistantFooter.slice(assistantMeta, assistantActions)).not.toContain(
      'formatClockTime(msg.timestamp)',
    )
    expect(assistantFooter).toContain('formatClockTime(msg.timestamp)')
    expect(assistantFooter).not.toContain('hc-msg__actions-float')

    const userFooter = chatView.slice(
      userFooterStart,
      chatView.indexOf('</template>', userFooterStart),
    )
    expect(userFooter.indexOf('hc-msg__actions-float--right')).toBeGreaterThan(-1)
    expect(userFooter.indexOf('role="user"')).toBeGreaterThan(
      userFooter.indexOf('hc-msg__actions-float--right'),
    )
    const userControls = userFooter.indexOf('hc-msg__actions-float--right')
    const userTime = userFooter.indexOf('class="hc-msg__time hc-msg__time--right"')
    expect(userTime).toBeGreaterThan(userControls)
    expect(userTime).toBeLessThan(userFooter.indexOf('role="user"'))

    expect(chatView).toMatch(/\.hc-msg__footer\s*\{[^}]*gap:\s*8px/s)
    expect(chatView).toMatch(
      /\.hc-msg__actions-inline\s*\{[^}]*display:\s*inline-flex;[^}]*margin-left:\s*0/s,
    )
    expect(chatView).toMatch(
      /\.hc-msg__actions-float\s*\{[^}]*opacity:\s*0;[^}]*visibility:\s*hidden;[^}]*pointer-events:\s*none/s,
    )
    expect(chatView).toMatch(
      /\.hc-msg:hover \.hc-msg__actions-float,\s*\.hc-msg:focus-within \.hc-msg__actions-float/s,
    )
    expect(chatView).toMatch(
      /\.hc-msg__actions-float--right\s*\{[^}]*display:\s*inline-flex;[^}]*align-items:\s*center;[^}]*gap:\s*8px/s,
    )
  })

  it('keeps prototype session row dates free of weekdays and uses time for today', () => {
    const listStart = prototype.indexOf('<div class="cs-scroll" id="prototypeSessionList">')
    const listEnd = prototype.indexOf('<div class="cs-session-menu"', listStart)
    const sessionList = prototype.slice(listStart, listEnd)
    const todayStart = sessionList.indexOf('data-session-section="today"')
    const earlierStart = sessionList.indexOf('data-session-section="earlier"')
    const todayRows = sessionList.slice(todayStart, earlierStart)
    expect(sessionList).toContain('<span>6月16日</span>')
    expect(sessionList).toContain('<span>6月15日</span>')
    expect(todayRows).toContain('data-session-id="decimal"')
    expect(todayRows).toContain('<span>14:32</span>')
    expect(todayRows).toContain('<span>09:18</span>')
    expect(todayRows).not.toMatch(/\d+月\d+日|\d{4}年/)
    expect(sessionList).not.toContain('<span>今天</span>')
    expect(sessionList).not.toContain('<span>昨天</span>')
    expect(sessionList).not.toContain('<span>2026年6月16日</span>')
    expect(sessionList).not.toMatch(/周[一二三四五六日天]/)
    expect(sessionList).toContain('<span>6月13日</span>')
  })

  it('keeps the spatially mapped Desktop toolbar order with the prototype 30px geometry', () => {
    const sessions = toolbar.indexOf('<PanelLeft')
    const stat = toolbar.indexOf('hc-chat__stat-strip')
    const download = toolbar.indexOf('<Download')
    const boxes = toolbar.indexOf('<Boxes')
    const context = toolbar.indexOf('<PanelRight')
    expect(sessions).toBeGreaterThan(-1)
    expect(sessions).toBeLessThan(stat)
    expect(stat).toBeGreaterThan(-1)
    expect(stat).toBeLessThan(download)
    expect(download).toBeLessThan(boxes)
    expect(boxes).toBeLessThan(context)
    expect(toolbar).not.toContain('MessageSquarePlus')
    expect(toolbar).toMatch(/\.hc-chat__toolbar\s*\{[^}]*padding:\s*11px 16px/s)
    expect(toolbar).toMatch(
      /\.hc-chat__toolbar-btn\s*\{[^}]*width:\s*30px;[^}]*height:\s*30px;[^}]*border-radius:\s*8px/s,
    )
    expect(toolbar).toContain(':size="15"')
  })

  it('uses the prototype thread padding, gap and 780px message width', () => {
    expect(chatView).toMatch(/\.hc-chat__messages\s*\{[^}]*padding:\s*20px 24px 10px/s)
    expect(chatView).toMatch(/\.hc-chat__thread\s*\{[^}]*gap:\s*22px/s)
    expect(chatView).toMatch(/\.hc-msg__body\s*\{[^}]*max-width:\s*780px/s)
    expect(chatView).toMatch(
      /\.hc-chat--conversation-only \.hc-msg--assistant \.hc-msg__body\s*\{[^}]*max-width:\s*none/s,
    )
    expect(chatView).toContain('const isConversationOnly = computed(')
    expect(chatView).toMatch(/'hc-chat--conversation-only':\s*isConversationOnly/)
  })

  it('uses a neutral user bubble without an accent tint', () => {
    const userBubble = chatView.match(/\.hc-msg__bubble--user\s*\{([^}]*)\}/s)?.[1] ?? ''
    expect(userBubble).toMatch(/background:\s*var\(--hc-bg-card\)/)
    expect(userBubble).toMatch(/border:\s*0\.5px solid var\(--hc-border\)/)
    expect(userBubble).not.toContain('--hc-accent')
  })

  it('coordinates all chat rails through one mutually exclusive transition contract', () => {
    expect(toolbar).toContain("defineModel<ChatWorkspaceMode>('workspaceMode'")
    expect(toolbar).toContain('function toggleSessionsRail()')
    expect(toolbar).toContain('function toggleArtifactsRail()')
    expect(toolbar).toContain('function toggleContextRail()')
    expect(toolbar).not.toContain("defineModel<boolean>('showSessions'")
    expect(toolbar).not.toContain('chatStore.showArtifacts = false')
    expect(toolbar).not.toContain('appStore.setDetailPanelOpen(false)')
    expect(chatView).toContain('const chatWorkspaceMode = ref<ChatWorkspaceMode>(')
    expect(chatView).toContain('watch(chatWorkspaceMode')
    expect(chatView).toContain('() => chatStore.showArtifacts')
    expect(chatView).toContain('() => appStore.detailPanelOpen')
  })
})
