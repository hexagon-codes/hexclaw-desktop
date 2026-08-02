import { computed, ref } from 'vue'

export type K12AppearancePreference = 'k12' | 'default'
export type K12SceneLevel = 'shell' | 'calm' | 'immersive'

interface K12AppearanceRecordV1 {
  version: 1
  preference: K12AppearancePreference
  introSeen: boolean
}

type RecordStatus = 'unread' | 'none' | 'valid' | 'invalid'

export const K12_APPEARANCE_STORAGE_KEY = 'hc-k12-appearance-v1'

const preference = ref<K12AppearancePreference>('k12')
const introSeen = ref(false)
const experienceActive = ref(false)
const activeSceneLevel = ref<K12SceneLevel>('immersive')
let recordStatus: RecordStatus = 'unread'

const skinActive = computed(
  () => preference.value === 'k12' && (introSeen.value || experienceActive.value),
)
const scene = computed(() => (skinActive.value && experienceActive.value ? 'k12' : 'default'))
const sceneLevel = computed<K12SceneLevel>(() =>
  scene.value === 'k12' ? activeSceneLevel.value : 'shell',
)

function isPreference(value: unknown): value is K12AppearancePreference {
  return value === 'k12' || value === 'default'
}

function applyProjection() {
  if (typeof document === 'undefined' || !document.body) return
  document.body.dataset.k12SkinPreference = preference.value
  document.body.dataset.k12SkinActive = skinActive.value ? 'k12' : 'default'
  document.body.dataset.experience = experienceActive.value ? 'k12' : 'default'
  document.body.dataset.scene = scene.value
  document.body.dataset.k12SceneLevel = sceneLevel.value
}

function initialize() {
  if (recordStatus !== 'unread' || typeof window === 'undefined') {
    applyProjection()
    return
  }

  let raw: string | null
  try {
    raw = window.localStorage.getItem(K12_APPEARANCE_STORAGE_KEY)
  } catch {
    recordStatus = 'invalid'
    preference.value = 'default'
    introSeen.value = true
    applyProjection()
    return
  }
  if (raw === null) {
    recordStatus = 'none'
    preference.value = 'k12'
    introSeen.value = false
    applyProjection()
    return
  }

  try {
    const parsed = JSON.parse(raw) as Partial<K12AppearanceRecordV1>
    if (
      parsed.version !== 1 ||
      !isPreference(parsed.preference) ||
      typeof parsed.introSeen !== 'boolean'
    ) {
      throw new Error('unsupported appearance record')
    }
    recordStatus = 'valid'
    preference.value = parsed.preference
    introSeen.value = parsed.introSeen
  } catch {
    // 损坏或未知版本记录是显式安全边界：保持通用外观，不静默覆盖原记录。
    recordStatus = 'invalid'
    preference.value = 'default'
    introSeen.value = true
  }
  applyProjection()
}

function persist() {
  if (typeof window === 'undefined') return
  const record: K12AppearanceRecordV1 = {
    version: 1,
    preference: preference.value,
    introSeen: introSeen.value,
  }
  recordStatus = 'valid'
  try {
    window.localStorage.setItem(K12_APPEARANCE_STORAGE_KEY, JSON.stringify(record))
  } catch {
    // 运行态仍保持用户刚选择的结果；存储不可用时不让外观切换导致页面崩溃。
  }
}

/** 设置页唯一写入口；与明暗主题完全正交。 */
function setPreference(next: K12AppearancePreference) {
  initialize()
  preference.value = next
  introSeen.value = true
  persist()
  applyProjection()
}

/**
 * 真实辅导场景首次进入入口。返回 true 仅表示本次需要展示已批准的一次性 Action Toast。
 * 已保存 default、损坏或未知版本记录均不被自动覆盖。
 */
function activateOnFirstEntry(): boolean {
  initialize()
  experienceActive.value = true
  activeSceneLevel.value = 'immersive'

  const shouldIntroduce =
    recordStatus === 'none' ||
    (recordStatus === 'valid' && preference.value === 'k12' && !introSeen.value)

  if (shouldIntroduce) {
    preference.value = 'k12'
    introSeen.value = true
    persist()
  }
  applyProjection()
  return shouldIntroduce
}

function setExperienceSceneLevel(level: Exclude<K12SceneLevel, 'shell'>) {
  activeSceneLevel.value = level
  applyProjection()
}

function deactivateExperience() {
  experienceActive.value = false
  applyProjection()
}

export function useK12Appearance() {
  initialize()
  return {
    preference,
    introSeen,
    skinActive,
    scene,
    sceneLevel,
    setPreference,
    activateOnFirstEntry,
    setExperienceSceneLevel,
    deactivateExperience,
  }
}

/** 测试用：复位模块级 owner，不触碰调用方未明确设置的其他 localStorage。 */
export function __resetK12AppearanceForTest() {
  preference.value = 'k12'
  introSeen.value = false
  experienceActive.value = false
  activeSceneLevel.value = 'immersive'
  recordStatus = 'unread'
  applyProjection()
}
