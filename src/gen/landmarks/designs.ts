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

/**
 * Geometry per spec §11.5. ponytail: the ziggurat's outer square is inscribed in the radius-r
 * circle (half-side r/sqrt2), not half-side r, so its corners stay inside the plaza and ring road.
 */
export function designShape(design: ArcologyDesign, c: Pt, r: number, angle: number): DesignShape {
  const ring = (k: number) => poly(c, 8, r * k, angle)
  if (design === 'ziggurat') {
    const h = r / Math.SQRT2
    const inner = [0.75, 0.5, 0.25].map((k) => square(c, h * k, angle))
    const outline = square(c, h, angle)
    return { outline, polys: inner, lines: outline.map((p, i) => [p, inner[2][i]] as [Pt, Pt]) }
  }
  if (design === 'cluster') {
    const rects = Array.from({ length: 6 }, (_, i) => {
      const a = angle + (i * Math.PI) / 3
      return rect({ x: c.x + 0.55 * r * Math.cos(a), y: c.y + 0.55 * r * Math.sin(a) }, 0.25 * r, 0.45 * r, a)
    })
    const core = poly(c, 8, 0.2 * r, angle)
    return { outline: convexHull([...rects.flat(), ...core]), polys: [...rects, core], lines: [] }
  }
  if (design === 'satellites') {
    const sats = Array.from({ length: 5 }, (_, i) => {
      const a = angle + (i * 2 * Math.PI) / 5
      return { x: c.x + 0.8 * r * Math.cos(a), y: c.y + 0.8 * r * Math.sin(a) }
    })
    const squares = sats.map((s) => square(s, 0.18 * r, angle))
    return { outline: convexHull(squares.flat()), polys: [square(c, 0.5 * r, angle), ...squares], lines: sats.map((s) => [c, s] as [Pt, Pt]) }
  }
  return { outline: ring(1), polys: [ring(0.66), ring(0.33)], lines: [] }
}
