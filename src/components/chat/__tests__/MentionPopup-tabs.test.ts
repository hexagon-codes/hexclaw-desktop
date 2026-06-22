/**
 * MentionPopup 分栏多实体（全部/Agent/知识/连接/会话）。
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import MentionPopup from '../MentionPopup.vue'

function mountPopup() {
  return mount(MentionPopup, {
    props: {
      visible: true,
      query: '',
      position: { bottom: 0, left: 0 },
      agents: [{ name: 'kouzi', title: '扣子', goal: 'demo' }],
      knowledgeDocs: [{ id: 'd1', title: 'API 规范', chunk_count: 3, created_at: '' }],
      connections: [{ id: 'c1', provider: 'github', name: 'my-gh', capabilities: [], status: 'ok', enabled: true }],
      sessions: [{ id: 's1', title: '上次部署', message_count: 5, created_at: '', updated_at: '' }],
    },
    global: {
      plugins: [createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN, zh: zhCN } })],
      stubs: { teleport: true },
    },
  })
}

describe('MentionPopup 分栏', () => {
  it('渲染 5 个 tab（全部/Agent/知识/连接/会话，无成员）', () => {
    const w = mountPopup()
    const tabs = w.findAll('.hc-mention__tab').map((t) => t.text())
    expect(tabs).toEqual(['全部', 'Agent', '知识', '连接', '会话'])
    expect(tabs).not.toContain('成员')
  })

  it('全部 tab 同时展示四类实体', () => {
    const w = mountPopup()
    const text = w.text()
    expect(text).toContain('扣子')
    expect(text).toContain('API 规范')
    expect(text).toContain('my-gh')
    expect(text).toContain('上次部署')
  })

  it('切到「知识」tab 仅显示知识项', async () => {
    const w = mountPopup()
    const knowledgeTab = w.findAll('.hc-mention__tab').find((t) => t.text() === '知识')!
    await knowledgeTab.trigger('mousedown')
    expect(w.text()).toContain('API 规范')
    expect(w.text()).not.toContain('扣子')
  })

  it('选中知识项 emit {type:knowledge,id}', async () => {
    const w = mountPopup()
    const knowledgeTab = w.findAll('.hc-mention__tab').find((t) => t.text() === '知识')!
    await knowledgeTab.trigger('mousedown')
    await w.find('.hc-mention__item').trigger('click')
    const ev = w.emitted('select') as unknown[][]
    expect(ev[0]![0]).toMatchObject({ type: 'knowledge', id: 'd1' })
  })

  it('选中连接项带 meta.provider', async () => {
    const w = mountPopup()
    const tab = w.findAll('.hc-mention__tab').find((t) => t.text() === '连接')!
    await tab.trigger('mousedown')
    await w.find('.hc-mention__item').trigger('click')
    const ev = w.emitted('select') as unknown[][]
    expect(ev[0]![0]).toMatchObject({ type: 'connection', id: 'c1', meta: { provider: 'github' } })
  })
})
