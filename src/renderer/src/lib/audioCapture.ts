export interface AudioCaptureHandle {
  stop: () => void
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

/**
 * Captures mic audio, downsamples via the AudioContext's own sample rate to 16kHz,
 * and delivers little-endian PCM16 mono chunks as base64 — the format the Gemini
 * Live API expects for `sendRealtimeInput`.
 */
export async function startAudioCapture(
  onChunk: (base64Pcm16: string) => void
): Promise<AudioCaptureHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  })

  const audioContext = new AudioContext({ sampleRate: 16000 })
  // Chromium can create a new AudioContext already 'suspended' pending a user gesture. A session
  // started via the global hotkey (main process IPC, not a real DOM click/keypress) doesn't
  // count as one, so without an explicit resume() it can silently never produce a single audio
  // frame. Harmless no-op if it was already running (e.g. triggered by the spacebar).
  void audioContext.resume()
  const source = audioContext.createMediaStreamSource(stream)
  // ScriptProcessorNode is deprecated in favor of AudioWorklet, but needs no extra
  // module file to load and is supported everywhere — fine for v1.
  const processor = audioContext.createScriptProcessor(4096, 1, 1)
  const silence = audioContext.createGain()
  silence.gain.value = 0 // keep the graph alive without echoing the mic back out

  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0)
    const pcm16 = new Int16Array(input.length)
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]))
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }
    onChunk(arrayBufferToBase64(pcm16.buffer))
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
