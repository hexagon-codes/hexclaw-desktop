import type { ImageTaskDispatchDTO } from '@/api/k12'

// The POST observer and the resumed GET view must project the same failure.
export function projectImageTaskProgress(dispatch: ImageTaskDispatchDTO) {
  const { progress, target_projection: target } = dispatch
  if (progress.state === 'recovering') {
    return { stage: 'recovering', writingOCRFailure: false }
  }
  if (
    progress.operation === 'writing_ocr' &&
    ['failed', 'failed_retryable', 'failed_terminal'].includes(progress.state)
  ) {
    const canRetry = dispatch.retryable === true && progress.state !== 'failed_terminal'
    return { stage: canRetry ? 'failed_retryable' : 'failed_terminal', writingOCRFailure: true }
  }
  const stage = target?.kind === 'homework' ? target.stage
    : target?.kind === 'creative' && progress.operation === 'promotion' ? progress.state
      : target?.kind === 'creative' ? target.status : dispatch.status
  return { stage, writingOCRFailure: false }
}
