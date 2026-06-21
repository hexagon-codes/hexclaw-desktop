/**
 * BUG-20260621 (RED→GREEN): 二级 tab 计数徽标全站一致——0 时一律不渲染。
 *
 * 决策（用户 2026-06-21）：Skills / MCP / Prompt 库 / 知识库 的二级 tab 计数统一行为——
 *   count > 0 显示数字徽标；count == 0 或 未传 时不显示（不留悬空「0」）。
 * 把规则下沉到公共 UnderlineTabs 组件（全站唯一 utabs 实现），一处改全局一致。
 *
 * 用例断言「正确行为」，在未修改组件上 count==0 一条会 FAIL（当前 v-if 只判 != null，0 仍渲染）。
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import UnderlineTabs from '@/components/common/UnderlineTabs.vue'

function mountTabs(tabs: Array<{ key: string; label: string; count?: number }>) {
  return mount(UnderlineTabs, { props: { tabs, modelValue: tabs[0]?.key ?? '' } })
}

describe('BUG-20260621: UnderlineTabs 计数徽标 0 时隐藏（全站一致）', () => {
  it('count > 0 → 渲染数字徽标', () => {
    const wrapper = mountTabs([{ key: 'a', label: '已安装', count: 14 }])
    const badges = wrapper.findAll('.hc-utab__count')
    expect(badges.length).toBe(1)
    expect(badges[0]!.text()).toBe('14')
  })

  it('count === 0 → 不渲染徽标（不留悬空 0）', () => {
    const wrapper = mountTabs([
      { key: 'a', label: '服务器', count: 0 },
      { key: 'b', label: '市场', count: 0 },
    ])
    // 当前实现 v-if="count != null"：0 仍渲染 → 下面断言 FAIL，证明需要修。
    expect(
      wrapper.findAll('.hc-utab__count').length,
      'count===0 still renders a dangling "0" badge',
    ).toBe(0)
    expect(wrapper.findAll('.hc-utab').map((b) => b.text())).toEqual(['服务器', '市场'])
  })

  it('count 未传 → 不渲染徽标', () => {
    const wrapper = mountTabs([{ key: 'a', label: '市场' }])
    expect(wrapper.findAll('.hc-utab__count').length).toBe(0)
  })

  it('混合：>0 显示、=0 隐藏（同一组 tab）', () => {
    const wrapper = mountTabs([
      { key: 'a', label: '已安装', count: 14 },
      { key: 'b', label: '市场', count: 0 },
    ])
    const badges = wrapper.findAll('.hc-utab__count')
    expect(badges.length).toBe(1)
    expect(badges[0]!.text()).toBe('14')
  })
})
