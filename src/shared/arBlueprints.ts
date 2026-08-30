import type { ArBlueprint } from './types'

// Hand-authored presets for common objects — these use the exact same ArBlueprint shape an
// AI-generated blueprint does (see look_and_place_object in geminiLive.ts), so they're just
// content, not a special code path. Shared between main (to resolve a named spawn_ar_object call
// and to validate/fall back an AI-generated one) and the renderer (to actually build the THREE
// scene in spatialEngine.ts) — neither side owns these.
const MICROWAVE_BLUEPRINT: ArBlueprint = {
  name: 'microwave',
  parts: [
    { id: 'body', shape: 'box', size: [1.6, 1, 1.1], position: [0, 0, 0], color: '#1c1a16', role: 'body', metalness: 0.6, roughness: 0.35 },
    { id: 'door', shape: 'box', size: [1.15, 0.82, 0.05], position: [-0.64, 0, 0.56], hingeOffset: [0.58, 0, 0], color: '#0a0908', role: 'door', roughness: 0.1 },
    // Sticks out a full 0.22 units in Z (versus the door's 0.05 thickness) so it's unmistakably a
    // separate, grabbable protrusion rather than flush with the glass — direct feedback was that
    // the old handle was invisible/impossible to find and grab.
    { id: 'handle', shape: 'box', size: [0.06, 0.55, 0.22], position: [1.08, 0, 0.14], parentId: 'door', color: '#d4af37', role: 'handle', metalness: 0.85, roughness: 0.2 },
    { id: 'panel', shape: 'box', size: [0.28, 0.9, 0.04], position: [0.66, 0, 0.57], color: '#1c1a16', role: 'static', metalness: 0.6, roughness: 0.35 },
    { id: 'button1', shape: 'cylinder', size: [0.06, 0.06, 0.04], position: [0.66, 0.28, 0.6], rotation: [Math.PI / 2, 0, 0], color: '#e05a5a', role: 'button', metalness: 0.4, roughness: 0.4 },
    { id: 'button2', shape: 'cylinder', size: [0.06, 0.06, 0.04], position: [0.66, 0, 0.6], rotation: [Math.PI / 2, 0, 0], color: '#6fe08a', role: 'button', metalness: 0.4, roughness: 0.4 },
    { id: 'button3', shape: 'cylinder', size: [0.06, 0.06, 0.04], position: [0.66, -0.28, 0.6], rotation: [Math.PI / 2, 0, 0], color: '#d4af37', role: 'button', metalness: 0.4, roughness: 0.4 },
    { id: 'turntable', shape: 'cylinder', size: [0.42, 0.42, 0.02], position: [0.15, -0.35, 0.4], rotation: [Math.PI / 2, 0, 0], color: '#3a3630', role: 'static', metalness: 0.3, roughness: 0.5 }
  ]
}

const LAMP_BLUEPRINT: ArBlueprint = {
  name: 'lamp',
  parts: [
    { id: 'base', shape: 'cylinder', size: [0.32, 0.36, 0.08], position: [0, -0.55, 0], color: '#2b2620', role: 'body', metalness: 0.5, roughness: 0.4 },
    { id: 'pole', shape: 'cylinder', size: [0.03, 0.03, 0.9], position: [0, 0, 0], color: '#d4af37', role: 'static', metalness: 0.8, roughness: 0.25 },
    { id: 'shade', shape: 'cylinder', size: [0.42, 0.28, 0.5], position: [0, 0.7, 0], color: '#f2e6c8', role: 'static', roughness: 0.6 },
    { id: 'switch', shape: 'cylinder', size: [0.045, 0.045, 0.05], position: [0.15, -0.48, 0.28], rotation: [Math.PI / 2, 0, 0], color: '#6fe08a', role: 'button', metalness: 0.5, roughness: 0.3 }
  ]
}

