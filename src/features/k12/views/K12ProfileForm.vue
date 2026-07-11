<script setup lang="ts">
/**
 * 作业辅导助手建档表单（features/k12）· M1-2 · PRD §5.2.2。
 *
 * 采集 称呼/年级学期/教材版本 → agents.metadata（scenario 标记 + grade 确定性注入通道）。
 * 显示名自动生成「{称呼}的辅导助手 · {年级}」；provider/model 留空=跟随全局默认强推理模型。
 * 回归锁：不按学段×学科拆分老师卡——一张模板一份实例，多孩靠多实例结构隔离。
 */
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { nanoid } from 'nanoid'
import { registerAgent, updateAgent, unregisterAgent } from '@/api/agents'
import { k12UpdateProfile } from '@/api/k12'
import { useK12Store } from '../store'
import { useAgentsStore } from '@/stores/agents'
import { useToast } from '@/composables/useToast'
import HcSelect from '@/components/common/HcSelect.vue'
import { GRADES, TEXTBOOKS, gradeShort } from '../curriculum'
import { K12_SCENARIO_ID } from '../descriptor'
import { K12_TEMPLATE_SKILLS, K12_INFRA_SKILLS, isRequiredSkill, defaultBoundSkills } from '../manifest'

/** 建档/改档同构：传 agent 即进「改档」模式（预填 + updateAgent），否则「建档」（registerAgent） */
const props = defineProps<{
  agent?: { name: string; display_name?: string; metadata?: Record<string, string>; skills?: string[]; system_prompt?: string }
}>()

const emit = defineEmits<{ (e: 'created', name: string): void; (e: 'close'): void; (e: 'removed', name: string): void }>()

const { t } = useI18n()
const toast = useToast()
const agentsStore = useAgentsStore()
const k12Store = useK12Store()

const isEdit = computed(() => !!props.agent)

// 档案存在 agent metadata 的 k12.* 键（后端契约）
const childName = ref(props.agent?.metadata?.['k12.child_name'] ?? '')
const grade = ref(props.agent?.metadata?.['k12.grade_term'] ?? '五年级上')
const textbook = ref(props.agent?.metadata?.['k12.textbook_edition'] ?? '人教版')
const submitting = ref(false)
const error = ref('')

// BUG-20260710 ①：删除档案下沉到编辑弹层（原型 K12 卡动作行无删除，卡面孤行删除是漂移）。
// 两步确认防误触；成功后 emit removed 让宿主刷新列表。
const deleteConfirming = ref(false)
const deleting = ref(false)
async function removeProfile() {
  if (!props.agent || deleting.value) return
  deleting.value = true
  error.value = ''
  try {
    await unregisterAgent(props.agent.name)
    toast.success(t('k12.profile.deleted', { name: displayName.value }))
    emit('removed', props.agent.name)
    emit('close')
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    deleting.value = false
  }
}

// 默认 skill 从 manifest 全挂好（帮家长预选）；改档时从当前实例 skills 初始化（保留自定义）
const enabledSkills = ref<Set<string>>(
  new Set(props.agent?.skills?.length ? props.agent.skills : defaultBoundSkills()),
)
const skillsDirty = ref(false)

function isEnabled(name: string): boolean {
  return isRequiredSkill(name) || enabledSkills.value.has(name)
}
function toggleSkill(name: string): void {
  if (isRequiredSkill(name)) return // 必备底线锁定
  const s = new Set(enabledSkills.value)
  if (s.has(name)) s.delete(name)
  else s.add(name)
  enabledSkills.value = s
  skillsDirty.value = true
}
/** 最终绑定集 = 必备 P0 ∪ 已勾选 ∪ 基础设施（k12_grade） */
function boundSkills(): string[] {
  const s = new Set(enabledSkills.value)
  for (const sk of K12_TEMPLATE_SKILLS) if (sk.tier === 'P0') s.add(sk.name)
  for (const infra of K12_INFRA_SKILLS) s.add(infra)
  return [...s]
}

