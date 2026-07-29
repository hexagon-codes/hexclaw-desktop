export type ActivityTimelineState = 'running' | 'completed' | 'failed'

export interface ActivityTimelineItem {
  id: string
  state: ActivityTimelineState
  label: string
  detail?: string
}
