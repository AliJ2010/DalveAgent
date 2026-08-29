export interface WakeWordCaptureHandle {
  stop: () => void
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

/**
 * A SEPARATE, dedicated mic-capture pipeline for wake-word listening — deliberately not shared
 * with audioCapture.ts's real voice-session capture, for two reasons: (1) Porcupine needs an
 * exact frame length (usually 512 samples at 16kHz), which won't generally match whatever buffer
 * size a live session's own capture happens to use, and (2) the two are mutually exclusive in
 * practice anyway (wake-word listening stops the instant a real session starts — see
 * voiceSession.ts's wake-word bridge), so there's no real benefit to unifying them, only added
 * coupling between two independent concerns.
 */
export async function startWakeWordCapture(
  frameLength: number,
  onFrame: (base64Pcm16: string) => void
): Promise<WakeWordCaptureHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  })

  const audioContext = new AudioContext({ sampleRate: 16000 })
  void audioContext.resume()
  const source = audioContext.createMediaStreamSource(stream)
  // ScriptProcessorNode buffer sizes must be a power of two — Porcupine's frameLength (512) is
  // exactly one of the valid sizes, so no local re-chunking/buffering is needed on this side.
  const processor = audioContext.createScriptProcessor(frameLength, 1, 1)
  const silence = audioContext.createGain()
  silence.gain.value = 0

  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0)
    const pcm16 = new Int16Array(input.length)
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]))
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }
    onFrame(arrayBufferToBase64(pcm16.buffer))
  }

  source.connect(processor)
  processor.connect(silence)
  silence.connect(audioContext.destination)

  return {
    stop: () => {
      processor.disconnect()
      source.disconnect()
      silence.disconnect()
      stream.getTracks().forEach((t) => t.stop())
      void audioContext.close()
    }
  }
}
