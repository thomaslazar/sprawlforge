import { bboxOf, pointAtT, pointInRings, polylineLength, type Pt } from '../geometry'
import type { Rng } from '../rng'
import { RING_ID_PREFIX } from '../landmarks/place'
import { inWater } from '../sector/bridges'
import { distToPolyline } from '../terrain/rivers'
import type { Road, RoadClass, Terrain } from '../types'
import type { RoadField } from './field'

export interface Seed {
  at: Pt
  dir?: Pt
  crossWater?: boolean
  /** overrides the caller's axis for this seed only (river/highway crossings: 'minor') */
  axis?: 'major' | 'minor'
  /** overrides riverSlice.width for this seed's crossWater band (see riverCrossingSeeds) */
  corridorWidth?: number
}

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
  /** arterials only: continue across a narrow river corridor as a bridge instead of stopping at the bank */
  bridgeRivers?: boolean
  /** simple polygons (arcology plazas, megablock cores) no streamline may enter */
  obstacles?: Pt[][]
}

export const MAJOR: TraceOpts = { separation: 400, step: 10, maxSteps: 600, minLength: 60, jitter: 0, decay: 0, bridgeRivers: true }
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

interface Seg { id: string; cls: RoadClass; a: Pt; b: Pt; arc: number; total: number }

/** a nearestMatching hit; `edge` = arc distance (m) from the hit point to the nearer end of its road */
export interface MatchHit { id: string; at: Pt; dist: number; segAngle: number; cls: RoadClass; edge: number }

/** uniform grid hash of road segments; nearest() scans only the cells within radius */
export class RoadIndex {
  private cellSize: number
  private cells = new Map<number, Seg[]>()

  constructor(cellSize: number) {
    this.cellSize = cellSize
  }

