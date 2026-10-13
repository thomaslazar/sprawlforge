import { polylineLength, type Pt } from '../geometry'
import { RING_ID_PREFIX } from '../landmarks/place'
import type { Road } from '../types'
import { FRONTAGE_ID_PREFIX, type RoadIndex } from './trace'

const STEP = 5

export interface Sample { q: Pt; arc: number; head: number; tail: number; hits: Map<string, { at: Pt; d: number; side: number }> }

export interface CloseRun { id: string; a: number; b: number; arc: number; crosses: boolean }

/**
 * Every run of consecutive 5 m samples of `pts` that stay within `near` m of one other road (highways and ramps
 * excluded), with its arc length and whether the street crosses that road inside the run (samples on both sides: a
 * junction, not a double; a touch at the start is not a crossing). Shared by the weld and the doubled-streets test.
 */
export function closeRuns(pts: Pt[], index: RoadIndex, near: number, selfId: string): { s: Sample[]; runs: CloseRun[] } {
  const s: Sample[] = []
  let done = 0
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]
    const seg = Math.hypot(b.x - a.x, b.y - a.y)
    const n = Math.max(1, Math.ceil(seg / STEP))
    for (let k = i === 1 ? 0 : 1; k <= n; k++) {
      const q = { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n }
      // head = points kept before the sample, tail = first point kept after it
      s.push({ q, arc: done + (seg * k) / n, head: i, tail: k === n ? i + 1 : i, hits: new Map() })
    }
    done += seg
  }
  // every road within `near` of a sample counts, not just the nearest: a chain end resting on a third road must not break a run
  const ids = new Set<string>()
  for (const m of s) {
    index.forEachInRadius(m.q, near, (seg, at, d) => {
      if (seg.id === selfId || seg.cls === 'highway' || seg.cls === 'ramp') return
      const prev = m.hits.get(seg.id)
      if (!prev || d < prev.d) m.hits.set(seg.id, { at, d, side: (seg.b.x - seg.a.x) * (m.q.y - at.y) - (seg.b.y - seg.a.y) * (m.q.x - at.x) })
      ids.add(seg.id)
    })
  }
  const runs: CloseRun[] = []
  for (const id of ids) {
    for (let a = 0; a < s.length;) {
      if (!s[a].hits.has(id)) { a++; continue }
      let b = a
      while (b + 1 < s.length && s[b + 1].hits.has(id)) b++
      const sides = s.slice(a, b + 1).map((m) => m.hits.get(id)!).filter((h) => h.d > 0.5).map((h) => Math.sign(h.side))
      runs.push({ id, a, b, arc: s[b].arc - s[a].arc, crosses: sides.includes(1) && sides.includes(-1) })
      a = b + 1
    }
  }
  return { s, runs }
}

/** cut `pts` once at its first long run beside another road; null when no run is long enough */
function cutOnce(r: Road, index: RoadIndex, near: number, run: number): Pt[] | null {
  const pts = r.points
  const { s, runs } = closeRuns(pts, index, near, r.id)
  // the run that starts earliest and is long enough
  let best: CloseRun | null = null
  for (const c of runs) if (c.arc > run && !c.crosses && (!best || c.a < best.a)) best = c
  if (best) {
    const { id, a, b } = best
    // a run from the street's own start: the part after it is kept
    if (a === 0) return [s[b].hits.get(id)!.at, ...pts.slice(s[b].tail)]
    return [...pts.slice(0, s[a].head), s[a].hits.get(id)!.at]
  }
  return null
}

/**
 * A street that runs beside another road (within `near` m of the same road over more than `run` m) is cut at the
 * run's first sample, welded onto that road; a run from the street's own start keeps the part after it instead.
 * Highways and ramps are never a target (a street does not end on a ramp). Frontage and ring roads are never cut. A remainder under `minLength` is dropped. `index` holds every road and
 * follows the cuts. ponytail: a run in the middle keeps only the part before it; the final street prune handles the rest.
 */
export function weldConverging(streets: Road[], index: RoadIndex, opts: { near?: number; run?: number; minLength?: number } = {}): Road[] {
  const { near = 8, run = 20, minLength = 60 } = opts
  const out: Road[] = []
  for (const r of streets) {
    if (r.id.startsWith(FRONTAGE_ID_PREFIX) || r.id.startsWith(RING_ID_PREFIX)) { out.push(r); continue }
    let cur = r
    let changed = false
    for (let pass = 0; pass < 4; pass++) {
      const pts = cur.points.length >= 2 ? cutOnce(cur, index, near, run) : null
      if (!pts) break
      cur = { ...cur, points: pts }
      changed = true
    }
    if (!changed) { out.push(r); continue }
    index.remove(r.id)
    if (polylineLength(cur.points) < minLength) continue
    index.add(cur.id, cur.points, cur.class)
    out.push(cur)
  }
  return out
}

/**
 * A short street whose two ends rest on the same road (chord under `chord` m, length under `maxLength` m) is a hook
 * back onto it: dropped. A long crescent on one road, or a street between two roads, stays.
 */
export function dropStreetHairpins(streets: Road[], index: RoadIndex, chord = 40, maxLength = 80): Road[] {
  return streets.filter((r) => {
    if (r.id.startsWith(FRONTAGE_ID_PREFIX) || r.points.length < 2) return true
    const a = r.points[0], b = r.points[r.points.length - 1]
    const ha = index.nearestMatching(a, 6, (h) => h.id !== r.id), hb = index.nearestMatching(b, 6, (h) => h.id !== r.id)
    const hook = ha && hb && ha.id === hb.id && Math.hypot(a.x - b.x, a.y - b.y) < chord && polylineLength(r.points) < maxLength
    if (hook) index.remove(r.id)
    return !hook
  })
}
