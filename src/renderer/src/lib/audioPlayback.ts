function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * Schedules Gemini's PCM16 24kHz audio-out chunks back-to-back for gapless
 * streaming playback, and can flush everything queued when the model is interrupted.
 */
export class AudioPlayer {
  private ctx: AudioContext
  private nextStartTime = 0
  private activeSources: AudioBufferSourceNode[] = []

  constructor() {
    this.ctx = new AudioContext({ sampleRate: 24000 })
  }

  enqueue(base64Pcm16: string): void {
    const bytes = base64ToUint8Array(base64Pcm16)
    const sampleCount = Math.floor(bytes.byteLength / 2)
    const pcm16 = new Int16Array(bytes.buffer, bytes.byteOffset, sampleCount)
    const float32 = new Float32Array(sampleCount)
    for (let i = 0; i < sampleCount; i++) float32[i] = pcm16[i] / 0x8000

    const buffer = this.ctx.createBuffer(1, sampleCount, 24000)
    buffer.copyToChannel(float32, 0)

    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    source.connect(this.ctx.destination)
    source.onended = () => {
      this.activeSources = this.activeSources.filter((s) => s !== source)
    }

    const startAt = Math.max(this.ctx.currentTime, this.nextStartTime)
    source.start(startAt)
    this.nextStartTime = startAt + buffer.duration
    this.activeSources.push(source)
  }

  clear(): void {
    for (const source of this.activeSources) {
      try {
        source.stop()
      } catch {
        // already stopped
      }
    }
    this.activeSources = []
    this.nextStartTime = this.ctx.currentTime
  }

  close(): void {
    this.clear()
    void this.ctx.close()
  }
}
