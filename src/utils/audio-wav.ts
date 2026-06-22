/**
 * 浏览器录音转码为 16-bit PCM WAV。
 *
 * 为什么需要（AUD-4）：OpenAI gpt-4o-audio 的 `input_audio.format` 只接受 wav/mp3，
 * 而浏览器 MediaRecorder 产出的是 webm/opus 或 mp4/aac。直传 webm 字节却标 format='wav'
 * 会被上游解码拒绝 → 语音输入对话失败。故录音上送前先在前端解码并重编码为 WAV，
 * 使 `format:'wav'` 与真实字节一致。
 */

/** 把音频 blob 解码并重编码为 WAV，返回 base64（不含 data: 前缀）。环境不支持时抛错由调用方兜底。 */
export async function audioBlobToWavBase64(blob: Blob): Promise<string> {
  const Ctx =
    (typeof window !== 'undefined' &&
      (window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)) ||
    undefined
  if (!Ctx || typeof blob.arrayBuffer !== 'function') {
    throw new Error('当前环境不支持音频转码（AudioContext 不可用）')
  }
  const arrayBuffer = await blob.arrayBuffer()
  const ctx = new Ctx()
  try {
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer)
    return arrayBufferToBase64(encodeWav(audioBuffer))
  } finally {
    if (ctx.state !== 'closed') void ctx.close()
  }
}

/** AudioBuffer → 16-bit PCM WAV（交错多声道）。 */
function encodeWav(buffer: AudioBuffer): ArrayBuffer {
  const numChannels = buffer.numberOfChannels
  const sampleRate = buffer.sampleRate
  const numFrames = buffer.length
  const bytesPerSample = 2
  const blockAlign = numChannels * bytesPerSample
  const dataSize = numFrames * blockAlign
  const out = new ArrayBuffer(44 + dataSize)
  const view = new DataView(out)
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }

  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM chunk size
  view.setUint16(20, 1, true) // audio format = PCM
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true) // byte rate
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 8 * bytesPerSample, true) // bits per sample
  writeStr(36, 'data')
  view.setUint32(40, dataSize, true)

  const channels: Float32Array[] = []
  for (let c = 0; c < numChannels; c++) channels.push(buffer.getChannelData(c))
  let offset = 44
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const sample = Math.max(-1, Math.min(1, channels[c]![i]!))
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
      offset += 2
    }
  }
  return out
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}