const CHAIR_BLUEPRINT: ArBlueprint = {
  name: 'chair',
  parts: [
    { id: 'seat', shape: 'box', size: [0.9, 0.08, 0.9], position: [0, 0, 0], color: '#5c4632', role: 'body', roughness: 0.6 },
    { id: 'back', shape: 'box', size: [0.9, 0.9, 0.08], position: [0, 0.49, -0.41], color: '#5c4632', role: 'static', roughness: 0.6 },
    { id: 'leg1', shape: 'cylinder', size: [0.04, 0.04, 0.85], position: [-0.38, -0.46, -0.38], color: '#2b2118', role: 'static', metalness: 0.3, roughness: 0.5 },
    { id: 'leg2', shape: 'cylinder', size: [0.04, 0.04, 0.85], position: [0.38, -0.46, -0.38], color: '#2b2118', role: 'static', metalness: 0.3, roughness: 0.5 },
    { id: 'leg3', shape: 'cylinder', size: [0.04, 0.04, 0.85], position: [-0.38, -0.46, 0.38], color: '#2b2118', role: 'static', metalness: 0.3, roughness: 0.5 },
    { id: 'leg4', shape: 'cylinder', size: [0.04, 0.04, 0.85], position: [0.38, -0.46, 0.38], color: '#2b2118', role: 'static', metalness: 0.3, roughness: 0.5 }
  ]
}

// Simple, everyday objects — real feedback was that letting the AI freely guess geometry for
// something this ordinary ("a spoon") produced something unrecognizable. A curated library that
// look_and_place_object checks FIRST (see resolveBlueprintName below) means the common case is a
// reliable, hand-tuned shape instead of a fresh guess every time; free generation is now only for
// objects that genuinely aren't in here.
const SPOON_BLUEPRINT: ArBlueprint = {
  name: 'spoon',
  parts: [
    { id: 'handle', shape: 'cylinder', size: [0.045, 0.055, 0.85], position: [0, -0.15, 0], color: '#c9c9c9', role: 'body', metalness: 0.85, roughness: 0.25 },
    { id: 'neck', shape: 'cylinder', size: [0.055, 0.075, 0.15], position: [0, 0.35, 0], color: '#c9c9c9', role: 'static', metalness: 0.85, roughness: 0.25 },
    // A flattened ellipsoid (thin in Z, oval in XY) is what actually makes this read as a spoon's
    // bowl instead of a ball stuck on a stick — see applyShapeScale in spatialEngine.ts.
    { id: 'bowl', shape: 'sphere', size: [0.16, 0.22, 0.045], position: [0, 0.58, 0], color: '#d4d4d4', role: 'static', metalness: 0.85, roughness: 0.2 }
  ]
}

const FORK_BLUEPRINT: ArBlueprint = {
  name: 'fork',
  parts: [
    { id: 'handle', shape: 'cylinder', size: [0.045, 0.055, 0.85], position: [0, -0.15, 0], color: '#c9c9c9', role: 'body', metalness: 0.85, roughness: 0.25 },
    { id: 'head', shape: 'box', size: [0.22, 0.28, 0.03], position: [0, 0.42, 0], color: '#c9c9c9', role: 'static', metalness: 0.85, roughness: 0.2 },
    { id: 'tine1', shape: 'box', size: [0.035, 0.22, 0.03], position: [-0.082, 0.62, 0], color: '#c9c9c9', role: 'static', metalness: 0.85, roughness: 0.2 },
    { id: 'tine2', shape: 'box', size: [0.035, 0.22, 0.03], position: [-0.028, 0.63, 0], color: '#c9c9c9', role: 'static', metalness: 0.85, roughness: 0.2 },
    { id: 'tine3', shape: 'box', size: [0.035, 0.22, 0.03], position: [0.028, 0.63, 0], color: '#c9c9c9', role: 'static', metalness: 0.85, roughness: 0.2 },
    { id: 'tine4', shape: 'box', size: [0.035, 0.22, 0.03], position: [0.082, 0.62, 0], color: '#c9c9c9', role: 'static', metalness: 0.85, roughness: 0.2 }
  ]
}

const CUP_BLUEPRINT: ArBlueprint = {
  name: 'cup',
  parts: [
    { id: 'body', shape: 'cylinder', size: [0.28, 0.24, 0.55], position: [0, 0, 0], color: '#e8e2d8', role: 'body', roughness: 0.5 },
    { id: 'rim', shape: 'cylinder', size: [0.29, 0.29, 0.02], position: [0, 0.27, 0], color: '#e8e2d8', role: 'static', roughness: 0.4 },
    { id: 'handle', shape: 'box', size: [0.05, 0.28, 0.05], position: [0.32, 0, 0], color: '#e8e2d8', role: 'static', roughness: 0.5 }
  ]
}

