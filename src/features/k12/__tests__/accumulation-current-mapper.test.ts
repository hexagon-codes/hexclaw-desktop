import { describe, expect, it } from 'vitest'
import type { AccumDTO } from '@/api/k12'
import { accumToRecord } from '../mappers'
import { ACCUMULATION_SCHEMA } from '../schemas'

describe('current accumulation canonical projection', () => {
  it('keeps server-derived metadata and durable generation without a mastery/status projection', () => {
    const dto: AccumDTO = {
      record_id: 'accum-1',
      subject: '英语',
      entry_type: '表达积累',
      content: 'a piece of cake',
      source: 'Unit 4',
      version: 3,
      dictation_generation: {
        generation_id: 'generation-1',
        status: 'validating',
        attempt: 2,
        updated_at: 100,
      },
    }

    const record = accumToRecord(dto, 'mingming')

    expect(record.status).toBeUndefined()
    expect(record.version).toBe(3)
    expect(record.fields).toEqual({
      subject: '英语',
      entry_type: '表达积累',
      content: 'a piece of cake',
      source: 'Unit 4',
      created_at: '',
      dictation_generation: dto.dictation_generation,
    })
  })

  it('declares accumulation as a stateless collection', () => {
    expect(ACCUMULATION_SCHEMA.states).toBeUndefined()
    expect(ACCUMULATION_SCHEMA.transitions).toBeUndefined()
    expect(ACCUMULATION_SCHEMA.reviewable).toBe(false)
  })
})