const displayName = computed(() =>
  t('k12.profile.autoName', {
    child: childName.value.trim() || t('k12.profile.namePlaceholder'),
    grade: gradeShort(grade.value),
  }),
)

// 卡片副标题（智能体页运行中卡 agent.description）：据档案派生「教材 · 年级学期 · 按年级边界讲解」，
// 非写死——改年级/教材即时跟随（与 display_name 同为确定性派生，原型 app.html #agentCard 同步）。
const cardDescription = computed(() =>
  t('k12.profile.cardDesc', { textbook: textbook.value, grade: grade.value }),
)

// HcSelect 选项（替代原生 <select>；WKWebView 下原生 select 显 macOS Aqua 样式 · BUG-20260708 B2）
const gradeOptions = computed(() => GRADES.map((g) => ({ value: g, label: g })))
const textbookOptions = computed(() => TEXTBOOKS.map((tb) => ({ value: tb, label: tb })))

// 辅导助手人设(SOUL)：只挂 skill 不设 system_prompt → 身份回落默认助理「小蟹」（BUG-20260708 F2，真机
// qwen3.5:9b 取证）。据档案派生身份 + 讲题边界，随年级/教材跟随；建档/改档均回写，使 tutor 自我认同为
// 「{孩子}的辅导助手」而非小蟹。K12 领域文案，内联于 features/k12（AP-1 允许）。
const tutorSoul = computed(() => {
  const child = childName.value.trim() || t('k12.profile.namePlaceholder')
  return `你是${child}的${grade.value}辅导助手，帮家长辅导孩子——像老师一样有耐心、懂教学法，但教的是家长怎么教，不是通用助手。被问到身份时，明确回答你是「${child}的辅导助手」。始终按${textbook.value} · ${grade.value}的教材范围讲题，绝不超纲用初中/高中说法；用渐进提示引导孩子自己想，不直接报答案；先肯定孩子做对的部分再纠错，多鼓励。家长找你要辅导要点、出题、看学情时照常配合。`
})

// 「辅导语气」可编辑人设（D3·原型建档设计有此编辑框，app 曾漏实现→tutor 无人设回落小蟹）：
// 预填派生人设、家长可微调。未编辑 → 随档案（年级/教材）跟随；编辑后 → 保留自定义。改档优先用实例已有
// system_prompt。最终 soulText 回写 system_prompt（真正让 tutor 认同为辅导助手，见 F2/D3/D4 链）。
const soulDirty = ref(!!props.agent?.system_prompt?.trim())
const soulText = ref(props.agent?.system_prompt?.trim() || tutorSoul.value)
watch(tutorSoul, (v) => { if (!soulDirty.value) soulText.value = v })
function resetSoul() { soulDirty.value = false; soulText.value = tutorSoul.value }

