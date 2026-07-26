export type FinalArtifactAction = 'print' | 'export_pdf' | 'send_im'

export interface FinalArtifactActionIntent {
  action: FinalArtifactAction
  artifact_digest: string
}
