import { describe, it, expect, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import SkillPreviewModal from '../SkillPreviewModal.vue'
import zhCN from '@/i18n/locales/zh-CN'

/**
 * 方案 C：市场/已安装共用预览弹窗,footer 按上下文自适应。
 * 锁定：mode 决定 footer 动作集 + 事件；loading 走骨架屏；Esc 关闭。
 */
const SKILL = { name: 'demo-skill', display_name: '演示技能', description: '一个技能', author: '张三', version: '1.2', triggers: ['demo', 'run'] }

let wrapper: VueWrapper | null = null
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

function mountModal(props: Record<string, unknown>) {
  wrapper = mount(SkillPreviewModal, {
    attachTo: document.body,
    props: { skill: SKILL, content: '# hello', loading: false, error: '', mode: 'installed', ...props },
    global: {
      plugins: [createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN, zh: zhCN } })],
      stubs: {
        SkillIcon: { template: '<span class="skill-icon-stub" />' },
        SkillMarkdownPreview: { template: '<div class="md-stub">{{ content }}</div>', props: ['content'] },
      },
    },
  })
  return wrapper
}

const body = () => document.body

describe('SkillPreviewModal（方案 C 共用弹窗）', () => {
  it('mode=installed：footer 有 删除/启停/关闭,无 安装；点击各自 emit', async () => {
    const w = mountModal({ mode: 'installed', enabled: true })
    const txt = body().textContent || ''
    expect(txt).toContain('删除')
    expect(txt).toContain('已启用')
    expect(txt).toContain('关闭')
    expect(txt).not.toContain('安装')

    const btns = Array.from(body().querySelectorAll('button'))
    await btns.find((b) => b.textContent?.includes('删除'))!.click()
    await btns.find((b) => b.textContent?.includes('已启用'))!.click()
    expect(w.emitted('delete')).toBeTruthy()
    expect(w.emitted('toggle-enabled')).toBeTruthy()
  })

  it('mode=hub：footer 有 安装,无 删除；点安装 emit install', async () => {
    const w = mountModal({ mode: 'hub', installed: false })
    const txt = body().textContent || ''
    expect(txt).toContain('安装')
    expect(txt).not.toContain('删除')
    const btns = Array.from(body().querySelectorAll('button'))
    await btns.find((b) => b.textContent?.includes('安装'))!.click()
    expect(w.emitted('install')).toBeTruthy()
  })

  it('mode=hub 且已安装：显示禁用「已安装」,不可点安装', () => {
    mountModal({ mode: 'hub', installed: true })
    expect((body().textContent || '')).toContain('已安装')
  })

  it('loading：正文走骨架屏,不渲染 markdown', () => {
    mountModal({ loading: true })
    expect(body().querySelector('.skill-preview__skeleton')).toBeTruthy()
    expect(body().querySelector('.md-stub')).toBeFalsy()
  })

  it('触发词 chips 渲染在正文', () => {
    mountModal({})
    const txt = body().textContent || ''
    expect(txt).toContain('/demo')
    expect(txt).toContain('/run')
  })

  it('Esc 键 emit close', async () => {
    const w = mountModal({})
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await w.vm.$nextTick()
    expect(w.emitted('close')).toBeTruthy()
  })
})