async function submit() {
  submitting.value = true
  error.value = ''
  try {
    if (isEdit.value && props.agent) {
      // 改档：显示名走 updateAgent（随年级重算）；档案字段走后端官方 PUT /profile（写 k12.* + 校验年级 + 懒重算边界）
      // 技能仅在「高级」里动过才回写，避免误清空实例已有 skills
      await updateAgent(props.agent.name, {
        display_name: displayName.value,
        description: cardDescription.value,
        system_prompt: soulText.value, // 改档回写人设（家长可编辑的「辅导语气」，未改则随档案派生，F2/D3）
        ...(skillsDirty.value ? { skills: boundSkills() } : {}),
      })
      await k12UpdateProfile({
        agent: props.agent.name,
        child_name: childName.value.trim(),
        grade_term: grade.value,
        textbook_edition: textbook.value,
      })
      await agentsStore.loadAgents()
      toast.success(t('k12.profile.saved'))
      emit('created', props.agent.name)
      emit('close')
      return
    }
    // 建档：先注册 agent（scenario 标记驱动前端 registry 解析增强视图），再经 /profile 写档案 k12.*
    const name = `${K12_SCENARIO_ID}-${nanoid(8)}`
    await registerAgent({
      name,
      display_name: displayName.value,
      description: cardDescription.value, // 卡片副标题派生（教材·年级·tagline），随档案跟随
      system_prompt: soulText.value, // 辅导助手人设（家长可编辑「辅导语气」，未改则派生）：身份+讲题边界（F2/D3）
      model: '', // 空 provider/model = 跟随全局默认强推理模型
      provider: '',
      // 默认 skill 从模板 manifest 全挂好（P0 必备 + P1 默认 + k12_grade 基础设施）
      skills: boundSkills(),
      metadata: { scenario: K12_SCENARIO_ID, avatar: '🎓' },
    })
    try {
      await k12UpdateProfile({
        agent: name,
        child_name: childName.value.trim(),
        grade_term: grade.value,
        textbook_edition: textbook.value,
      })
    } catch (profileError) {
      // register 已成功而档案写入失败时，补偿删除刚注册的半成品，避免卡片无年级/无孩子地残留。
      try {
        await unregisterAgent(name)
      } catch (rollbackError) {
        const original = profileError instanceof Error ? profileError.message : String(profileError)
        const rollback = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
        throw new Error(`${original}; rollback failed: ${rollback}`)
      }
      throw profileError
    }
    await agentsStore.loadAgents()
    // 随模板默认注册自动化任务（错题卷/提醒/月报/学期确认，投递桌面 chat）。
    // 最佳努力、不阻断建档：桌面未启用 cron 时后端 501，store 已静默降级。
    void k12Store.setupAutomation(name).catch(() => {})
    toast.success(t('k12.profile.created', { name: displayName.value }))
    emit('created', name)
    emit('close')
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <!-- Teleport 到 body：本弹窗内联渲染在智能体卡内，overlay 的 position:fixed 会被卡片的 transform
       祖先破坏（fixed 变成相对该祖先定位）→ 弹窗错位/footer 截断。Teleport 后回到视口坐标。 -->
  <Teleport to="body">
    <div class="k12pf-overlay" @click.self="emit('close')">
    <div class="k12pf" role="dialog" aria-modal="true">
      <div class="k12pf__head">
        <b>{{ isEdit ? t('k12.profile.editTitle', { name: agent!.display_name || agent!.name }) : t('k12.profile.createTitle') }}</b>
        <button class="k12pf__x" :aria-label="t('k12.profile.cancel')" @click="emit('close')">✕</button>
      </div>

      <div class="k12pf__body">
        <p class="k12pf__intro">{{ isEdit ? t('k12.profile.editNote') : t('k12.profile.intro', { name: displayName }) }}</p>

        <label class="k12pf__field">
          <span>{{ t('k12.profile.childName') }}</span>
          <input v-model="childName" class="k12pf__input" :placeholder="t('k12.profile.childNamePlaceholder')" />
        </label>

        <div class="k12pf__row">
          <div class="k12pf__field">
            <span>{{ t('k12.profile.grade') }}</span>
            <HcSelect v-model="grade" :options="gradeOptions" />
          </div>
          <div class="k12pf__field">
            <span>{{ t('k12.profile.textbook') }}</span>
            <HcSelect v-model="textbook" :options="textbookOptions" />
          </div>
        </div>

        <!-- 顶层：能力（人话·只读·安心感），不是让家长勾选的技能清单 -->
        <div class="k12pf__field">
          <span>{{ t('k12.profile.skillsLabel') }}</span>
          <div class="k12pf__skills">{{ t('k12.profile.skills') }}</div>
        </div>

        <!-- 高级折叠：默认技能已全挂好，可微调；P0 必备锁定。默认家长不展开 -->
        <details class="k12pf__adv">
          <summary>{{ t('k12.profile.advancedSkills') }}</summary>
          <div class="k12pf__skilllist">
            <label
              v-for="sk in K12_TEMPLATE_SKILLS"
              :key="sk.name"
              class="k12pf__skillrow"
              :class="{ 'k12pf__skillrow--locked': isRequiredSkill(sk.name) }"
            >
              <input
                type="checkbox"
                :checked="isEnabled(sk.name)"
                :disabled="isRequiredSkill(sk.name)"
                @change="toggleSkill(sk.name)"
              />
              <span class="k12pf__skillicon">{{ sk.icon }}</span>
              <span class="k12pf__skillname">{{ t(sk.labelKey) }}</span>
              <span v-if="isRequiredSkill(sk.name)" class="k12pf__reqtag">{{ t('k12.profile.requiredTag') }}</span>
            </label>
          </div>
        </details>

        <!-- 辅导语气(人设)：预填据档案派生的人设，家长可微调（D3·原型建档有此编辑框，app 曾漏→tutor 回落小蟹）。
             未改则随年级/教材跟随；改了则保留自定义。回写 agent.system_prompt。 -->
        <details class="k12pf__adv">
          <summary>辅导语气 · 已按档案配好，可微调</summary>
          <div class="k12pf__soul">
            <textarea
              v-model="soulText"
              class="k12pf__soultext"
              data-testid="k12-soul-text"
              rows="4"
              @input="soulDirty = true"
            />
            <button v-if="soulDirty" type="button" class="k12pf__soulreset" @click="resetSoul">恢复默认语气</button>
          </div>
        </details>

        <p v-if="!isEdit" class="k12pf__hint">{{ t('k12.profile.modelNote') }}</p>
        <div v-if="!isEdit" class="k12pf__note">{{ t('k12.profile.twoChildHint') }}</div>
        <p v-if="error" class="k12pf__err">{{ error }}</p>
      </div>

      <div class="k12pf__foot">
        <template v-if="isEdit">
          <button
            v-if="!deleteConfirming"
            class="k12pf__btn k12pf__btn--danger"
            data-testid="k12pf-delete"
            @click="deleteConfirming = true"
          >{{ t('k12.profile.delete') }}</button>
          <button
            v-else
            class="k12pf__btn k12pf__btn--danger"
            data-testid="k12pf-delete-confirm"
            :disabled="deleting"
            @click="removeProfile"
          >{{ t('k12.profile.deleteConfirm') }}</button>
        </template>
        <span class="k12pf__footsp" />
        <button class="k12pf__btn" @click="emit('close')">{{ t('k12.profile.cancel') }}</button>
        <button class="k12pf__btn k12pf__btn--primary" :disabled="submitting" @click="submit">
          {{ isEdit ? t('k12.profile.save') : t('k12.profile.create') }}
        </button>
      </div>
    </div>
    </div>
  </Teleport>
</template>

<style scoped>
.k12pf-overlay {
  /* modal 层（9100）——须低于 popover（9200），否则内部 HcSelect 下拉被遮罩压住不可见（BUG-20260708）。 */
  position: fixed; inset: 0; z-index: var(--hc-z-modal);
  display: flex; align-items: flex-start; justify-content: center; padding-top: 11vh;
  background: rgba(8, 18, 32, 0.4);
  backdrop-filter: blur(3px) saturate(120%);
  -webkit-backdrop-filter: blur(3px) saturate(120%);
}
.k12pf {
  width: 478px; max-width: 92vw;
  background: var(--hc-bg-elevated); border: 0.5px solid var(--hc-border);
  border-radius: 16px; box-shadow: var(--hc-shadow-float); overflow: hidden;
}
.k12pf__head {
  display: flex; align-items: center; padding: 16px 18px; border-bottom: 0.5px solid var(--hc-border);
  font-size: 15px;
}
.k12pf__x {
  margin-left: auto; width: 28px; height: 28px; border-radius: 8px; border: none;
  background: transparent; color: var(--hc-text-muted); cursor: pointer; font-size: 13px;
}
.k12pf__x:hover { background: var(--hc-bg-hover); color: var(--hc-text-primary); }
.k12pf__body { padding: 18px; max-height: 62vh; overflow: auto; display: flex; flex-direction: column; gap: 14px; }
.k12pf__intro {
  margin: 0; font-size: 12.5px; color: var(--hc-text-secondary);
  background: var(--hc-bg-card); border: 0.5px solid var(--hc-border); border-radius: 10px; padding: 10px 12px;
}
.k12pf__field { display: flex; flex-direction: column; gap: 6px; flex: 1; }
.k12pf__field > span { font-size: 13px; color: var(--hc-text-primary); }
.k12pf__row { display: flex; gap: 12px; }
.k12pf__input {
  padding: 9px 12px; border-radius: 10px; border: 0.5px solid var(--hc-border);
  background: var(--hc-bg-input); font: inherit; font-size: 13px; color: var(--hc-text-primary); outline: none;
}
.k12pf__input:focus { border-color: var(--hc-accent); box-shadow: 0 0 0 3px var(--hc-accent-subtle); }
.k12pf__skills { font-size: 12px; color: var(--hc-text-secondary); }
.k12pf__adv { border: 0.5px solid var(--hc-border); border-radius: 10px; padding: 2px 4px; }
.k12pf__adv > summary {
  cursor: pointer; list-style: none; padding: 8px 8px; font-size: 12.5px; color: var(--hc-text-secondary);
}
.k12pf__adv > summary::-webkit-details-marker { display: none; }
.k12pf__adv[open] > summary { color: var(--hc-text-primary); }
.k12pf__skilllist { display: flex; flex-direction: column; gap: 2px; padding: 4px 8px 8px; }
.k12pf__skillrow {
  display: flex; align-items: center; gap: 8px; padding: 6px 6px; border-radius: 8px; font-size: 12.5px;
  color: var(--hc-text-primary); cursor: pointer;
}
.k12pf__skillrow:hover { background: var(--hc-bg-hover); }
.k12pf__skillrow--locked { cursor: default; opacity: 0.9; }
.k12pf__skillicon { font-size: 14px; flex-shrink: 0; }
.k12pf__skillname { flex: 1; min-width: 0; }
.k12pf__reqtag {
  font-size: 10px; padding: 1px 7px; border-radius: 5px; font-weight: 600;
  background: var(--hc-accent-subtle); color: var(--hc-accent);
}
.k12pf__soul { display: flex; flex-direction: column; gap: 8px; padding: 6px 8px 8px; }
.k12pf__soultext {
  width: 100%; box-sizing: border-box; font: inherit; font-size: 12.5px; line-height: 1.6; resize: vertical;
  padding: 8px 10px; border-radius: 8px; border: 0.5px solid var(--hc-border);
  background: var(--hc-bg-input); color: var(--hc-text-primary); outline: none;
}
.k12pf__soultext:focus { border-color: var(--hc-accent); box-shadow: 0 0 0 3px var(--hc-accent-subtle); }
.k12pf__soulreset {
  align-self: flex-start; font-size: 11.5px; padding: 4px 10px; border-radius: 7px; cursor: pointer;
  border: 0.5px solid var(--hc-border); background: transparent; color: var(--hc-text-secondary);
}
.k12pf__soulreset:hover { background: var(--hc-bg-hover); color: var(--hc-text-primary); }
.k12pf__hint { margin: 0; font-size: 11.5px; color: var(--hc-text-muted); }
.k12pf__note {
  font-size: 12px; color: var(--hc-text-secondary);
  background: var(--hc-bg-card); border: 0.5px solid var(--hc-border); border-radius: 10px; padding: 10px 12px;
}
.k12pf__err { margin: 0; font-size: 12.5px; color: var(--hc-error); }
.k12pf__foot { display: flex; align-items: center; gap: 10px; padding: 14px 18px; border-top: 0.5px solid var(--hc-border); }
.k12pf__footsp { flex: 1; }
.k12pf__btn--danger { color: var(--hc-error); border-color: color-mix(in srgb, var(--hc-error) 35%, var(--hc-border)); }
.k12pf__btn--danger:hover { background: color-mix(in srgb, var(--hc-error) 10%, transparent); }
.k12pf__btn {
  padding: 8px 14px; border-radius: 10px; font-size: 13px; cursor: pointer;
  border: 0.5px solid var(--hc-border); background: var(--hc-bg-input); color: var(--hc-text-primary);
}
.k12pf__btn--primary {
  background: linear-gradient(180deg, #5fb3ea 0%, #4a9de0 100%); color: #fff; border-color: transparent;
}
.k12pf__btn:disabled { opacity: 0.6; cursor: default; }
</style>
