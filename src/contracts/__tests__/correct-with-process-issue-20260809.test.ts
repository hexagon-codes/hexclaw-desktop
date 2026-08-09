import { describe, expect, it } from 'vitest'
import { assertImageTaskResultSemantics } from '../k12-image-task-semantics'

function processIssueResult() {
  return {
    dispatch_id: 'dispatch-process-issue',
    task_intent: 'completed_homework',
    status: 'routed',
    result: {
      kind: 'completed_homework',
      payload: {
        mode: 'grade',
        task_intent: 'completed_homework',
        result_surface: 'annotated_homework',
        items: [
          {
            question: {
              problem_id: 'problem-15',
              question: '鱼塘应用题',
              knowledge_points: ['应用题'],
              answer_state: 'present',
              student_answer: '11250',
              bbox: { x: 0.08, y: 0.8, w: 0.36, h: 0.08 },
            },
            status: 'correct_with_process_issue',
            result_kind: 'assessment',
            grade: {
              solution: '11250',
              verdict: 'disagree',
              assessment_status: 'correct_with_process_issue',
              final_answer_correct: true,
              evidence_type: 'numeric_exec',
              badge: 'disagree',
              wrong_step: '300÷2÷2=50',
              error_cause: '连续除法计算错误',
              out_of_scope: false,
              record_created: false,
            },
            parent_guide: {
              answer: '11250',
              full_solution_steps: ['先重算错误步骤。'],
              grade_level_method: '逐步验算。',
              likely_mistakes: ['连续除法算错。'],
              parent_teaching_sequence: ['先让孩子独立验算该步骤。'],
              follow_up_questions: ['300÷2÷2 应是多少？'],
              checking_method: '逐式代回。',
            },
          },
        ],
        markdown: '# 批改完成',
        image_warning: '',
        annotated_image: {
          mime: 'image/png',
          data_base64: 'QU5OT1RBVEVE',
        },
      },
    },
  }
}

function processGrade(response: ReturnType<typeof processIssueResult>): Record<string, unknown> {
  return response.result.payload.items[0]!.grade as unknown as Record<string, unknown>
}

describe('correct_with_process_issue ImageTask wire', () => {
  it('accepts the typed item status while keeping final-answer correctness as an independent fact', () => {
    expect(() => assertImageTaskResultSemantics(processIssueResult())).not.toThrow()
  })

  it('rejects a process item whose duplicate grade status drifts from item.status', () => {
    const response = processIssueResult()
    response.result.payload.items[0]!.grade.assessment_status = 'correct'

    expect(() => assertImageTaskResultSemantics(response)).toThrow(/assessment_status/)
  })

  it('requires an explicit true final-answer fact instead of inferring it from verdict or badge', () => {
    const response = processIssueResult()
    processGrade(response).final_answer_correct = false

    expect(() => assertImageTaskResultSemantics(response)).toThrow(/final_answer_correct/)
  })

  it.each(['wrong_step', 'error_cause'])('requires non-empty %s evidence', (field) => {
    const response = processIssueResult()
    processGrade(response)[field] = '   '

    expect(() => assertImageTaskResultSemantics(response)).toThrow(new RegExp(field))
  })

  it('rejects mistake persistence side effects for a process issue', () => {
    const response = processIssueResult()
    processGrade(response).record_created = true

    expect(() => assertImageTaskResultSemantics(response)).toThrow(
      /without mistake\/review side effect/,
    )
  })
})