const BOTTLE_BLUEPRINT: ArBlueprint = {
  name: 'bottle',
  parts: [
    { id: 'body', shape: 'cylinder', size: [0.22, 0.22, 0.9], position: [0, -0.1, 0], color: '#2f6b4f', role: 'body', roughness: 0.15 },
    { id: 'shoulder', shape: 'cylinder', size: [0.09, 0.22, 0.15], position: [0, 0.42, 0], color: '#2f6b4f', role: 'static', roughness: 0.15 },
    { id: 'neck', shape: 'cylinder', size: [0.07, 0.09, 0.25], position: [0, 0.62, 0], color: '#2f6b4f', role: 'static', roughness: 0.15 },
    { id: 'cap', shape: 'cylinder', size: [0.08, 0.08, 0.08], position: [0, 0.78, 0], color: '#8a1f1f', role: 'static', roughness: 0.4 }
  ]
}

const PHONE_BLUEPRINT: ArBlueprint = {
  name: 'phone',
  parts: [
    { id: 'body', shape: 'box', size: [0.42, 0.85, 0.045], position: [0, 0, 0], color: '#111214', role: 'body', metalness: 0.6, roughness: 0.3 },
    { id: 'screen', shape: 'box', size: [0.38, 0.78, 0.005], position: [0, 0.02, 0.026], color: '#0a2a3a', role: 'static', metalness: 0.2, roughness: 0.1 },
    { id: 'camera_bump', shape: 'cylinder', size: [0.05, 0.05, 0.02], position: [-0.14, 0.35, -0.03], rotation: [Math.PI / 2, 0, 0], color: '#1c1c1c', role: 'static', metalness: 0.7, roughness: 0.3 }
  ]
}

const BOOK_BLUEPRINT: ArBlueprint = {
  name: 'book',
  parts: [
    { id: 'cover', shape: 'box', size: [0.55, 0.7, 0.06], position: [0, 0, 0], color: '#7a2e2e', role: 'body', roughness: 0.7 },
    { id: 'pages', shape: 'box', size: [0.52, 0.66, 0.05], position: [0.01, 0, 0], color: '#f0e8d8', role: 'static', roughness: 0.9 }
  ]
}

const BALL_BLUEPRINT: ArBlueprint = {
  name: 'ball',
  parts: [{ id: 'body', shape: 'sphere', size: [0.4, 0.4, 0.4], position: [0, 0, 0], color: '#d94f3d', role: 'body', roughness: 0.6 }]
}

export const BUILTIN_BLUEPRINTS: Record<string, ArBlueprint> = {
  microwave: MICROWAVE_BLUEPRINT,
  lamp: LAMP_BLUEPRINT,
  chair: CHAIR_BLUEPRINT,
  spoon: SPOON_BLUEPRINT,
  fork: FORK_BLUEPRINT,
  cup: CUP_BLUEPRINT,
  bottle: BOTTLE_BLUEPRINT,
  phone: PHONE_BLUEPRINT,
  book: BOOK_BLUEPRINT,
  ball: BALL_BLUEPRINT
}

/** Fuzzy-matches a detected/requested object name against the curated library — substring either
 *  direction so "a spoon" / "spoon" / "teaspoon" all resolve to the same reliable preset instead
 *  of trusting a fresh AI guess for something this ordinary. Returns null for anything that
 *  genuinely isn't in the library, which is exactly when free generation is worth trusting. */
export function resolveBlueprintName(name: string): ArBlueprint | null {
  const normalized = name.trim().toLowerCase()
  if (!normalized) return null
  if (BUILTIN_BLUEPRINTS[normalized]) return BUILTIN_BLUEPRINTS[normalized]
  for (const [key, blueprint] of Object.entries(BUILTIN_BLUEPRINTS)) {
    if (normalized.includes(key) || key.includes(normalized)) return blueprint
  }
  return null
}

export function boxFallbackBlueprint(name: string): ArBlueprint {
  return { name, parts: [{ id: 'body', shape: 'box', size: [1, 1, 1], position: [0, 0, 0], color: '#d4af37', role: 'body', metalness: 0.4, roughness: 0.5 }] }
}

