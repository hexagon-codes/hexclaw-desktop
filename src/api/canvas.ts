/**
 * Canvas/A2UI API
 *
 * 面板管理和事件处理。
 */

import { apiGet, apiPost } from './client'

/** 面板概要 */
export interface PanelSummary {
  id: string
  title: string
  component_count: number
  version: number
}

/** 获取面板列表 */
export function listPanels() {
  return apiGet<{ panels: PanelSummary[]; total: number }>('/api/v1/canvas/panels')
}

/** 获取面板详情 */
export function getPanel(id: string) {
  return apiGet<Record<string, unknown>>(`/api/v1/canvas/panels/${encodeURIComponent(id)}`)
}

/** 发送 Canvas 事件 */
export function sendCanvasEvent(panelId: string, componentId: string, action: string, data?: Record<string, unknown>) {
  return apiPost<Record<string, unknown>>('/api/v1/canvas/events', {
    panel_id: panelId,
    component_id: componentId,
    action,
    data,
  })
}
