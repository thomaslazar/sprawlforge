import type { Pt } from '../geometry'
import type { ArcologyDesign } from '../types'

export interface DesignShape { outline: Pt[]; polys: Pt[][]; lines: Array<[Pt, Pt]> }

const poly = (c: Pt, n: number, r: number, a0: number): Pt[] =>
  Array.from({ length: n }, (_, i) => ({ x: c.x + r * Math.cos(a0 + (i * 2 * Math.PI) / n), y: c.y + r * Math.sin(a0 + (i * 2 * Math.PI) / n) }))
/** square of half-side h, rotated by angle */
const square = (c: Pt, h: number, angle: number) => poly(c, 4, h * Math.SQRT2, angle + Math.PI / 4)
const rect = (c: Pt, w: number, h: number, angle: number): Pt[] =>
  [[-w, -h], [w, -h], [w, h], [-w, h]].map(([u, v]) => ({
    x: c.x + (u * Math.cos(angle) - v * Math.sin(angle)) / 2, y: c.y + (u * Math.sin(angle) + v * Math.cos(angle)) / 2,
  }))

/** Andrew monotone chain */
export function convexHull(pts: Pt[]): Pt[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y)
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const half = (list: Pt[]) => {
    const h: Pt[] = []
    for (const q of list) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], q) <= 0) h.pop()
      h.push(q)
    }
    return h.slice(0, -1)
  }
  return [...half(p), ...half(p.reverse())]
}

export interface Detail { count: number; twist: number }
/** direction a crescent opens toward: the access side for half/boulevard, else a random side drawn as the twist */
export const openingOf = (angle: number, side: number | undefined, twist: number) => angle + (side ?? twist)

/**
 * Geometry per spec §11.5 and §12.3. ponytail: the ziggurat's outer square is inscribed in the radius-r
 * circle (half-side r/sqrt2), not half-side r, so its corners stay inside the plaza and ring road.
 */
export function designShape(design: ArcologyDesign, c: Pt, r: number, rot: number, detail: Detail, opening = rot): DesignShape {
  const angle = rot + detail.twist
  const n = detail.count
  const ring = (k: number) => poly(c, 8, r * k, angle)
  if (design === 'ziggurat') {
    const h = r / Math.SQRT2
    const inner = Array.from({ length: n - 1 }, (_, i) => square(c, h * (1 - (i + 1) / n), angle))
    const outline = square(c, h, angle)
    return { outline, polys: inner, lines: outline.map((p, i) => [p, inner[n - 2][i]] as [Pt, Pt]) }
  }
  if (design === 'cluster') {
    const rects = Array.from({ length: n }, (_, i) => {
      const a = angle + (i * 2 * Math.PI) / n
      return rect({ x: c.x + 0.55 * r * Math.cos(a), y: c.y + 0.55 * r * Math.sin(a) }, 0.25 * r, 0.45 * r, a)
    })
    const core = poly(c, 8, 0.2 * r, angle)
    return { outline: convexHull([...rects.flat(), ...core]), polys: [...rects, core], lines: [] }
  }
  if (design === 'satellites') {
    const sats = Array.from({ length: n }, (_, i) => {
      const a = angle + (i * 2 * Math.PI) / n
      return { x: c.x + 0.8 * r * Math.cos(a), y: c.y + 0.8 * r * Math.sin(a) }
    })
    const squares = sats.map((s) => square(s, 0.18 * r, angle))
    return { outline: convexHull(squares.flat()), polys: [square(c, 0.5 * r, angle), ...squares], lines: sats.map((s) => [c, s] as [Pt, Pt]) }
  }
  if (design === 'twins') {
    const ctr = [-1, 1].map((k) => ({ x: c.x - k * 0.35 * r * Math.sin(angle), y: c.y + k * 0.35 * r * Math.cos(angle) }))
    const slabs = ctr.map((q) => rect(q, 0.9 * r, 0.3 * r, angle))
    return { outline: convexHull(slabs.flat()), polys: slabs, lines: [[ctr[0], ctr[1]]] }
  }
  if (design === 'crescent') {
    const mid = opening + Math.PI, half = (125 * Math.PI) / 180
    const arc = (k: number, dir: number) => Array.from({ length: 13 }, (_, i) => {
      const a = mid + dir * (-half + (i * 2 * half) / 12)
      return { x: c.x + k * r * Math.cos(a), y: c.y + k * r * Math.sin(a) }
    })
    const band = [...arc(1, 1), ...arc(0.55, 1).reverse()]
    return { outline: convexHull(band), polys: [band, poly(c, 8, 0.2 * r, angle)], lines: [] }
  }
  if (design === 'stack') {
    const polys = [0.7, 0.6, 0.5, 0.4].slice(0, n).map((h, k) => square(c, h * r, angle + (k * Math.PI) / 2 / n))
    return { outline: convexHull(polys.flat()), polys, lines: [] }
  }
  return { outline: ring(1), polys: [ring(0.66), ring(0.33)], lines: [] }
}