const MAX_PARTS = 14
const MAX_DIM = 4
const MIN_DIM = 0.01
const VALID_SHAPES = new Set(['box', 'cylinder', 'sphere'])
const VALID_ROLES = new Set(['body', 'handle', 'button', 'door', 'static'])
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

function clampNum(n: unknown, lo: number, hi: number, fallback: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : fallback
  return Math.min(hi, Math.max(lo, v))
}

function sanitizeVec3(v: unknown, dimLo: number, dimHi: number, fallback: [number, number, number]): [number, number, number] {
  if (!Array.isArray(v) || v.length !== 3) return fallback
  return [clampNum(v[0], dimLo, dimHi, fallback[0]), clampNum(v[1], dimLo, dimHi, fallback[1]), clampNum(v[2], dimLo, dimHi, fallback[2])]
}

/**
 * A blueprint from the AI (or any other untrusted source) is arbitrary JSON, not a typed object —
 * this is the one place that turns it into something safe to actually build a THREE scene from:
 * clamped sizes/positions (nothing absurdly huge or a degenerate zero), a capped part count (an
 * unbounded part list is a real perf/memory risk), whitelisted shape/role/color values, and a
 * guaranteed 'body' part to grab. Anything that doesn't even have a parseable part list falls back
 * to a plain box labeled with whatever name was given, so a bad/unexpected model response degrades
 * to "a box appeared" instead of failing outright or rendering something broken.
 */
export function sanitizeBlueprint(raw: unknown, fallbackName: string): ArBlueprint {
  if (!raw || typeof raw !== 'object') return boxFallbackBlueprint(fallbackName)
  const obj = raw as Record<string, unknown>
  const partsRaw = Array.isArray(obj.parts) ? obj.parts.slice(0, MAX_PARTS) : []
  if (partsRaw.length === 0) return boxFallbackBlueprint(fallbackName)

  const seenIds = new Set<string>()
  const parts = partsRaw.map((p, i) => {
    const part = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>
    let id = typeof part.id === 'string' && part.id.trim() ? part.id.trim() : `part_${i}`
    while (seenIds.has(id)) id = `${id}_${i}`
    seenIds.add(id)
    const shape = typeof part.shape === 'string' && VALID_SHAPES.has(part.shape) ? (part.shape as 'box' | 'cylinder' | 'sphere') : 'box'
    const role = typeof part.role === 'string' && VALID_ROLES.has(part.role) ? (part.role as ArBlueprint['parts'][number]['role']) : 'static'
    const color = typeof part.color === 'string' && HEX_COLOR.test(part.color) ? part.color : '#8a8a8a'
    const parentId = typeof part.parentId === 'string' && part.parentId.trim() ? part.parentId.trim() : undefined
    return {
      id,
      shape,
      size: sanitizeVec3(part.size, MIN_DIM, MAX_DIM, [0.3, 0.3, 0.3]),
      position: sanitizeVec3(part.position, -MAX_DIM, MAX_DIM, [0, 0, 0]),
      rotation: part.rotation ? sanitizeVec3(part.rotation, -Math.PI * 2, Math.PI * 2, [0, 0, 0]) : undefined,
      color,
      role,
      parentId,
      hingeOffset: part.hingeOffset ? sanitizeVec3(part.hingeOffset, -MAX_DIM, MAX_DIM, [0, 0, 0]) : undefined,
      metalness: clampNum(part.metalness, 0, 1, 0.3),
      roughness: clampNum(part.roughness, 0, 1, 0.4)
    }
  })

  // parentId must point at a real id in this same blueprint — otherwise buildFromBlueprint's
  // fallback-to-root logic is fine, but drop dangling self-references defensively.
  const validIds = new Set(parts.map((p) => p.id))
  for (const part of parts) {
    if (part.parentId && (!validIds.has(part.parentId) || part.parentId === part.id)) part.parentId = undefined
  }
  if (!parts.some((p) => p.role === 'body')) {
    const first = parts.find((p) => !p.parentId) ?? parts[0]
    first.role = 'body'
  }

  const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim().slice(0, 60) : fallbackName
  return { name, parts }
}
