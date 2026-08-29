import * as THREE from 'three'

/**
 * DALVE's particle orb — a GPU (WebGL/Three.js) points system, replacing the old CPU Canvas2D
 * sphere (src/renderer/src/components/ParticleSphere.tsx) so it can actually scale to thousands
 * of particles at 60fps for the "unbound" state, which a per-frame ctx.arc() loop structurally
 * cannot do. The idle/listening/speaking states are tuned to reproduce that old sphere's exact
 * feel (same speed/pulse/breathe formulas, ported directly) — this is an evolution of the same
 * visual identity, not a redesign.
 *
 * Architecture: one Points BufferGeometry holds every particle's "home" position (a fibonacci
 * sphere, exactly like before) plus a random per-particle seed/phase used to compute two other
 * candidate positions in the vertex shader — a "thinking" swirl and a fully "unbound" free-drift
 * — and blends between home/swirl/free via two uniforms (uThinking, uUnbound) that this engine
 * eases toward a target every frame. That blend IS the explosion/reconstruction: animating
 * uUnbound 0→1 pulls every particle from its sphere position out to its free position along a
 * continuous path (with an ease-out-back overshoot for a real "impulse" feel), and 1→0 pulls it
 * back — no separate "explosion animation" needs to be authored by hand.
 */

export type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'connecting' | 'error' | 'unbound'

const VERTEX_SHADER = /* glsl */ `
  attribute vec3 aSeed;
  attribute float aPhase;

  uniform float uTime;
  uniform float uRadius;
  uniform float uBreathe;
  uniform float uRotation;
  uniform float uTilt;
  uniform float uThinking;
  uniform float uUnbound;
  uniform float uSpread;
  uniform float uPixelRatio;
  uniform float uBaseSize;
  uniform float uAudioLevel;

  varying float vDepth;
  varying float vTwinkle;
  varying float vFree;

  vec3 rotateY(vec3 p, float a) {
    float s = sin(a), c = cos(a);
    return vec3(p.x * c + p.z * s, p.y, -p.x * s + p.z * c);
  }

  vec3 rotateX(vec3 p, float a) {
    float s = sin(a), c = cos(a);
    return vec3(p.x, p.y * c - p.z * s, p.y * s + p.z * c);
  }

  void main() {
    // "Home": the same fibonacci sphere + single-axis rotation + fixed tilt as the original
    // Canvas2D sphere, so idle/listening/speaking look identical to before.
    vec3 home = rotateX(rotateY(position, uRotation), uTilt) * uRadius * uBreathe;

    // "Swirl": a secondary orbital layer around the sphere — visually distinct peeling/arcing
    // motion for the THINKING state, using the same home direction but a faster, phase-shifted
    // second rotation and a radius that breathes further out than the base sphere.
    float swirlAngle = uRotation * 2.4 + aPhase * 6.2831853;
    vec3 swirlDir = normalize(rotateX(rotateY(position, swirlAngle), uTilt + aSeed.z * 0.6));
    float swirlRadius = uRadius * (1.15 + 0.5 * aSeed.x) * uBreathe;
    vec3 swirl = swirlDir * swirlRadius;

    // "Free": fully unbound — each particle drifts/orbits around its own point scattered across
    // the available space, driven entirely by its random seed so the field reads as coordinated
    // (every particle has a stable "home turf" in unbound space) rather than jittering randomly.
    vec3 seedDir = normalize(aSeed * 2.0 - 1.0);
    float orbitAngle = uTime * (0.08 + aSeed.y * 0.18) + aPhase * 6.2831853;
    vec3 orbit = vec3(cos(orbitAngle), sin(orbitAngle * 0.7), sin(orbitAngle)) * (0.12 + aSeed.z * 0.18);
    vec3 free = (seedDir * (0.35 + aSeed.x * 0.65) + orbit) * uSpread;

    float thinking = clamp(uThinking, 0.0, 1.0);
    float unbound = clamp(uUnbound, 0.0, 1.0);
    vec3 pos = mix(home, swirl, thinking);
    pos = mix(pos, free, unbound);

    vFree = max(thinking, unbound);
    vTwinkle = aSeed.x;

    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    // Depth-based size falloff (perspective) plus a bit of levitation from real audio amplitude —
    // a real amplitude-driven visual, not volume-mapped-to-rotation-speed alone.
    float sizeAudio = 1.0 + uAudioLevel * 0.6;
    // Calibrated against this engine's actual camera distance/sphere radius (confirmed visually —
    // the original constant here was copied from an unrelated scale and made every point ~500px
    // wide, blowing the whole additive-blended field out to solid white).
    gl_PointSize = uBaseSize * uPixelRatio * sizeAudio * (4.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
    vDepth = clamp((-mvPosition.z - uRadius) / (uRadius * 2.5), 0.0, 1.0);
  }
`

const FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  varying float vDepth;
  varying float vTwinkle;
  varying float vFree;

  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float d = length(uv);
    if (d > 0.5) discard;
    float core = smoothstep(0.5, 0.0, d);
    float glow = smoothstep(0.5, 0.15, d) * 0.6;
    float twinkle = 0.75 + 0.25 * sin(uTime * (1.5 + vTwinkle * 3.0) + vTwinkle * 20.0);
    // Free-floating particles read as slightly dimmer/more atmospheric than the tight contained
    // sphere, per the request that the unbound field feel coordinated but not overwhelming.
    float freyDim = mix(1.0, 0.72, vFree);
    float brightness = (0.35 + vDepth * 0.65) * twinkle * freyDim;
    float alpha = (core + glow) * brightness;
    gl_FragColor = vec4(uColor, alpha);
  }
`

function fibonacciSpherePoints(count: number): Float32Array {
  const arr = new Float32Array(count * 3)
  const offset = 2 / count
  const increment = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < count; i++) {
    const y = i * offset - 1 + offset / 2
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const phi = i * increment
    arr[i * 3] = Math.cos(phi) * r
    arr[i * 3 + 1] = y
    arr[i * 3 + 2] = Math.sin(phi) * r
  }
  return arr
}

export interface ParticleOrbOptions {
  pointCount?: number
  color?: string // "r,g,b" 0-255 triplet, matching ParticleSphere's existing prop convention
}

// One eased value per orb, animated toward a target every frame rather than snapping — this is
// what makes every state change (including the explosion/reconstruction) a real transition
// instead of a cut. Explode/settle rates differ deliberately: exploding outward reads as punchier
// with a fast rise and a small overshoot; reconstructing reads calmer with a slightly slower,
// no-overshoot ease, matching "the reverse animation should be equally impressive" without being
// identical in character to the explosion.
class Eased {
  value = 0
  target = 0
  private velocity = 0

  set(target: number): void {
    this.target = target
  }

  update(dt: number, riseRate: number, fallRate: number, overshoot: number): void {
    const rate = this.target > this.value ? riseRate : fallRate
    // Critically-damped-ish spring with a touch of overshoot on the rising edge only — cheap and
    // stable, no physics engine needed for a single scalar.
    const k = 1 - Math.exp(-rate * dt)
    const diff = this.target - this.value
    this.velocity = diff * k
    this.value += this.velocity
    if (overshoot > 0 && this.target > 0.001 && this.value > this.target * 0.85 && this.value < this.target) {
      this.value += (this.target - this.value) * overshoot * k
    }
  }
}

export class ParticleOrbEngine {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private material: THREE.ShaderMaterial
  private points: THREE.Points
  private raf = 0
  private lastT = performance.now()
  private disposed = false

  private state: OrbState = 'idle'
  private audioLevel = 0
  private smoothedLevel = 0
  private rotation = 0
  private pulsePhase = 0

  private thinking = new Eased()
  private unbound = new Eased()

  constructor(container: HTMLElement, opts: ParticleOrbOptions = {}) {
    const pointCount = opts.pointCount ?? 900
    const width = container.clientWidth || 360
    const height = container.clientHeight || 360

    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.setSize(width, height)
    this.renderer.domElement.style.display = 'block'
    container.appendChild(this.renderer.domElement)

    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100)
    this.camera.position.z = 4.2

    const home = fibonacciSpherePoints(pointCount)
    const seeds = new Float32Array(pointCount * 3)
    const phases = new Float32Array(pointCount)
    for (let i = 0; i < pointCount; i++) {
      seeds[i * 3] = Math.random()
      seeds[i * 3 + 1] = Math.random()
      seeds[i * 3 + 2] = Math.random()
      phases[i] = Math.random()
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(home, 3))
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3))
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1))

    const [r, g, b] = (opts.color ?? '212,175,55').split(',').map((n) => Number(n) / 255)

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      // Three.js auto-injects its own "precision <p> float;" line into each shader stage based
      // on this setting (rather than respecting one written by hand inside the shader source,
      // confirmed live — a manual `precision highp float;` line in the shader string did NOT
      // stop the mismatch). Left unset, it can pick different defaults per stage for the SAME
      // uniform (uTime), which WebGL rejects outright. Forcing both stages to the same value here
      // is what actually fixes it.
      precision: 'highp',
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uRadius: { value: 1.35 },
        uBreathe: { value: 1 },
        uRotation: { value: 0 },
        uTilt: { value: 0.5 },
        uThinking: { value: 0 },
        uUnbound: { value: 0 },
        uSpread: { value: 3.2 },
        uPixelRatio: { value: this.renderer.getPixelRatio() },
        uBaseSize: { value: 5.5 },
        uAudioLevel: { value: 0 },
        uColor: { value: new THREE.Color(r, g, b) }
      }
    })

    this.points = new THREE.Points(geometry, this.material)
    this.scene.add(this.points)

    this.loop = this.loop.bind(this)
    this.raf = requestAnimationFrame(this.loop)
  }

  setState(state: OrbState): void {
    this.state = state
    this.thinking.set(state === 'thinking' ? 1 : 0)
    this.unbound.set(state === 'unbound' ? 1 : 0)
  }

  setAudioLevel(level: number): void {
    this.audioLevel = level
  }

  setColor(rgbString: string): void {
    const [r, g, b] = rgbString.split(',').map((n) => Number(n) / 255)
    ;(this.material.uniforms.uColor.value as THREE.Color).setRGB(r, g, b)
  }

  /** Where in 0-1 normalized container space (x right, y down, matching CSS) the unbound field
   *  should treat as "screen center" for now — spread is symmetric around the origin, so this is
   *  a hook for the future attractor system (Action Timeline, targeted UI elements) rather than
   *  something used yet. Kept here so that system has a real integration point already wired. */
  setSpread(spread: number): void {
    this.material.uniforms.uSpread.value = spread
  }

  resize(width: number, height: number): void {
    if (width <= 0 || height <= 0) return
    this.renderer.setSize(width, height)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
  }

  private loop(now: number): void {
    if (this.disposed) return
    const dt = Math.min(0.05, (now - this.lastT) / 1000)
    this.lastT = now

    this.smoothedLevel += (this.audioLevel - this.smoothedLevel) * 0.15
    const s = this.state
    const speedFactor = (s === 'listening' ? 1.6 : s === 'speaking' ? 1.15 : s === 'thinking' ? 1.3 : 0.35) + this.smoothedLevel * 0.8
    this.rotation += 0.55 * dt * speedFactor
    this.pulsePhase += (s === 'speaking' ? 2.2 : s === 'listening' ? 1.3 : 0.4) * dt

    const pulseAmp = (s === 'speaking' ? 0.06 : s === 'listening' ? 0.03 : 0.012) + this.smoothedLevel * 0.14
    const breathe = 1 + Math.sin(this.pulsePhase) * pulseAmp + this.smoothedLevel * 0.05

    this.thinking.update(dt, 2.5, 1.8, 0)
    this.unbound.update(dt, 1.8, 1.1, 0.15)

    const u = this.material.uniforms
    u.uTime.value = now / 1000
    u.uRotation.value = this.rotation
    u.uBreathe.value = breathe
    u.uThinking.value = this.thinking.value
    u.uUnbound.value = this.unbound.value
    u.uAudioLevel.value = this.smoothedLevel

    this.renderer.render(this.scene, this.camera)
    this.raf = requestAnimationFrame(this.loop)
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.points.geometry.dispose()
    this.material.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