  add(id: string, points: Pt[], cls: RoadClass): void {
    const total = polylineLength(points)
    let arc = 0
    for (let i = 1; i < points.length; i++) {
      const seg: Seg = { id, cls, a: points[i - 1], b: points[i], arc, total }
      arc += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
      const cx0 = Math.floor(Math.min(seg.a.x, seg.b.x) / this.cellSize)
      const cx1 = Math.floor(Math.max(seg.a.x, seg.b.x) / this.cellSize)
      const cy0 = Math.floor(Math.min(seg.a.y, seg.b.y) / this.cellSize)
      const cy1 = Math.floor(Math.max(seg.a.y, seg.b.y) / this.cellSize)
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          const key = cx * 100003 + cy
          let bucket = this.cells.get(key)
          if (!bucket) { bucket = []; this.cells.set(key, bucket) }
          bucket.push(seg)
        }
      }
    }
  }

  remove(id: string): void {
    for (const [k, b] of this.cells) this.cells.set(k, b.filter((seg) => seg.id !== id))
  }

  private forEachInRadius(p: Pt, radius: number, visit: (seg: Seg, pt: Pt, d: number, edge: number) => void): void {
    const cx0 = Math.floor((p.x - radius) / this.cellSize)
    const cx1 = Math.floor((p.x + radius) / this.cellSize)
    const cy0 = Math.floor((p.y - radius) / this.cellSize)
    const cy1 = Math.floor((p.y + radius) / this.cellSize)
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const bucket = this.cells.get(cx * 100003 + cy)
        if (!bucket) continue
        for (const seg of bucket) {
          // nearest point on the segment; only allocate the point for hits
          const abx = seg.b.x - seg.a.x
          const aby = seg.b.y - seg.a.y
          const len2 = abx * abx + aby * aby || 1
          const t = clamp(0, 1, ((p.x - seg.a.x) * abx + (p.y - seg.a.y) * aby) / len2)
          const qx = seg.a.x + t * abx
          const qy = seg.a.y + t * aby
          const d = Math.hypot(p.x - qx, p.y - qy)
          if (d <= radius) {
            const at = seg.arc + t * Math.sqrt(len2)
            visit(seg, { x: qx, y: qy }, d, Math.min(at, seg.total - at))
          }
        }
      }
    }
  }

  nearest(
    p: Pt, radius: number, filter?: (cls: RoadClass) => boolean,
  ): { id: string; at: Pt; dist: number; segAngle: number; edge: number } | null {
    let best: { id: string; at: Pt; dist: number; segAngle: number; edge: number } | null = null
    this.forEachInRadius(p, radius, (seg, pt, d, edge) => {
      if (filter && !filter(seg.cls)) return
      if (!best || d < best.dist)
        best = { id: seg.id, at: pt, dist: d, segAngle: Math.atan2(seg.b.y - seg.a.y, seg.b.x - seg.a.x), edge }
    })
    return best
  }

  /**
   * Nearest segment within radius that ALSO satisfies `test` (given its id,
   * distance and direction) — unlike `nearest`, a closer segment that fails
   * `test` doesn't hide a farther one that passes it. Needed for rule 4
   * (parallel-road stop): a genuinely near-parallel neighbor can sit farther
   * away than some closer, merely-crossing road, and `nearest`'s "closest
   * point wins outright" would silently mask the one that actually matters.
   */
  nearestMatching(
    p: Pt, radius: number, test: (hit: MatchHit) => boolean,
  ): MatchHit | null {
    let best: MatchHit | null = null
    this.forEachInRadius(p, radius, (seg, pt, d, edge) => {
      const segAngle = Math.atan2(seg.b.y - seg.a.y, seg.b.x - seg.a.x)
      const hit = { id: seg.id, at: pt, dist: d, segAngle, cls: seg.cls, edge }
      if (!test(hit)) return
      if (!best || d < best.dist) best = hit
    })
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

/**
 * a crossWater seed may wet-cross the river corridor only; sea/lake still
 * stop it. `corridorWidth` (from a Seed measured by riverCrossingSeeds)
 * overrides the river's average `width` — the actual carved channel varies
 * well past that single scalar at any given point (see riverCrossingSeeds).
 */
function inRiverBand(terrain: Terrain, p: Pt, margin: number, corridorWidth?: number): boolean {
  const river = terrain.riverSlice
  if (!river) return false
  return distToPolyline(p, river.course) <= (corridorWidth ?? river.width) + margin
}

function clampToWindow(p: Pt, sizeM: number): Pt {
  return { x: clamp(0, sizeM, p.x), y: clamp(0, sizeM, p.y) }
}

const CROSSING_MAX_REACH = 450
const CROSSING_SAMPLE_STEP = 10
const PARALLEL_ANGLE = (25 * Math.PI) / 180
/** a raw direction flip beyond this between two steps is a field singularity: stop, never clamp (a clamped hairpin is a U-loop) */
const SINGULARITY_TURN = (60 * Math.PI) / 180
/** a street may end on a near-parallel road only broadside and after a real run (a stub right beside its parent is a wedge) */
const JOIN_MIN_ANGLE = (60 * Math.PI) / 180

function traceHalf(
  field: RoadField, axis: 'major' | 'minor', start: Pt, initDir: Pt,
  terrain: Terrain, sizeM: number, index: RoadIndex, opts: TraceOpts,
  sep: number, rng: Rng, irregularityAt: (p: Pt) => number, crossWater: boolean,
  sourceId: string | null, seedAt: Pt, corridorWidth: number | undefined, decayEnds?: Pt[],
): Pt[] {
  const ownRank = ownRankFor(axis)
  const sameOrHigher = (c: RoadClass) => CLASS_RANK[c] >= ownRank
  const maxTurn = opts.maxTurn ?? Math.PI
  const obstacles = (opts.obstacles ?? []).map((ring) => ({ ring, box: bboxOf(ring) }))
  const inObstacle = (q: Pt) => obstacles.some((o) => q.x >= o.box.x && q.x <= o.box.x + o.box.w && q.y >= o.box.y && q.y <= o.box.y + o.box.h && pointInRings(q, [o.ring]))
  const pts: Pt[] = []
  let p = start
  let dir = initDir
  let bridges = 0
  // parent exclusion (rules 3 and 4): only while the trace is
  // still within 0.35 × sep of the seed; beyond that the parent is ordinary
  // an arcology ring (id K<n>) is a closed circle: a spoke leaving it is never a twin of the far side
  const isRing = (id: string) => id.startsWith(RING_ID_PREFIX)
  const isSourceAt = (id: string, at: Pt) =>
    id === sourceId && Math.hypot(at.x - seedAt.x, at.y - seedAt.y) < 0.35 * opts.separation
  for (let i = 0; i < opts.maxSteps; i++) {
    const rawDir = rk4Dir(field, axis, p, dir, opts.step)
    // the highway (maxTurn set) is smoothed by its clamp instead
    if (i > 0 && opts.maxTurn === undefined && Math.acos(clamp(-1, 1, dir.x * rawDir.x + dir.y * rawDir.y)) > SINGULARITY_TURN) break
    const newDir = clampTurn(dir, rawDir, maxTurn)
    const next = { x: p.x + newDir.x * opts.step, y: p.y + newDir.y * opts.step }

    if (next.x < 0 || next.x > sizeM || next.y < 0 || next.y > sizeM) {
      pts.push(clampToWindow(next, sizeM))
      break
    }
    if (inObstacle(next)) break
    if (inWater(terrain, next) && !(crossWater && inRiverBand(terrain, next, opts.step, corridorWidth))) {
      // arterials bridge a narrow river along their current heading (at most 2 per half)
      const river = terrain.riverSlice
      if (!opts.bridgeRivers || crossWater || bridges >= 2 || !river) break
      if (distToPolyline(next, river.course) > river.width * 1.5) break
      let d = opts.step
      while (d <= CROSSING_MAX_REACH && inWater(terrain, { x: p.x + dir.x * d, y: p.y + dir.y * d })) d += CROSSING_SAMPLE_STEP
      const land = { x: p.x + dir.x * d, y: p.y + dir.y * d }
      if (d > CROSSING_MAX_REACH || land.x < 0 || land.x > sizeM || land.y < 0 || land.y > sizeM) break
      pts.push(land)
      p = land
      bridges++
      continue
    }

    // a seed forked off an existing road (e.g. a street seeded ON an
    // arterial) sits at distance ~0 from it; excluding that one specific
    // segment (not a blanket grace window, and not for the whole trace —
    // R6) lets the child immediately leave its parent while every OTHER
    // road, and the parent itself once far enough away, is still checked.
    const hitSame = index.nearest(next, 0.3 * sep, sameOrHigher)
    if (hitSame && !isSourceAt(hitSame.id, next)) {
      // the walker overshot the target by < 1 step: backtrack (at most 2 points) so the road ends on it without doubling back.
      // A foot still behind after that means the walker is leaving this road (e.g. its own parent), not hitting it: keep walking.
      const foot = hitSame.at
      const aheadAt = (n: number) => {
        const last = n > 0 ? pts[n - 1] : start
        const prev = n >= 2 ? pts[n - 2] : n === 1 ? start : { x: start.x - initDir.x, y: start.y - initDir.y }
        return (foot.x - last.x) * (last.x - prev.x) + (foot.y - last.y) * (last.y - prev.y) >= 0
      }
      let keep = -1
      for (let k = 0; k <= 2 && k <= pts.length && keep < 0; k++) if (aheadAt(pts.length - k)) keep = pts.length - k
      if (keep >= 0) {
        pts.length = keep
        if (!inObstacle(foot)) pts.push(foot)
        break
      }
    }

    // nearestMatching, not nearest: a closer but merely-CROSSING road (angle
    // >= 25°) must not hide a farther but genuinely near-parallel one — with
    // plain `nearest` a doubled lane could sit safely past whatever nearer
    // road happens to win the distance comparison and never get caught.
    const dirAngle = Math.atan2(newDir.y, newDir.x)
    // a child that hugs its own parent from the seed on is a sliver twin (the
    // parent exclusion below would let it run on for 0.35 sep): kill this half (arterials only)
    if (opts.bridgeRivers && sourceId && pts.length < 4 && index.nearestMatching(
      next, 25, (hit) => hit.id === sourceId && angleGapLines(Math.atan2(newDir.y, newDir.x), hit.segAngle) < PARALLEL_ANGLE,
    )) return []
    const hitPar = index.nearestMatching(
      next, 0.7 * sep, (hit) => !isSourceAt(hit.id, next) && !isRing(hit.id) && angleGapLines(dirAngle, hit.segAngle) < PARALLEL_ANGLE,
    )
    if (hitPar) {
      // a street stopped by a near-parallel road would end free and the prune would drop it (and the
      // void it blocked stays empty): end it on that road instead, if the foot lies ahead of the walker
      const foot = hitPar.at
      const join = angleGapLines(Math.atan2(foot.y - p.y, foot.x - p.x), hitPar.segAngle)
      if (!opts.bridgeRivers && hitPar.cls !== 'highway' && hitPar.edge >= 6 && join > JOIN_MIN_ANGLE && pts.length * opts.step >= 0.5 * sep && (foot.x - p.x) * dir.x + (foot.y - p.y) * dir.y > 0 && !inObstacle(foot)) pts.push(foot)
      break
    }

    pts.push(next)
    p = next
    dir = newDir

    if (irregularityAt(p) > 0.4 && rng.chance((opts.decay * opts.step) / 1000)) { decayEnds?.push(p); break }
  }
  return pts
}

export function traceStreamline(
  field: RoadField, axis: 'major' | 'minor', seed: Seed, terrain: Terrain, sizeM: number,
  index: RoadIndex, opts: TraceOpts, rng: Rng, irregularityAt: (p: Pt) => number, decayEnds?: Pt[],
): Pt[] | null {
  // riverSlice.course (and so riverCrossingSeeds) carries a margin past the
  // window edge (Terrain's own doc comment) — a seed out there would put an
  // out-of-window point straight into the result, breaking window
  // containment. No road for a seed that isn't even on the map.
  if (seed.at.x < 0 || seed.at.x > sizeM || seed.at.y < 0 || seed.at.y > sizeM) return null
  const useAxis = seed.axis ?? axis
  const irr = irregularityAt(seed.at)
  const jitterScale = (Math.max(0, irr - 0.4) / 0.55) * (rng.next() - 0.5) * 2
  const sep = opts.separation * (1 + opts.jitter * jitterScale)
  const crossWater = !!seed.crossWater
  const ownRank = ownRankFor(useAxis)
  const source = index.nearest(seed.at, 0.3 * sep, (c) => CLASS_RANK[c] >= ownRank)
  const sourceId = source?.id ?? null

  const sample = field.sample(seed.at)
  const initDir = seed.dir ? normalize(seed.dir) : (useAxis === 'major' ? sample.major : sample.minor)
  // a twin is never born: seeded along its own parent
  if (source && angleGapLines(Math.atan2(initDir.y, initDir.x), source.segAngle) < PARALLEL_ANGLE) return null
  const forward = traceHalf(
    field, useAxis, seed.at, initDir, terrain, sizeM, index, opts, sep, rng, irregularityAt,
    crossWater, sourceId, seed.at, seed.corridorWidth, decayEnds,
  )
  const backward = traceHalf(
    field, useAxis, seed.at, { x: -initDir.x, y: -initDir.y }, terrain, sizeM, index, opts, sep, rng, irregularityAt,
    crossWater, sourceId, seed.at, seed.corridorWidth, decayEnds,
  )

  const points = [...backward.slice().reverse(), seed.at, ...forward]
  if (polylineLength(points) < opts.minLength) return null
  return points
}

/**
 * Cut short tails that poke past a junction: walking back from each end of a
 * road, the first point within `weld` metres of ANOTHER indexed road inside
 * the first `maxStub` metres of arc becomes the new end (moved onto that
 * road). Cause-agnostic cleanup for the little "blips" a step-discretised
 * trace leaves beyond the road it snapped to.
 */
export function trimStubs(roads: Road[], index: RoadIndex, maxStub = 40, weld = 3): Road[] {
  return roads.map((r) => {
    let pts = r.points
    for (const fromEnd of [false, true]) {
      const seq = fromEnd ? pts.slice().reverse() : pts
      let arc = 0
      let cutAt = -1
      let joinPt: Pt | null = null
      for (let i = 1; i < seq.length && arc <= maxStub; i++) {
        arc += Math.hypot(seq[i].x - seq[i - 1].x, seq[i].y - seq[i - 1].y)
        if (arc > maxStub) break
        const hit = index.nearestMatching(seq[i], weld, (h) => h.id !== r.id)
        if (hit) { cutAt = i; joinPt = hit.at }
      }
      // only a tail: the end itself must NOT already sit on another road
      const endHit = index.nearestMatching(seq[0], weld, (h) => h.id !== r.id)
      if (cutAt > 0 && joinPt && !endHit) {
        const kept = seq.slice(cutAt)
        kept[0] = joinPt
        pts = fromEnd ? kept.reverse() : kept
      }
    }
    return pts === r.points ? r : { ...r, points: pts }
  })
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
export function seedsAlong(points: Pt[], every: number, alternate: boolean, reject?: (p: Pt) => boolean): Seed[] {
  const len = polylineLength(points)
  const seeds: Seed[] = []
  let flip = false
  for (let dist = every; dist < len; dist += every) {
    const t = dist / len
    const tangent = tangentAt(points, t)
    const normal = { x: -tangent.y, y: tangent.x }
    const at = pointAtT(points, t)
    if (!reject?.(at)) seeds.push({ at, dir: flip && alternate ? { x: -normal.x, y: -normal.y } : normal })
    flip = !flip
  }
  return seeds
}

const RIVER_CROSSING_SPACING = 1000
const RIVER_CROSSING_JITTER = 200
const CROSSING_RETRY_OFFSETS = [0, 100, -100, 200, -200]

/**
 * Wet extent from `at` along ±normal, sampled every 10 m up to 450 m each
 * side (the carve profile tapers monotonically outward, rivers.ts, so the
 * first dry sample on a side ends that side's wet zone); null if either
 * side is still wet at the full 450 m reach (too wide to size confidently).
 */
export function measureCorridorWidth(terrain: Terrain, at: Pt, normal: Pt): number | null {
  let maxWet = 0
  for (const sign of [1, -1] as const) {
    for (let d = CROSSING_SAMPLE_STEP; d <= CROSSING_MAX_REACH; d += CROSSING_SAMPLE_STEP) {
      if (!inWater(terrain, { x: at.x + sign * normal.x * d, y: at.y + sign * normal.y * d })) break
      maxWet = Math.max(maxWet, d)
      if (d === CROSSING_MAX_REACH) return null
    }
  }
  return maxWet + CROSSING_SAMPLE_STEP
}

/**
 * Seeds mid-river, perpendicular to flow, every ~1000±200m, tagged
 * `axis: 'minor'` — near a river the field's `boundary` basis (field.ts)
 * aligns `major` WITH the river's own tangent (full weight at distance 0),
 * so a crossing must walk the `minor` axis (⟂ major) to actually cross
 * rather than ride downstream. `riverSlice.width` is a single scalar
 * average; the real carved width varies well past it at any given point
 * (rivers.ts widthMultiplier + carve falloff), so each candidate's actual
 * wet extent is measured and carried as `corridorWidth`. A candidate whose
 * extent still runs the full 450 m reach is retried at ±100/±200 m along
 * the course before that crossing slot is skipped.
 */
export function riverCrossingSeeds(terrain: Terrain, rng: Rng): Seed[] {
  const river = terrain.riverSlice
  if (!river) return []
  const len = polylineLength(river.course)
  const seeds: Seed[] = []
  let dist = RIVER_CROSSING_SPACING / 2
  while (dist < len) {
    for (const offset of CROSSING_RETRY_OFFSETS) {
      const d = dist + offset
      if (d <= 0 || d >= len) continue
      const t = d / len
      const at = pointAtT(river.course, t)
      const tangent = tangentAt(river.course, t)
      const normal = { x: -tangent.y, y: tangent.x }
      const corridorWidth = measureCorridorWidth(terrain, at, normal)
      if (corridorWidth !== null) {
        seeds.push({ at, dir: normal, crossWater: true, axis: 'minor', corridorWidth })
        break
      }
    }
    dist += RIVER_CROSSING_SPACING + (rng.next() * 2 - 1) * RIVER_CROSSING_JITTER
  }
  return seeds
}

// a seed can sit exactly on the road it forked from (seedsAlong places it
// there by construction) — the source-resolution radius only needs to catch
// that near-zero-distance case, not a general nearby-road search.
const SEED_SOURCE_RADIUS = 1

/**
 * trace every seed in order, indexing successes as it goes; caps the queue at 4×(sizeM/separation)².
 * With `expand`, `seeds` is a FIFO work queue: each kept road pushes its own child seeds,
 * and the cap counts kept roads instead of processed seeds.
 */
export function traceLayer(
  field: RoadField, axis: 'major' | 'minor', seeds: Seed[], terrain: Terrain, sizeM: number,
  index: RoadIndex, opts: TraceOpts, rng: Rng, irregularityAt: (p: Pt) => number,
  idPrefix: string, cls: RoadClass, decayEnds?: Pt[], expand?: (road: Road) => Seed[],
): Road[] {
  const ownRank = CLASS_RANK[cls]
  const sameOrHigher = (c: RoadClass) => CLASS_RANK[c] >= ownRank
  const cap = 4 * (sizeM / opts.separation) ** 2
  const roads: Road[] = []
  let n = 0
  for (let i = 0; i < seeds.length && (expand ? n < cap : i < cap); i++) {
    const seed = seeds[i]
    // R14: a seed forked from an already-indexed road (seedsAlong places it
    // exactly on its parent) must not be rejected for sitting on that road —
    // only for sitting near a DIFFERENT same-or-higher road. Resolve the
    // parent (any class, ~1 m) the same way traceStreamline resolves its own
    // sourceId, then only reject when the same-or-higher blocker isn't it.
    const source = index.nearest(seed.at, SEED_SOURCE_RADIUS, () => true)
    const blocker = index.nearest(seed.at, 0.3 * opts.separation, sameOrHigher)
    if (blocker && blocker.id !== source?.id) continue
    const points = traceStreamline(field, axis, seed, terrain, sizeM, index, opts, rng, irregularityAt, decayEnds)
    if (!points) continue
    n += 1
    const id = idPrefix + String(n).padStart(3, '0')
    index.add(id, points, cls)
    const road: Road = { id, class: cls, points, width: cls === 'arterial' ? 18 : 9, name: null }
    roads.push(road)
    if (expand) seeds.push(...expand(road))
  }
  return roads
}

export const endKey = (p: Pt): string => `${p.x},${p.y}`

const nearWater = (terrain: Terrain, p: Pt, r: number): boolean => {
  if (inWater(terrain, p)) return true
  for (let a = 0; a < 16; a++) if (inWater(terrain, { x: p.x + r * Math.cos((a * Math.PI) / 8), y: p.y + r * Math.sin((a * Math.PI) / 8) })) return true
  return false
}

export interface PruneOpts {
  /** classes a road end may legitimately meet */
  accept: (cls: RoadClass) => boolean
  minLength: number
  /** `endKey`s of ends that may dangle (decay cul-de-sacs) */
  keep?: Set<string>
  weld?: number
  /** a junction must be >= weld m of arc from both ends of the other road (end-to-end chains don't anchor) */
  interiorOnly?: boolean
  /** replaces the plain "near water" acceptance of an end; `stubLength` = arc length from the end to the nearest accepted junction (whole road if none) */
  waterAnchor?: (p: Pt, stubLength: number) => boolean
}

/**
 * Prune, never invent: a road end that is not on the window edge, near water,
 * or welded to the interior (>= weld m from both ends) of an accepted road is cut back along the polyline to the first
 * junction with an accepted road (the dangling tail goes); no junction, or a
 * remainder under `minLength`, drops the road. `index` must hold every road
 * (incl. `roads`) and is kept in sync as roads are cut; repeats until stable
 * (a cut can un-anchor a neighbour), max 10 passes. Only changed roads are new objects.
 */
export function pruneDangling(roads: Road[], index: RoadIndex, terrain: Terrain, sizeM: number, opts: PruneOpts): Road[] {
  const weld = opts.weld ?? 6
  const onEdge = (p: Pt) => p.x < 1 || p.y < 1 || p.x > sizeM - 1 || p.y > sizeM - 1
  let cur = roads
  for (let pass = 0; pass < 10; pass++) {
    let changed = false
    const next: Road[] = []
    for (const r of cur) {
      // K roads are never pruned: a closed ring has no ends, an open half ring ends on its end spokes
      if (r.id.startsWith(RING_ID_PREFIX)) { next.push(r); continue }
      const near = (p: Pt, anyEnd = false) => index.nearestMatching(p, weld, (h) => h.id !== r.id && opts.accept(h.cls) && (anyEnd || !opts.interiorOnly || h.edge >= weld))
      let pts = r.points
      let dead = false
      for (const fromEnd of [false, true]) {
        const seq = fromEnd ? pts.slice().reverse() : pts
        const end = seq[0]
        if (seq.length < 2 || onEdge(end) || opts.keep?.has(endKey(end)) || near(end)) continue
        const dx = end.x - seq[1].x
        const dy = end.y - seq[1].y
        const len = Math.hypot(dx, dy) || 1
        const wet = nearWater(terrain, end, 15) || inWater(terrain, { x: end.x + (dx / len) * 15, y: end.y + (dy / len) * 15 })
        if (wet && !opts.waterAnchor) continue
        // walk inward in ~5 m samples to the first junction
        let kept: Pt[] | null = null
        let stub = 0
        let done = 0 // arc length of seq[0..i-1]
        for (let i = 1; i < seq.length && !kept; i++) {
          const a = seq[i - 1]
          const b = seq[i]
          const seg = Math.hypot(b.x - a.x, b.y - a.y)
          const n = Math.max(1, Math.ceil(seg / 5))
          for (let k = 1; k <= n; k++) {
            const q = { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n }
            stub = done + Math.hypot(q.x - a.x, q.y - a.y)
            // any end counts here: a trunk cut back to the foot of a side street it carries keeps that street; interiorOnly would drop the whole trunk and cascade
            const hit = near(q, true)
            // a wet end that only touches another road's end is a chain, not an anchor: both tails go
            if (hit && !(opts.interiorOnly && wet && stub <= weld && hit.edge < weld)) { kept = [hit.at, ...seq.slice(k === n ? i + 1 : i)]; break }
          }
          done += seg
        }
        if (wet && opts.waterAnchor!(end, kept ? stub : polylineLength(seq))) continue
        if (!kept) { dead = true; break }
        pts = fromEnd ? kept.reverse() : kept
      }
      if (dead || (pts !== r.points && polylineLength(pts) < opts.minLength)) {
        index.remove(r.id); changed = true; continue
      }
      if (pts !== r.points) {
        const nr = { ...r, points: pts }
        index.remove(r.id); index.add(r.id, pts, r.class)
        next.push(nr); changed = true
      } else next.push(r)
    }
    cur = next
    if (!changed) break
  }
  return cur
}
