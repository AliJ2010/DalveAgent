export function hslToHex(h: number, s: number, l: number): string {
  const lFrac = l / 100
  const a = (s * Math.min(lFrac, 1 - lFrac)) / 100
  const f = (n: number): string => {
    const k = (n + h / 30) % 12
    const color = lFrac - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)))
    return Math.round(255 * color)
      .toString(16)
      .padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

/** Converts "#rrggbb" to the "r,g,b" string ParticleSphere expects. */
export function hexToRgbString(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  if ([r, g, b].some(Number.isNaN)) return '212,175,55'
  return `${r},${g},${b}`
}

export function hexToHue(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  if (d === 0) return 42 // default to gold hue when achromatic/unparseable
  let h: number
  switch (max) {
    case r:
      h = ((g - b) / d) % 6
      break
    case g:
      h = (b - r) / d + 2
      break
    default:
      h = (r - g) / d + 4
  }
  h *= 60
  if (h < 0) h += 360
  return h
}
