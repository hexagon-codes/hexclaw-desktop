/** Toast 通知 */
export interface Toast {
  id: number
  type: 'success' | 'error' | 'warning' | 'info'
  message: string
}
