import { pointInRings, type Pt } from '../geometry'
import { distToPolyline } from '../terrain/rivers'
import type { Road, Terrain } from '../types'

const SAMPLE = 10
const MAX_SPAN: Record<'highway' | 'arterial', number> = { highway: 900, arterial: 450 }
const LANDING = 15
const MIN_STREET_PIECE = 40

export const inWater = (terrain: Terrain, p: Pt): boolean =>
  terrain.water.some((poly) => pointInRings(p, poly.map((ring) => ring.map(([x, y]) => ({ x, y })))))

const at = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })

/**
 * Walk a 2-point segment, returning [t0,t1] water intervals (0..1). Interval
 * bounds always land on a *dry* sample (the last dry step before wet, and
 * the first dry step after) so land pieces built from these bounds never
 * carry a wet endpoint — sampling resolution rounds intervals slightly wide
 * into the water, never short into it.
 */
function waterIntervals(terrain: Terrain, a: Pt, b: Pt): Array<[number, number]> {
  const len = Math.hypot(b.x - a.x, b.y - a.y)
  const steps = Math.max(2, Math.ceil(len / SAMPLE))
  const spans: Array<[number, number]> = []
  let start = -1
  let lastDry = 0
  for (let s = 0; s <= steps; s++) {
    const t = s / steps
    const wet = inWater(terrain, at(a, b, t))
    if (wet) {
      if (start < 0) start = lastDry
    } else {
      if (start >= 0) {
        spans.push([start, t])
        start = -1
      }
      lastDry = t
    }
  }
  if (start >= 0) spans.push([start, 1])
  return spans
}

export function clipRoadsToLand(roads: Road[], terrain: Terrain): Road[] {
  if (terrain.water.length === 0) return roads
  const out: Road[] = []
  for (const road of roads) {
    if (road.class !== 'street') {
      out.push(road)
      continue
    }
    const [a, b] = [road.points[0], road.points[road.points.length - 1]]
    const spans = waterIntervals(terrain, a, b)
    if (spans.length === 0) {
      out.push(road)
      continue
    }
    // land pieces are the complement of the water spans
    let cursor = 0
    let piece = 0
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    for (const [t0, t1] of [...spans, [1, 1] as [number, number]]) {
      if ((t0 - cursor) * len >= MIN_STREET_PIECE) {
        piece += 1
        out.push({ ...road, id: `${road.id}-${piece}`, points: [at(a, b, cursor), at(a, b, t0)] })
      }
      cursor = t1
    }
  }
  return out
}

export function planBridges(roads: Road[], terrain: Terrain): Road[] {
  if (terrain.water.length === 0) return []
  const bridges: Road[] = []
  let n = 0
  for (const road of roads) {
    if (road.class === 'street' || road.bridge) continue
    const [a, b] = [road.points[0], road.points[road.points.length - 1]]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    for (const [t0, t1] of waterIntervals(terrain, a, b)) {
      const span = (t1 - t0) * len
      if (span > MAX_SPAN[road.class as 'highway' | 'arterial']) continue
      const mid = at(a, b, (t0 + t1) / 2)
      let p = at(a, b, t0)
      let q = at(a, b, t1)
      const river = terrain.river
      if (river && distToPolyline(mid, river.course) < 2 * river.width) {
        // re-orient perpendicular to local flow
        let bestI = 0
        let bestD = Infinity
        for (let i = 0; i < river.course.length - 1; i++) {
          const d = distToPolyline(mid, [river.course[i], river.course[i + 1]])
          if (d < bestD) {
            bestD = d
            bestI = i
          }
        }
        const fa = river.course[bestI]
        const fb = river.course[bestI + 1]
        const fl = Math.hypot(fb.x - fa.x, fb.y - fa.y) || 1
        const normal = { x: -(fb.y - fa.y) / fl, y: (fb.x - fa.x) / fl }
        const extend = (dirSign: number): Pt => {
          let pt = { ...mid }
          for (let s = 0; s < 80; s++) {
            const next = { x: pt.x + normal.x * 25 * dirSign, y: pt.y + normal.y * 25 * dirSign }
            pt = next
            if (!inWater(terrain, pt)) break
          }
          // clear the waterline with the same landing margin as the straight case
          return { x: pt.x + normal.x * dirSign * LANDING, y: pt.y + normal.y * dirSign * LANDING }
        }
        p = extend(-1)
        q = extend(1)
      } else {
        // push landings onto land along the road direction
        p = at(a, b, Math.max(0, t0 - LANDING / len))
        q = at(a, b, Math.min(1, t1 + LANDING / len))
      }
      n += 1
      bridges.push({
        id: `BR${String(n).padStart(2, '0')}`,
        class: road.class,
        points: [p, q],
        width: road.width,
        name: null,
        bridge: true,
      })
    }
  }
  return bridges
}
