import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import K12PracticeCandidateSelectionModal from '../components/K12PracticeCandidateSelectionModal.vue'
import K12MistakeReviewMenu from '../components/K12MistakeReviewMenu.vue'
import K12WeeklyPracticePanel from '../components/K12WeeklyPracticePanel.vue'
import type { PracticeCandidateSelectionDTO } from '@/api/k12'

const markdownStub = {
  template: '<div class="markdown-stub">{{ content }}</div>',
  props: ['content'],
}

function selection(
  originalState: 'ready' | 'already_in_set' = 'ready',
): PracticeCandidateSelectionDTO {
  return {
    selection_id: 'selection-1',
    source_mistake_id: 'mistake-1',
    target_set_record_id: 'set-1',
    state: 'open',
    next_batch_ordinal: 2,
    revision: 3,
    candidates: [
      {
        candidate_id: 'original-1',
        candidate_kind: 'original',
        batch_ordinal: 0,
        candidate_ordinal: 0,
        normalized_content_hash: 'hash-original',
        state: originalState,
        question_markdown: '原题',
      },
      {
        candidate_id: 'variant-ready',
        candidate_kind: 'variant',
        batch_ordinal: 1,
        candidate_ordinal: 0,
        normalized_content_hash: 'hash-ready',
        state: 'ready',
        question_markdown: '变式一',
      },
      {
        candidate_id: 'variant-failed',
        candidate_kind: 'variant',
        batch_ordinal: 1,
        candidate_ordinal: 1,
        normalized_content_hash: 'hash-failed',
        state: 'failed',
        question_markdown: '',
        failure_message: '生成失败',
      },
      {
        candidate_id: 'variant-generating',
        candidate_kind: 'variant',
        batch_ordinal: 1,
        candidate_ordinal: 2,
        normalized_content_hash: '',
        state: 'generating',
        question_markdown: '',
      },
    ],
  }
}

describe('BUG-20260725-010/011 candidate selection', () => {
  it('keeps the original first and selected, while each candidate has an independent state', async () => {
    const wrapper = mount(K12PracticeCandidateSelectionModal, {
      props: {
        open: true,
        originalQuestion: '原题',
        selection: selection(),
      },
      global: { stubs: { Teleport: true, MarkdownRenderer: markdownStub } },
    })

    const items = wrapper.findAll('.candidate-modal__item')
    expect(items).toHaveLength(4)
    expect(items[0]!.text()).toContain('原题')
    expect((items[0]!.get('input').element as HTMLInputElement).checked).toBe(true)
    expect(items[2]!.text()).toContain('生成失败')
    expect((items[2]!.get('input').element as HTMLInputElement).disabled).toBe(true)
    expect(items[3]!.text()).toContain('生成中')
    expect(wrapper.get('[data-testid="practice-candidate-commit"]').text()).toContain(
      '加入练习集（1）',
    )

    await items[1]!.get('input').setValue(true)
    await wrapper.get('[data-testid="practice-candidate-commit"]').trigger('click')
    expect(wrapper.emitted('commit')?.[0]).toEqual([['original-1', 'variant-ready']])
  })

  it('keeps an already-added original checked and disabled without counting it as new', async () => {
    const wrapper = mount(K12PracticeCandidateSelectionModal, {
      props: {
        open: true,
        originalQuestion: '原题',
        selection: selection('already_in_set'),
      },
      global: { stubs: { Teleport: true, MarkdownRenderer: markdownStub } },
    })
    const original = wrapper.findAll('.candidate-modal__item')[0]!
    const checkbox = original.get('input').element as HTMLInputElement
    expect(checkbox.checked).toBe(true)
    expect(checkbox.disabled).toBe(true)
    expect(original.text()).toContain('已在练习集')
    expect(wrapper.get('[data-testid="practice-candidate-commit"]').text()).toContain(
      '加入练习集（0）',
    )

    await wrapper.get('[data-testid="practice-candidate-generate"]').trigger('click')
    expect(wrapper.emitted('generate')).toHaveLength(1)
  })
})

describe('BUG-20260725-013/017 review actions', () => {
  it('requires the all-mistakes more menu and explicit confirmation before suppressing', async () => {
    const wrapper = mount(K12MistakeReviewMenu, {
      props: { suppressed: false },
      attachTo: document.body,
    })
    expect(wrapper.text()).not.toContain('不再复习')
    await wrapper.get('[aria-label="更多错题操作"]').trigger('click')
    await wrapper.get('[role="menuitem"]').trigger('click')
    expect(document.body.textContent).toContain('不会把它标记为已掌握')
    const confirm = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="confirm-suppress-review"]',
    )
    expect(confirm).not.toBeNull()
    confirm!.click()
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('suppress')).toHaveLength(1)
    wrapper.unmount()
  })

  it('emits defer only for a due-review item in the current weekly plan', async () => {
    const wrapper = mount(K12WeeklyPracticePanel, {
      props: {
        progress: null,
        settings: {
          textbook_consolidation_enabled: false,
          arithmetic_warmup_enabled: false,
        } as never,
        plan: {
          plan_id: 'plan-1',
          revision: 2,
          iso_week_year: 2026,
          iso_week_number: 31,
          local_start_date: '2026-07-27',
          local_end_date: '2026-08-02',
          tracks: [
            {
              plan_section: 'due_review',
              status: 'ready',
              items: [
                {
                  item_id: 'weekly-1',
                  position: 1,
                  plan_section: 'due_review',
                  source_kind: 'mistake',
                  generation_method: 'original',
                  source_ref: 'mistake-1',
                  verification: { status: 'verified', evidence_refs: [] },
                  prompt_markdown: '原题',
                },
              ],
            },
          ],
        } as never,
        history: [],
      },
      global: {
        stubs: {
          MarkdownRenderer: markdownStub,
          FinalArtifactActions: true,
        },
      },
    })
    const defer = wrapper.get('.weekly-item__defer')
    expect(defer.text()).toBe('本周先不练')
    await defer.trigger('click')
    expect(wrapper.emitted('defer-item')?.[0]?.[0]).toMatchObject({
      item_id: 'weekly-1',
      source_ref: 'mistake-1',
    })
  })
})
