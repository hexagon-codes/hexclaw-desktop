import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import K12GlobalPresentation from '../appearance/K12GlobalPresentation.vue'
import {
  K12_APPEARANCE_STORAGE_KEY,
  __resetK12AppearanceForTest,
  useK12Appearance,
} from '../appearance/useK12Appearance'

function savedRecord() {
  return JSON.parse(localStorage.getItem(K12_APPEARANCE_STORAGE_KEY) ?? 'null')
}

describe('K12 appearance owner · K12-SKIN-DESKTOP-STATE-015', () => {
  beforeEach(() => {
    localStorage.clear()
    document.body.removeAttribute('data-k12-skin-active')
    __resetK12AppearanceForTest()
  })

  it('keeps a fresh install generic until the first real tutoring entry', () => {
    const appearance = useK12Appearance()
    expect(appearance.preference.value).toBe('k12')
    expect(appearance.skinActive.value).toBe(false)
    expect(document.body.dataset.k12SkinActive).toBe('default')

    expect(appearance.activateOnFirstEntry()).toBe(true)
    expect(appearance.skinActive.value).toBe(true)
    expect(savedRecord()).toEqual({ version: 1, preference: 'k12', introSeen: true })
    expect(appearance.activateOnFirstEntry()).toBe(false)
  })

  it('never overwrites an explicit generic preference on tutoring entry', () => {
    localStorage.setItem(
      K12_APPEARANCE_STORAGE_KEY,
      JSON.stringify({ version: 1, preference: 'default', introSeen: true }),
    )
    __resetK12AppearanceForTest()
    const appearance = useK12Appearance()

    expect(appearance.activateOnFirstEntry()).toBe(false)
    expect(appearance.skinActive.value).toBe(false)
    expect(savedRecord()).toEqual({ version: 1, preference: 'default', introSeen: true })
  })

  it.each([
    '{',
    'null',
    '{}',
    JSON.stringify({ version: 2, preference: 'k12', introSeen: true }),
    JSON.stringify({ version: 1, preference: 'other', introSeen: true }),
    JSON.stringify({ version: 1, preference: 'k12', introSeen: 'yes' }),
  ])('fails safe for damaged or unsupported storage without replacing it: %s', (raw) => {
    localStorage.setItem(K12_APPEARANCE_STORAGE_KEY, raw)
    __resetK12AppearanceForTest()
    const appearance = useK12Appearance()

    expect(appearance.skinActive.value).toBe(false)
    expect(appearance.activateOnFirstEntry()).toBe(false)
    expect(localStorage.getItem(K12_APPEARANCE_STORAGE_KEY)).toBe(raw)
  })

  it('keeps theme and appearance persistence orthogonal', () => {
    localStorage.setItem('hc-theme', 'dark')
    const appearance = useK12Appearance()
    appearance.setPreference('k12')
    expect(localStorage.getItem('hc-theme')).toBe('dark')
    expect(savedRecord()).toEqual({ version: 1, preference: 'k12', introSeen: true })
  })
})

describe('K12 global presentation exact-set', () => {
  beforeEach(() => {
    localStorage.clear()
    __resetK12AppearanceForTest()
    useK12Appearance().setPreference('k12')
  })

  it('creates one shared layer with 2 butterflies and 14+4 fireflies', () => {
    const wrapper = mount(K12GlobalPresentation, { attachTo: document.body })
    expect(wrapper.findAll('.k12-ambient-butterfly')).toHaveLength(2)
    expect(wrapper.findAll('.k12-ambient-firefly--right')).toHaveLength(14)
    expect(wrapper.findAll('.k12-ambient-firefly--sidebar')).toHaveLength(4)
    expect(wrapper.get('[aria-hidden="true"]').attributes('data-testid')).toBe(
      'k12-global-presentation',
    )
    wrapper.unmount()
  })
})
