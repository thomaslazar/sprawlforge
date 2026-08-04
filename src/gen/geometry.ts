import type { Rng } from './rng'

export interface Rect { x: number; y: number; w: number; h: number }
export interface Pt { x: number; y: number }

export function insetRect(r: Rect, d: number): Rect | null {
  const w = r.w - 2 * d
  const h = r.h - 2 * d
  if (w <= 0 || h <= 0) return null
  return { x: r.x + d, y: r.y + d, w, h }
}

/** signed area of a ring (positive = counter-clockwise in y-down coords) */
export function ringArea(ring: Pt[]): number {
  let a = 0
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]
    const q = ring[(i + 1) % ring.length]
    a += p.x * q.y - q.x * p.y
  }
  return a / 2
}

/** even-odd point-in-polygon over a list of rings */
export function pointInRings(p: Pt, rings: Pt[][]): boolean {
  let inside = false
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i]
      const b = ring[j]
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
        inside = !inside
    }
  }
  return inside
}

export interface Cut { axis: 'x' | 'y'; strip: Rect }

export interface BspOpts { minCell: number; gap: number; jitter: number; rng: Rng }

export function bspSplit(rect: Rect, opts: BspOpts): { cells: Rect[]; cuts: Cut[] } {
  const cells: Rect[] = []
  const cuts: Cut[] = []
  const recurse = (r: Rect): void => {
    const longer = Math.max(r.w, r.h)
    if (longer < 2 * opts.minCell + opts.gap) {
      cells.push(r)
      return
    }
    // split across the longer side; 'x' axis means a vertical cut line
    const axis: 'x' | 'y' = r.w >= r.h ? 'x' : 'y'
    const side = axis === 'x' ? r.w : r.h
    const frac = 0.5 + (opts.rng.next() * 2 - 1) * opts.jitter
    const at = side * frac
    if (axis === 'x') {
      cuts.push({ axis, strip: { x: r.x + at - opts.gap / 2, y: r.y, w: opts.gap, h: r.h } })
      recurse({ x: r.x, y: r.y, w: at - opts.gap / 2, h: r.h })
      recurse({ x: r.x + at + opts.gap / 2, y: r.y, w: r.w - at - opts.gap / 2, h: r.h })
    } else {
      cuts.push({ axis, strip: { x: r.x, y: r.y + at - opts.gap / 2, w: r.w, h: opts.gap } })
      recurse({ x: r.x, y: r.y, w: r.w, h: at - opts.gap / 2 })
      recurse({ x: r.x, y: r.y + at + opts.gap / 2, w: r.w, h: r.h - at - opts.gap / 2 })
    }
  }
  recurse(rect)
  return { cells, cuts }
}
