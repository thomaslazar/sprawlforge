import { pointAtT, polylineLength, type Pt } from '../geometry'
import type { Rng } from '../rng'
import { inWater } from '../sector/bridges'
import { distToPolyline } from '../terrain/rivers'
import type { Road, RoadClass, Terrain } from '../types'
import type { RoadField } from './field'

export interface Seed { at: Pt; dir?: Pt; crossWater?: boolean }

export interface TraceOpts {
  separation: number
  step: number
  maxSteps: number
  minLength: number
  /** 0..1 separation jitter, 0..1 per-1000m decay probability — both 0 for planned */
  jitter: number
  decay: number
  /** radians per step, default π (no clamp) */
  maxTurn?: number
}

export const MAJOR: TraceOpts = { separation: 400, step: 10, maxSteps: 600, minLength: 60, jitter: 0, decay: 0 }
export const MINOR: TraceOpts = { separation: 100, step: 10, maxSteps: 200, minLength: 60, jitter: 0.4, decay: 0.2 }

// highway > arterial > street > ramp
const CLASS_RANK: Record<RoadClass, number> = { highway: 3, arterial: 2, street: 1, ramp: 0 }
// a streamline's own rank is implied by the axis it walks: MAJOR/major traces
// are arterial-grade, MINOR/minor traces are street-grade. Both callers of
// traceStreamline (traceLayer here, the highway tracer in task 5) only ever
// snap against roads already in the index at that pipeline stage — the
// highway is traced before anything is indexed, so its own rank never
// matters — so this is equivalent to threading a `cls` through and shorter.
const ownRankFor = (axis: 'major' | 'minor'): number => CLASS_RANK[axis === 'major' ? 'arterial' : 'street']

const clamp = (lo: number, hi: number, v: number) => Math.max(lo, Math.min(hi, v))

function normalize(v: Pt): Pt {
  const len = Math.hypot(v.x, v.y) || 1
  return { x: v.x / len, y: v.y / len }
}

/** flip v to whichever sign of the (sign-ambiguous) line field is closer to ref */
function towards(v: Pt, ref: Pt): Pt {
  return v.x * ref.x + v.y * ref.y < 0 ? { x: -v.x, y: -v.y } : v
}

function nearestOnSegment(p: Pt, a: Pt, b: Pt): { pt: Pt; d: number } {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const len2 = abx * abx + aby * aby || 1
  const t = clamp(0, 1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2)
  const pt = { x: a.x + t * abx, y: a.y + t * aby }
  return { pt, d: Math.hypot(p.x - pt.x, p.y - pt.y) }
}

interface Seg { id: string; cls: RoadClass; a: Pt; b: Pt }

/** uniform grid hash of road segments; nearest() scans only the cells within radius */
export class RoadIndex {
  private cellSize: number
  private cells = new Map<string, Seg[]>()

  constructor(cellSize: number) {
    this.cellSize = cellSize
  }

  add(id: string, points: Pt[], cls: RoadClass): void {
    for (let i = 1; i < points.length; i++) {
      const seg: Seg = { id, cls, a: points[i - 1], b: points[i] }
      const cx0 = Math.floor(Math.min(seg.a.x, seg.b.x) / this.cellSize)
      const cx1 = Math.floor(Math.max(seg.a.x, seg.b.x) / this.cellSize)
      const cy0 = Math.floor(Math.min(seg.a.y, seg.b.y) / this.cellSize)
      const cy1 = Math.floor(Math.max(seg.a.y, seg.b.y) / this.cellSize)
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          const key = `${cx},${cy}`
          let bucket = this.cells.get(key)
          if (!bucket) { bucket = []; this.cells.set(key, bucket) }
          bucket.push(seg)
        }
      }
    }
  }

  nearest(
    p: Pt, radius: number, filter?: (cls: RoadClass) => boolean,
  ): { id: string; at: Pt; dist: number; segAngle: number } | null {
    const cx0 = Math.floor((p.x - radius) / this.cellSize)
    const cx1 = Math.floor((p.x + radius) / this.cellSize)
    const cy0 = Math.floor((p.y - radius) / this.cellSize)
    const cy1 = Math.floor((p.y + radius) / this.cellSize)
    let best: { id: string; at: Pt; dist: number; segAngle: number } | null = null
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const bucket = this.cells.get(`${cx},${cy}`)
        if (!bucket) continue
        for (const seg of bucket) {
          if (filter && !filter(seg.cls)) continue
          const { pt, d } = nearestOnSegment(p, seg.a, seg.b)
          if (d <= radius && (!best || d < best.dist))
            best = { id: seg.id, at: pt, dist: d, segAngle: Math.atan2(seg.b.y - seg.a.y, seg.b.x - seg.a.x) }
        }
      }
    }
    return best
  }
}

function fieldDirAt(field: RoadField, axis: 'major' | 'minor', p: Pt, ref: Pt): Pt {
  const s = field.sample(p)
  return towards(axis === 'major' ? s.major : s.minor, ref)
}

