import { ParticleSphere } from './ParticleSphere'

interface BlobSpec {
  top?: string
  bottom?: string
  left?: string
  right?: string
  size: number
  color: string
  opacity: number
  speed: number
}

const BLOBS: BlobSpec[] = [
  { top: '-6%', left: '-4%', size: 340, color: '212,175,55', opacity: 0.22, speed: 0.6 },
  { top: '4%', right: '2%', size: 220, color: '160,110,40', opacity: 0.16, speed: 0.8 },
  { bottom: '-8%', left: '8%', size: 300, color: '90,70,30', opacity: 0.14, speed: 0.5 },
  { bottom: '-4%', right: '-4%', size: 380, color: '200,150,60', opacity: 0.2, speed: 0.45 },
  { top: '38%', left: '-8%', size: 200, color: '245,238,224', opacity: 0.08, speed: 0.7 },
  { top: '46%', right: '-6%', size: 240, color: '212,175,55', opacity: 0.12, speed: 0.65 }
]

export function BackgroundSpheres(): React.JSX.Element {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        pointerEvents: 'none',
        filter: 'blur(2px)'
      }}
    >
      {BLOBS.map((b, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            top: b.top,
            bottom: b.bottom,
            left: b.left,
            right: b.right,
            opacity: b.opacity
          }}
        >
          <ParticleSphere size={b.size} color={b.color} speed={b.speed} pointCount={160} />
        </div>
      ))}
    </div>
  )
}
