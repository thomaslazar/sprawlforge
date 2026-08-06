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

export function polylineLength(pts: Pt[]): number {
  let len = 0
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  return len
}

/** point at fraction t (by arc length) along a polyline */
export function pointAtT(pts: Pt[], t: number): Pt {
  const total = polylineLength(pts)
  let target = Math.max(0, Math.min(1, t)) * total
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
    if (target <= seg || i === pts.length - 1) {
      const f = seg === 0 ? 0 : target / seg
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f }
    }
    target -= seg
  }
  return pts[pts.length - 1]
}

/** sub-polyline between arc-length fractions t0 < t1, interior vertices kept */
export function slicePolyline(pts: Pt[], t0: number, t1: number): Pt[] {
  const total = polylineLength(pts)
  const out: Pt[] = [pointAtT(pts, t0)]
  let acc = 0
  for (let i = 1; i < pts.length - 1; i++) {
    acc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
    const t = acc / total
    if (t > t0 && t < t1) out.push(pts[i])
  }
  out.push(pointAtT(pts, t1))
  return out
}

export function rotatePt(p: Pt, theta: number, c: Pt): Pt {
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  const dx = p.x - c.x
  const dy = p.y - c.y
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos }
}

export function bboxOf(pts: Pt[]): Rect {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/**
 * shoelace centroid — always inside a simple polygon; vertex mean for degenerate rings.
 *
 * rect center can land in water for a shore-clipped footprint (the rect is
 * the pre-clip bounding box); the footprint centroid always sits on the
 * actual (clipped) shape, so anchor there instead. The plain vertex mean
 * isn't that centroid — a shore clip can leave an L- or wedge-shaped
 * (concave) footprint whose vertex-mean sits outside the shape entirely
 * (e.g. in the water it was clipped away from). The shoelace-weighted
 * polygon centroid always lands inside a simple polygon, concave or not.
 */
export function ringCentroid(pts: Pt[]): Pt {
  let area = 0, cx = 0, cy = 0
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    const cross = a.x * b.y - b.x * a.y
    area += cross
    cx += (a.x + b.x) * cross
    cy += (a.y + b.y) * cross
  }
  if (Math.abs(area) < 1e-9) {
    return {
      x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
      y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
    }
  }
  return { x: cx / (3 * area), y: cy / (3 * area) }
}