/** RK4 through the (sign-resolved) direction field; returns a unit direction */
function rk4Dir(field: RoadField, axis: 'major' | 'minor', p: Pt, prevDir: Pt, step: number): Pt {
  const k1 = fieldDirAt(field, axis, p, prevDir)
  const k2 = fieldDirAt(field, axis, { x: p.x + (step / 2) * k1.x, y: p.y + (step / 2) * k1.y }, k1)
  const k3 = fieldDirAt(field, axis, { x: p.x + (step / 2) * k2.x, y: p.y + (step / 2) * k2.y }, k2)
  const k4 = fieldDirAt(field, axis, { x: p.x + step * k3.x, y: p.y + step * k3.y }, k3)
  return normalize({ x: k1.x + 2 * k2.x + 2 * k3.x + k4.x, y: k1.y + 2 * k2.y + 2 * k3.y + k4.y })
}

/** clamp the turn from prevDir to rawDir to at most maxTurn radians */
function clampTurn(prevDir: Pt, rawDir: Pt, maxTurn: number): Pt {
  const prevA = Math.atan2(prevDir.y, prevDir.x)
  const rawA = Math.atan2(rawDir.y, rawDir.x)
  const diff = Math.atan2(Math.sin(rawA - prevA), Math.cos(rawA - prevA))
  const a = prevA + clamp(-maxTurn, maxTurn, diff)
  return { x: Math.cos(a), y: Math.sin(a) }
}

function angleGapLines(a: number, b: number): number {
  let d = Math.abs(a - b) % Math.PI
  if (d > Math.PI / 2) d = Math.PI - d
  return d
}

/** a crossWater seed may wet-cross the river corridor only; sea/lake still stop it */
function inRiverBand(terrain: Terrain, p: Pt, margin: number): boolean {
  const river = terrain.riverSlice
  return !!river && distToPolyline(p, river.course) <= river.width + margin
}

function clampToWindow(p: Pt, sizeM: number): Pt {
  return { x: clamp(0, sizeM, p.x), y: clamp(0, sizeM, p.y) }
}

const PARALLEL_ANGLE = (25 * Math.PI) / 180

function traceHalf(
  field: RoadField, axis: 'major' | 'minor', start: Pt, initDir: Pt,
  terrain: Terrain, sizeM: number, index: RoadIndex, opts: TraceOpts,
  sep: number, rng: Rng, irregularityAt: (p: Pt) => number, crossWater: boolean, sourceId: string | null,
): Pt[] {
  const ownRank = ownRankFor(axis)
  const sameOrHigher = (c: RoadClass) => CLASS_RANK[c] >= ownRank
  const maxTurn = opts.maxTurn ?? Math.PI
  const pts: Pt[] = []
  let p = start
  let dir = initDir
  for (let i = 0; i < opts.maxSteps; i++) {
    const newDir = clampTurn(dir, rk4Dir(field, axis, p, dir, opts.step), maxTurn)
    const next = { x: p.x + newDir.x * opts.step, y: p.y + newDir.y * opts.step }

    if (next.x < 0 || next.x > sizeM || next.y < 0 || next.y > sizeM) {
      pts.push(clampToWindow(next, sizeM))
      break
    }
    if (inWater(terrain, next) && !(crossWater && inRiverBand(terrain, next, opts.step))) break

    // a seed forked off an existing road (e.g. a street seeded ON an
    // arterial) sits at distance ~0 from it; excluding that one specific
    // segment (not a blanket grace window) lets the child immediately
    // leave its parent while every OTHER road is still checked from step 1.
    const hitSame = index.nearest(next, 0.3 * sep, sameOrHigher)
    if (hitSame && hitSame.id !== sourceId) { pts.push(hitSame.at); break }

    const hitPar = index.nearest(next, 0.7 * sep)
    if (hitPar && hitPar.id !== sourceId && angleGapLines(Math.atan2(newDir.y, newDir.x), hitPar.segAngle) < PARALLEL_ANGLE)
      break

    pts.push(next)
    p = next
    dir = newDir

    if (irregularityAt(p) > 0.4 && rng.chance((opts.decay * opts.step) / 1000)) break
  }
  return pts
}

export function traceStreamline(
  field: RoadField, axis: 'major' | 'minor', seed: Seed, terrain: Terrain, sizeM: number,
  index: RoadIndex, opts: TraceOpts, rng: Rng, irregularityAt: (p: Pt) => number,
): Pt[] | null {
  // riverSlice.course (and so riverCrossingSeeds) carries a margin past the
  // window edge (Terrain's own doc comment) — a seed out there would put an
  // out-of-window point straight into the result, breaking window
  // containment. No road for a seed that isn't even on the map.
  if (seed.at.x < 0 || seed.at.x > sizeM || seed.at.y < 0 || seed.at.y > sizeM) return null
  const irr = irregularityAt(seed.at)
  const jitterScale = (Math.max(0, irr - 0.4) / 0.55) * (rng.next() - 0.5) * 2
  const sep = opts.separation * (1 + opts.jitter * jitterScale)
  const crossWater = !!seed.crossWater
  const ownRank = ownRankFor(axis)
  const source = index.nearest(seed.at, 0.3 * sep, (c) => CLASS_RANK[c] >= ownRank)
  const sourceId = source?.id ?? null

  const sample = field.sample(seed.at)
  const initDir = seed.dir ? normalize(seed.dir) : (axis === 'major' ? sample.major : sample.minor)
  const forward = traceHalf(field, axis, seed.at, initDir, terrain, sizeM, index, opts, sep, rng, irregularityAt, crossWater, sourceId)
  const backward = traceHalf(
    field, axis, seed.at, { x: -initDir.x, y: -initDir.y }, terrain, sizeM, index, opts, sep, rng, irregularityAt, crossWater, sourceId,
  )

  const points = [...backward.slice().reverse(), seed.at, ...forward]
  if (polylineLength(points) < opts.minLength) return null
  return points
}

