import { apiPut } from '@/api/client'

export type UserFeedback = '' | 'like' | 'dislike'

export function updateMessageFeedback(messageId: string, feedback: UserFeedback) {
  return apiPut<{ message: string }>(`/api/v1/messages/${encodeURIComponent(messageId)}/feedback`, {
    feedback,
  })
}
