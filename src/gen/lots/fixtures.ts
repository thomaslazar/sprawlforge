import { expect } from 'vitest'
import { COMPOSITES, makeComposite } from './composites'
import { mulberry32 } from '../rng'
// test helpers for the lot pass (not production code)
import { boxOf, pointInRings, ringArea, type Pt } from '../geometry'
import { intersection } from '../clip'
import type { Terrain } from '../types'
import { distToPolyline } from '../terrain/rivers'

export const rectPoly = (x: number, y: number, w: number, h: number): Pt[] => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
]

export const dryTerrain: Terrain = {
  landform: 'inland', river: false, lakes: false, islands: false, metroSeed: 0,
  water: [],
  land: [[[[0, 0], [4000, 0], [4000, 4000], [0, 4000]]]],
  riverSlice: null,
}

export const circleRing = (c: Pt, r: number, n: number): Pt[] =>
  Array.from({ length: n }, (_, i) => ({ x: c.x + r * Math.cos((2 * Math.PI * i) / n), y: c.y + r * Math.sin((2 * Math.PI * i) / n) }))

export const distToRing = (p: Pt, ring: Pt[]): number => distToPolyline(p, [...ring, ring[0]])

export const expectBox = (ring: Pt[], box: { x0: number; y0: number; x1: number; y1: number }, tol: number): void => {
  const xs = ring.map((p) => p.x), ys = ring.map((p) => p.y)
  expect(Math.abs(Math.min(...xs) - box.x0)).toBeLessThanOrEqual(tol)
  expect(Math.abs(Math.min(...ys) - box.y0)).toBeLessThanOrEqual(tol)
  expect(Math.abs(Math.max(...xs) - box.x1)).toBeLessThanOrEqual(tol)
  expect(Math.abs(Math.max(...ys) - box.y1)).toBeLessThanOrEqual(tol)
}

/** circular-arc points from a to b (both included) with total angle `degrees`, bulging to the left of a -> b ('inward' for a counter-clockwise lot) */
export const arc = (a: Pt, b: Pt, degrees: number, n: number, _side: 'inward'): Pt[] => {
  const th = (degrees * Math.PI) / 180, L = Math.hypot(b.x - a.x, b.y - a.y), r = L / 2 / Math.sin(th / 2)
  const u = { x: (b.x - a.x) / L, y: (b.y - a.y) / L }, nrm = { x: -u.y, y: u.x }
  const c = { x: (a.x + b.x) / 2 + nrm.x * (r * Math.cos(th / 2) * -1), y: (a.y + b.y) / 2 + nrm.y * (r * Math.cos(th / 2) * -1) }
  return Array.from({ length: n }, (_, i) => {
    const f = -th / 2 + (th * i) / (n - 1)
    return { x: c.x + r * (Math.sin(f) * u.x + Math.cos(f) * nrm.x), y: c.y + r * (Math.sin(f) * u.y + Math.cos(f) * nrm.y) }
  })
}

export const insideOrOn = (p: Pt, ring: Pt[], tol: number): boolean => pointInRings(p, [ring]) || distToRing(p, ring) <= tol

/** w x h L with a bite x bite notch at the top right corner, counter-clockwise */
export const lShape = (w: number, h: number, bite: number): Pt[] => [
  { x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h - bite }, { x: w - bite, y: h - bite }, { x: w - bite, y: h }, { x: 0, y: h },
]

/** n points of a circular arc around c, from angle 0 to `degrees` (counter-clockwise, bulging away from c) */
export const arcSide = (c: Pt, r: number, degrees: number, n: number): Pt[] =>
  Array.from({ length: n }, (_, i) => {
    const a = (degrees * Math.PI / 180 * i) / (n - 1)
    return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) }
  })

/** largest intersection area over all pairs of polygons */
export const pairOverlapMax = (polys: Pt[][]): number => {
  const boxes = polys.map(boxOf)
  let max = 0
  for (let i = 0; i < polys.length; i++) for (let j = i + 1; j < polys.length; j++) {
    const a = boxes[i], b = boxes[j]
    if (a.x0 >= b.x1 || b.x0 >= a.x1 || a.y0 >= b.y1 || b.y0 >= a.y1) continue
    const ring = (p: Pt[]) => p.map((q) => [q.x, q.y] as [number, number])
    const area = intersection([ring(polys[i])], [ring(polys[j])]).reduce((s, poly) => s + Math.abs(ringArea(poly[0].slice(0, -1).map(([x, y]) => ({ x, y })))), 0)
    max = Math.max(max, area)
  }
  return max
}

/** length of a lot's chord */
export const frontage = (lot: { chord: [Pt, Pt] }): number => Math.hypot(lot.chord[1].x - lot.chord[0].x, lot.chord[1].y - lot.chord[0].y)

/** interior angles in degrees (ring in either orientation) */
export const interiorAngles = (ring: Pt[]): number[] => {
  const s = ringArea(ring) >= 0 ? 1 : -1, n = ring.length
  return ring.map((p, i) => {
    const a = ring[(i + n - 1) % n], b = ring[(i + 1) % n]
    const turn = Math.atan2((p.x - a.x) * (b.y - p.y) - (p.y - a.y) * (b.x - p.x), (p.x - a.x) * (b.x - p.x) + (p.y - a.y) * (b.y - p.y))
    return 180 - (s * turn * 180) / Math.PI
  })
}

/** shortest edge whose end vertices are not both arc points (turning <= 15.5 degrees) */
export const minNonArcEdge = (ring: Pt[]): number => {
  const n = ring.length
  const arcPt = interiorAngles(ring).map((a) => Math.abs(180 - a) <= 15.5)
  let m = Infinity
  for (let i = 0; i < n; i++) if (!(arcPt[i] && arcPt[(i + 1) % n])) m = Math.min(m, Math.hypot(ring[(i + 1) % n].x - ring[i].x, ring[(i + 1) % n].y - ring[i].y))
  return m
}

/** R7 corner lot quad (corner, projection, inner point, projection) for interior angle theta, depth D 16 */
export const cornerQuad = (thetaDeg: number, D = 16): Pt[] => {
  const th = (thetaDeg * Math.PI) / 180, t = D / Math.tan(th / 2), m = D / Math.sin(th / 2)
  return [{ x: 0, y: 0 }, { x: t, y: 0 }, { x: m * Math.cos(th / 2), y: m * Math.sin(th / 2) }, { x: t * Math.cos(th), y: t * Math.sin(th) }]
}
export const q90 = cornerQuad(90), q65 = cornerQuad(65), q40 = cornerQuad(40)

/** angle is 90 or 270 degrees within 1 */
export const near90or270 = (a: number): boolean => Math.min(Math.abs(a - 90), Math.abs(a - 270)) <= 1

/** first composite with this id on a 60 x 40 box (seeds 0..999), failing loudly when none comes up */
export const firstWith = (id: keyof typeof COMPOSITES) => {
  const c = COMPOSITES[id], box = { origin: { x: 0, y: 0 }, angle: 0, w: 60, d: 40 }
  for (let s = 0; s < 1000; s++) {
    const r = makeComposite(box, c.zones[0], c.density[0], false, mulberry32(s))
    if (r && r.shape === id) return r
  }
  throw new Error(`no ${id} composite within 1000 seeds`)
}

/** every vertex of inner lies inside outer or within tol of its edge */
export const insideRing = (inner: Pt[], outer: Pt[], tol: number): boolean => inner.every((p) => insideOrOn(p, outer, tol))