/** jittered lattice at `spacing`, filtered by `accept`, shuffled for lattice-order independence */
export function poissonSeeds(sizeM: number, spacing: number, rng: Rng, accept: (p: Pt) => boolean): Seed[] {
  const seeds: Seed[] = []
  for (let y = spacing / 2; y < sizeM; y += spacing) {
    for (let x = spacing / 2; x < sizeM; x += spacing) {
      const p = { x: x + (rng.next() * 2 - 1) * 0.3 * spacing, y: y + (rng.next() * 2 - 1) * 0.3 * spacing }
      if (accept(p)) seeds.push({ at: p })
    }
  }
  for (let i = seeds.length - 1; i > 0; i--) {
    const j = rng.int(0, i)
    ;[seeds[i], seeds[j]] = [seeds[j], seeds[i]]
  }
  return seeds
}

function tangentAt(points: Pt[], t: number): Pt {
  const len = polylineLength(points)
  const eps = Math.min(1, len * 0.001) || 1
  const a = pointAtT(points, t)
  const b = pointAtT(points, Math.min(1, t + eps / len))
  return normalize({ x: b.x - a.x, y: b.y - a.y })
}

/** seeds every `every` m along a polyline, dir = segment normal, flipping side when alternate */
export function seedsAlong(points: Pt[], every: number, alternate: boolean): Seed[] {
  const len = polylineLength(points)
  const seeds: Seed[] = []
  let flip = false
  for (let dist = every; dist < len; dist += every) {
    const t = dist / len
    const tangent = tangentAt(points, t)
    const normal = { x: -tangent.y, y: tangent.x }
    seeds.push({ at: pointAtT(points, t), dir: flip && alternate ? { x: -normal.x, y: -normal.y } : normal })
    flip = !flip
  }
  return seeds
}

const RIVER_CROSSING_SPACING = 1000
const RIVER_CROSSING_JITTER = 200
const RIVER_CROSSING_MAX_WIDTH = 450

/** seeds mid-river, perpendicular to flow, every ~1000±200m; skipped for a wide river */
export function riverCrossingSeeds(terrain: Terrain, rng: Rng): Seed[] {
  const river = terrain.riverSlice
  if (!river || river.width > RIVER_CROSSING_MAX_WIDTH) return []
  const len = polylineLength(river.course)
  const seeds: Seed[] = []
  let dist = RIVER_CROSSING_SPACING / 2
  while (dist < len) {
    const t = dist / len
    const tangent = tangentAt(river.course, t)
    seeds.push({ at: pointAtT(river.course, t), dir: { x: -tangent.y, y: tangent.x }, crossWater: true })
    dist += RIVER_CROSSING_SPACING + (rng.next() * 2 - 1) * RIVER_CROSSING_JITTER
  }
  return seeds
}

/** trace every seed in order, indexing successes as it goes; caps the queue at 4×(sizeM/separation)² */
export function traceLayer(
  field: RoadField, axis: 'major' | 'minor', seeds: Seed[], terrain: Terrain, sizeM: number,
  index: RoadIndex, opts: TraceOpts, rng: Rng, irregularityAt: (p: Pt) => number,
  idPrefix: string, cls: RoadClass,
): Road[] {
  // strictly own-class here (not "or higher"): a minor seed forked from an
  // already-indexed major road sits exactly on top of it by construction
  // (seedsAlong places it there) — that's the intended fork point, not a
  // duplicate to reject. traceStreamline's own snap/parallel rules (which do
  // use same-or-higher) still apply once the trace has moved away from it.
  const cap = 4 * (sizeM / opts.separation) ** 2
  const roads: Road[] = []
  let n = 0
  for (let i = 0; i < seeds.length && i < cap; i++) {
    const seed = seeds[i]
    if (index.nearest(seed.at, 0.3 * opts.separation, (c) => c === cls)) continue
    const points = traceStreamline(field, axis, seed, terrain, sizeM, index, opts, rng, irregularityAt)
    if (!points) continue
    n += 1
    const id = idPrefix + String(n).padStart(3, '0')
    index.add(id, points, cls)
    roads.push({ id, class: cls, points, width: cls === 'arterial' ? 18 : 9, name: null })
  }
  return roads
}
