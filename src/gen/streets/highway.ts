import { pointAtT, pointInRings, polylineLength, slicePolyline, type Pt } from '../geometry'
import { hashSeed, mulberry32, type Rng } from '../rng'
import { effectiveIrregularity } from '../sector/zoning'
import { inWater } from '../sector/bridges'
import { distToPolyline } from '../terrain/rivers'
import type {
  District, HighwayCrossing, HighwayLevel, HighwaySegment, Road, SectorParams, Terrain, ZoneType,
} from '../types'
import { buildRoadField, type BasisField, type RoadField } from './field'
import { MAJOR, RoadIndex, measureCorridorWidth, traceStreamline, type TraceOpts } from './trace'

export const HIGHWAY_WIDTH = 32

const AXIS_JITTER = Math.PI / 9 // ± 20°
const ENTRY_ATTEMPTS = 3
const ENTRY_LO = 0.3
const ENTRY_SPAN = 0.4
const SPAN_TOL = 1 // "reaching the opposite edge within 1 m" counts as spanning (R11)
// a stop point this close to riverSlice.course counts as the river (vs.
// sea/lake, which just ends the trace) — wider than riverSlice.width itself
// since the actual carve varies past that single scalar average
const RIVER_BAND_FACTOR = 1.5
const BRIDGE_MAX_TURN_FROM_HEADING = Math.PI / 4 // R12: bridge chord ≤ 45° off the recent approach heading

const clamp = (lo: number, hi: number, v: number) => Math.max(lo, Math.min(hi, v))
const clampToWindow = (p: Pt, sizeM: number): Pt => ({ x: clamp(0, sizeM, p.x), y: clamp(0, sizeM, p.y) })

const normalize = (v: Pt): Pt => {
  const len = Math.hypot(v.x, v.y) || 1
  return { x: v.x / len, y: v.y / len }
}

export function spineBasis(angle: number, weight = 2): BasisField {
  return { name: 'spine', angle: () => angle, weight: () => weight }
}

/** unit tangent of the polyline segment nearest to p */
function nearestTangent(line: Pt[], p: Pt): Pt {
  let best = Infinity
  let tangent: Pt = { x: 0, y: 1 }
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i]
    const b = line[i + 1]
    const abx = b.x - a.x
    const aby = b.y - a.y
    const len2 = abx * abx + aby * aby || 1
    const t = clamp(0, 1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2)
    const d = Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby))
    if (d < best) { best = d; tangent = normalize({ x: abx, y: aby }) }
  }
  return tangent
}

/** clamp the angle of `to` to at most maxRad from `from` (both unit vectors) */
function clampAngleTo(from: Pt, to: Pt, maxRad: number): Pt {
  const a0 = Math.atan2(from.y, from.x)
  const a1 = Math.atan2(to.y, to.x)
  const diff = Math.atan2(Math.sin(a1 - a0), Math.cos(a1 - a0))
  const a = a0 + clamp(-maxRad, maxRad, diff)
  return { x: Math.cos(a), y: Math.sin(a) }
}

interface EdgeSpec {
  name: 'top' | 'left' | 'bottom' | 'right'
  /** the field's spine axis for this edge, before the ± jitter — perpendicular to the edge */
  axisBase: number
  seedAt(pos: number, sizeM: number): Pt
  /** unit direction pointing inward from this edge */
  dir: Pt
  /** the coordinate that advances as the trace moves inward, away from this edge */
  travelCoord: 'x' | 'y'
  oppositeValue(sizeM: number): number
  /** the other coordinate — used to detect a side-edge exit before reaching the opposite edge */
  perpCoord: 'x' | 'y'
}

// R11: search order top, left, bottom, right — the first edge whose trace
// spans to its opposite edge wins outright.
const EDGES: EdgeSpec[] = [
  {
    name: 'top', axisBase: Math.PI / 2, seedAt: (pos) => ({ x: pos, y: 1 }), dir: { x: 0, y: 1 },
    travelCoord: 'y', oppositeValue: (sizeM) => sizeM, perpCoord: 'x',
  },
  {
    name: 'left', axisBase: 0, seedAt: (pos) => ({ x: 1, y: pos }), dir: { x: 1, y: 0 },
    travelCoord: 'x', oppositeValue: (sizeM) => sizeM, perpCoord: 'y',
  },
  {
    name: 'bottom', axisBase: Math.PI / 2, seedAt: (pos, sizeM) => ({ x: pos, y: sizeM - 1 }), dir: { x: 0, y: -1 },
    travelCoord: 'y', oppositeValue: () => 0, perpCoord: 'x',
  },
  {
    name: 'right', axisBase: 0, seedAt: (pos, sizeM) => ({ x: sizeM - 1, y: pos }), dir: { x: -1, y: 0 },
    travelCoord: 'x', oppositeValue: () => 0, perpCoord: 'y',
  },
]

/**
 * Trace one highway from `seedAt` on `edge`, inward. `crossWater` stays off
 * for the whole trace (R6: the highway must not ride the field's own
 * river-following behavior); when the trace stops dry at the river's edge,
 * bridge straight across — the course normal, oriented toward the recent
 * approach heading and clamped to at most 45° off it (R12) — to the first
 * dry point measured the way riverCrossingSeeds does, then resume from there
 * with dir = the bridge direction (so the splice OUT of the bridge stays
 * turn-continuous with the resumed trace; the splice INTO the bridge is a
 * one-off engineered transition, not subject to the tracer's own curvature
 * limit). Exactly one bridge per trace (R12) — a second river stop just
 * ends the trace where it stands. A stop at water that ISN'T the river
 * (sea/lake), a side-edge exit, or a corridor too wide to bridge (>450 m)
 * all just end the trace where it stands — the caller compares candidates
 * by length and by whether they spanned, so a shorter dead end simply loses
 * to a better entry.
 */
function traceFromEdge(
  field: RoadField, edge: EdgeSpec, seedAt: Pt, terrain: Terrain, sizeM: number,
  opts: TraceOpts, rng: Rng, irregularityAt: (p: Pt) => number,
): Pt[] | null {
  const index = new RoadIndex(200) // R6: nothing to snap to yet
  let points: Pt[] | null = null
  let at = seedAt
  let dir = edge.dir
  let bridged = false

  for (;;) {
    const seg = traceStreamline(
      field, 'major', { at, dir, axis: 'major', crossWater: false }, terrain, sizeM, index, opts, rng, irregularityAt,
    )
    if (!seg) return points
    points = points ? points.concat(seg.slice(1)) : seg

    const last = points[points.length - 1]
    if (Math.abs(last[edge.travelCoord] - edge.oppositeValue(sizeM)) <= SPAN_TOL) return points // reached the far edge
    const onSide = last[edge.perpCoord] > 1e-6 && last[edge.perpCoord] < sizeM - 1e-6
    if (!onSide || bridged) return points // exited a side edge, or already used our one bridge (R12)

    const river = terrain.riverSlice
    if (!river || distToPolyline(last, river.course) > river.width * RIVER_BAND_FACTOR) return points // sea/lake — done

    const prev = points.length > 1 ? points[points.length - 2] : last
    const heading = normalize({ x: last.x - prev.x, y: last.y - prev.y })
    const tangent = nearestTangent(river.course, last)
    let normal = { x: -tangent.y, y: tangent.x }
    if (normal.x * heading.x + normal.y * heading.y < 0) normal = { x: -normal.x, y: -normal.y }
    normal = clampAngleTo(heading, normal, BRIDGE_MAX_TURN_FROM_HEADING) // R12

    const width = measureCorridorWidth(terrain, last, normal)
    if (width === null) return points // too wide to bridge — this trace is done

    // R1: a far-bank point computed from an in-window `last` plus a bounded
    // offset can still land fractionally outside — clamp before pushing.
    const farBank = clampToWindow({ x: last.x + normal.x * width, y: last.y + normal.y * width }, sizeM)
    points.push(farBank)
    at = farBank
    dir = normal
    bridged = true
  }
}

export function traceHighway(
  params: SectorParams, terrain: Terrain, sizeM: number,
): { road: Road; field: RoadField } {
  const rng = mulberry32(hashSeed(params.seed, 'highway'))
  const irregularityAt = effectiveIrregularity(params)
  const opts: TraceOpts = { ...MAJOR, maxSteps: 2000, maxTurn: MAJOR.step / 300 }

  let best: Pt[] | null = null
  let bestField: RoadField | null = null

  edgeLoop: for (const edge of EDGES) {
    const axis = edge.axisBase + (rng.next() * 2 - 1) * AXIS_JITTER
    const field = buildRoadField(params, terrain, sizeM, [spineBasis(axis)])

    for (let attempt = 0; attempt < ENTRY_ATTEMPTS; attempt++) {
      const pos = sizeM * (ENTRY_LO + ENTRY_SPAN * rng.next())
      const seedAt = edge.seedAt(pos, sizeM)
      if (inWater(terrain, seedAt)) continue // R11: skip a wet entry point

      const candidate = traceFromEdge(field, edge, seedAt, terrain, sizeM, opts, rng, irregularityAt)
      if (!candidate) continue
      if (!best || polylineLength(candidate) > polylineLength(best)) { best = candidate; bestField = field }

      const last = candidate[candidate.length - 1]
      if (Math.abs(last[edge.travelCoord] - edge.oppositeValue(sizeM)) <= SPAN_TOL) {
        best = candidate
        bestField = field
        break edgeLoop // R11: the first edge with a spanning trace wins
      }
    }
  }

  const road: Road = { id: 'H1', class: 'highway', width: HIGHWAY_WIDTH, name: null, points: best ?? [] }
  return { road, field: bestField ?? buildRoadField(params, terrain, sizeM, [spineBasis(Math.PI / 2)]) }
}

// ---------------------------------------------------------------- levels

const SAMPLE_M = 10
const MIN_STRETCH_M = 500
const LEVELS: HighwayLevel[] = ['sunken', 'ground', 'elevated']
const MAX_CAP = 4

interface Stretch { district: District; from: number; to: number; wetT: number | null }

function stretchesOf(pts: Pt[], districts: District[], terrain: Terrain): Stretch[] {
  const len = polylineLength(pts)
  const n = Math.max(1, Math.ceil(len / SAMPLE_M))
  const found: Array<District | null> = []
  const wetAt: boolean[] = []
  for (let i = 0; i <= n; i++) {
    const p = pointAtT(pts, i / n)
    found.push(districts.find((d) => pointInRings(p, [d.poly])) ?? null)
    wetAt.push(inWater(terrain, p))
  }
  const fallback = found.find((d) => d) ?? districts[0]
  let cur = fallback
  const ds = found.map((d) => (cur = d ?? cur))
  const out: Stretch[] = []
  for (let i = 0; i <= n; i++) {
    const last = out[out.length - 1]
    if (last && last.district === ds[i]) last.to = i / n
    else out.push({ district: ds[i], from: out.length ? out[out.length - 1].to : 0, to: i / n, wetT: null })
    if (wetAt[i] && out[out.length - 1].wetT === null) out[out.length - 1].wetT = i / n
  }
  return out
}

const preference = (zone: ZoneType, alt: boolean): HighwayLevel => {
  if (zone === 'corp') return 'sunken'
  if (zone === 'residential' || zone === 'entertainment') return alt ? 'sunken' : 'elevated'
  return alt ? 'elevated' : 'ground'
}

export function assignHighwayLevels(highway: Road, districts: District[], terrain: Terrain, rng: Rng): HighwaySegment[] {
  const pts = highway.points
  if (districts.length === 0 || pts.length < 2) return []
  const len = polylineLength(pts)
  const stretches = stretchesOf(pts, districts, terrain)
  const rolls = { a: rng.chance(0.5), b: rng.chance(0.5) } // once per sector
  for (let cap = 2; cap < MAX_CAP; cap++) {
    const out = tryAssign(stretches, len, cap, rolls)
    if (out) return out
  }
  return tryAssign(stretches, len, MAX_CAP, rolls) ?? tryAssign(stretches, len, Infinity, rolls)!
}

function tryAssign(
  stretches: Stretch[], len: number, cap: number, rolls: { a: boolean; b: boolean },
): HighwaySegment[] | null {
  const out: HighwaySegment[] = []
  let level: HighwayLevel = 'ground'
  let changes = 0
  const push = (from: number, to: number, lv: HighwayLevel, id: string) => {
    const prev = out[out.length - 1]
    out.push({ from, to, level: lv, districtId: id, transition: !!prev && prev.level !== lv })
  }
  stretches.forEach((st, i) => {
    const z = st.district.zone
    const pref = preference(z, z === 'industrial' || z === 'docks' || z === 'slum' ? rolls.b : rolls.a)
    const short = (st.to - st.from) * len < MIN_STRETCH_M
    const id = st.district.id
    const wetStretch = st.wetT !== null
    if (i === 0) level = wetStretch ? 'elevated' : pref
    else if (wetStretch) { // R19: any wet stretch ends elevated, whatever came before
      changes += LEVELS.indexOf('elevated') - LEVELS.indexOf(level)
      if (level === 'sunken') { // sunken → ground → elevated
        const prev = out[out.length - 1]
        if ((st.wetT! - st.from) * len >= 5 * SAMPLE_M) {
          const mid = (st.from + st.wetT!) / 2
          push(st.from, mid, 'ground', id)
          push(mid, st.to, 'elevated', id)
          level = 'elevated'
          return
        }
        const cutAt = prev.to - Math.min(150 / len, (prev.to - prev.from) / 2)
        out.push({ from: cutAt, to: prev.to, level: 'ground', districtId: prev.districtId, transition: true })
        prev.to = cutAt
      }
      level = 'elevated'
    } else if (!short && pref !== level && changes < cap) {
      const d = LEVELS.indexOf(pref) - LEVELS.indexOf(level)
      level = LEVELS[LEVELS.indexOf(level) + Math.sign(d)]
      changes++
    }
    push(st.from, st.to, level, id)
  })
  return changes > cap ? null : out
}

export function levelAt(segments: HighwaySegment[], t: number): HighwayLevel {
  return (segments.find((s) => t >= s.from && t < s.to) ?? segments[segments.length - 1]).level
}

// ------------------------------------------------------ crossings & cuts

/** distance from p to the polyline plus the arc-length fraction of the nearest point */
function nearestT(p: Pt, line: Pt[]): { dist: number; t: number } {
  const total = polylineLength(line) || 1
  let best = Infinity
  let bestT = 0
  let acc = 0
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i]
    const b = line[i + 1]
    const abx = b.x - a.x
    const aby = b.y - a.y
    const l = Math.hypot(abx, aby)
    const f = clamp(0, 1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / (l * l || 1))
    const d = Math.hypot(p.x - (a.x + f * abx), p.y - (a.y + f * aby))
    if (d < best) { best = d; bestT = (acc + f * l) / total }
    acc += l
  }
  return { dist: best, t: bestT }
}

/** intersection of segments ab and cd: fraction along ab, or null */
function segHit(a: Pt, b: Pt, c: Pt, d: Pt): number | null {
  const r = { x: b.x - a.x, y: b.y - a.y }
  const q = { x: d.x - c.x, y: d.y - c.y }
  const den = r.x * q.y - r.y * q.x
  if (Math.abs(den) < 1e-12) return null
  const t = ((c.x - a.x) * q.y - (c.y - a.y) * q.x) / den
  const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / den
  return t >= 0 && t < 1 && u >= 0 && u < 1 ? t : null
}

export function highwayCrossings(highway: Road, roads: Road[], segments: HighwaySegment[], rng: Rng): HighwayCrossing[] {
  const hp = highway.points
  const total = polylineLength(hp) || 1
  const out: HighwayCrossing[] = []
  for (const road of roads) {
    if (road.class !== 'arterial' && road.class !== 'street') continue
    for (let i = 0; i < road.points.length - 1; i++) {
      let acc = 0
      for (let j = 0; j < hp.length - 1; j++) {
        const l = Math.hypot(hp[j + 1].x - hp[j].x, hp[j + 1].y - hp[j].y)
        const f = segHit(hp[j], hp[j + 1], road.points[i], road.points[i + 1])
        if (f !== null) {
          const at = (acc + f * l) / total
          const level = levelAt(segments, at)
          const kind = level === 'elevated' ? 'under' : level === 'sunken' ? 'over'
            : road.class === 'arterial' ? (rng.chance(0.5) ? 'over' : 'under') : null
          if (kind) out.push({ roadId: road.id, at, kind, interchange: false })
        }
        acc += l
      }
    }
  }
  const seen = new Set<string>()
  return out.filter((c) => {
    const k = c.roadId + ':' + Math.round(c.at * 1e6)
    return seen.has(k) ? false : (seen.add(k), true)
  }).sort((a, b) => a.at - b.at)
}

const CUT_DIST = HIGHWAY_WIDTH / 2 + 5
const MIN_REMNANT_M = 40
const DENSE_M = 2

/**
 * nearestT restricted to the segments within `reach` of p (50 m grid over the
 * segments' reach-inflated bboxes), or null when none is. Same arithmetic in
 * the same order as nearestT — cumulative lengths precomputed with the same
 * running sum, candidates visited in index order with the same strict `<` —
 * so a hit within `reach` matches nearestT exactly.
 */
function nearestTWithin(line: Pt[], reach: number): (p: Pt) => { dist: number; t: number } | null {
  const CELL = 50
  const total = polylineLength(line) || 1
  const accAt: number[] = []
  const lens: number[] = []
  const grid = new Map<number, number[]>()
  let acc = 0
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i]
    const b = line[i + 1]
    const l = Math.hypot(b.x - a.x, b.y - a.y)
    accAt.push(acc)
    lens.push(l)
    acc += l
    const x0 = Math.floor((Math.min(a.x, b.x) - reach - 1) / CELL), x1 = Math.floor((Math.max(a.x, b.x) + reach + 1) / CELL)
    const y0 = Math.floor((Math.min(a.y, b.y) - reach - 1) / CELL), y1 = Math.floor((Math.max(a.y, b.y) + reach + 1) / CELL)
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const k = cx * 100003 + cy
        const cell = grid.get(k)
        if (cell) cell.push(i)
        else grid.set(k, [i])
      }
    }
  }
  return (p) => {
    const cell = grid.get(Math.floor(p.x / CELL) * 100003 + Math.floor(p.y / CELL))
    if (!cell) return null
    let best = Infinity
    let bestT = 0
    for (const i of cell) {
      const a = line[i]
      const b = line[i + 1]
      const abx = b.x - a.x
      const aby = b.y - a.y
      const l = lens[i]
      const f = clamp(0, 1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / (l * l || 1))
      const d = Math.hypot(p.x - (a.x + f * abx), p.y - (a.y + f * aby))
      if (d < best) { best = d; bestT = (accAt[i] + f * l) / total }
    }
    return best < reach ? { dist: best, t: bestT } : null
  }
}

export function cutStreetsAtGround(streets: Road[], highway: Road, segments: HighwaySegment[]): Road[] {
  const near = nearestTWithin(highway.points, CUT_DIST)
  const inCut = (p: Pt) => {
    const n = near(p)
    return n !== null && levelAt(segments, n.t) === 'ground'
  }
  return streets.flatMap((street) => {
    const dense: Pt[] = [street.points[0]]
    for (let i = 1; i < street.points.length; i++) {
      const a = street.points[i - 1]
      const b = street.points[i]
      const k = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / DENSE_M)
      for (let s = 1; s <= k; s++) dense.push({ x: a.x + ((b.x - a.x) * s) / k, y: a.y + ((b.y - a.y) * s) / k })
    }
    const cut = dense.map(inCut)
    if (!cut.some(Boolean)) return [street]
    const parts: Pt[][] = []
    let run: Pt[] = []
    dense.forEach((p, i) => {
      if (cut[i]) { if (run.length) parts.push(run); run = [] } else run.push(p)
    })
    if (run.length) parts.push(run)
    return parts
      .filter((pts) => polylineLength(pts) >= MIN_REMNANT_M)
      .map((points, i) => ({ ...street, id: street.id + String.fromCharCode(97 + i), points }))
  })
}

// ------------------------------------------------------------ interchanges

const IC_SPACING_M = 1000
const IC_REACH_M = 500
const IC_TRANSITION_CLEAR_M = 200
const RAMP_ART_M = 120
const RAMP_HWY_M = 200
const RAMP_BULGE_M = 30
const RAMP_POINTS = 10

function ramp(id: string, a: Pt, c: Pt, h: Pt): Road {
  const points: Pt[] = []
  for (let i = 0; i < RAMP_POINTS; i++) {
    const t = i / (RAMP_POINTS - 1)
    const u = 1 - t
    points.push({ x: u * u * a.x + 2 * u * t * c.x + t * t * h.x, y: u * u * a.y + 2 * u * t * c.y + t * t * h.y })
  }
  return { id, class: 'ramp', width: 8, name: null, points }
}

export function buildInterchanges(
  highway: Road, crossings: HighwayCrossing[], roads: Road[], segments: HighwaySegment[],
  terrain: Terrain, sizeM: number,
): { crossings: HighwayCrossing[]; ramps: Road[] } {
  const hp = highway.points
  const len = polylineLength(hp)
  const out = crossings.map((c) => ({ ...c }))
  const chosen: HighwayCrossing[] = []
  const arterials = new Map(roads.filter((r) => r.class === 'arterial').map((r) => [r.id, r]))
  const starts = segments.filter((s) => s.transition).map((s) => s.from * len)
  let target = 0
  const ok = (c: HighwayCrossing) =>
    arterials.has(c.roadId) && !chosen.includes(c)
    && !inWater(terrain, pointAtT(hp, c.at))
    && Math.abs(c.at * len - target) <= IC_REACH_M
    && chosen.every((o) => Math.abs(o.at - c.at) * len >= IC_REACH_M)
    && !starts.some((s) => Math.abs(c.at * len - s) < IC_TRANSITION_CLEAR_M)
  for (let s = IC_SPACING_M; s < len; s += IC_SPACING_M) {
    target = s
    let best: HighwayCrossing | null = null
    for (const c of out) if (ok(c) && (!best || Math.abs(c.at * len - s) < Math.abs(best.at * len - s))) best = c
    if (best) { best.interchange = true; chosen.push(best) }
  }
  const inWindow = (p: Pt) => p.x >= 0 && p.x <= sizeM && p.y >= 0 && p.y <= sizeM
  const ramps: Road[] = []
  for (const c of chosen) {
    const art = arterials.get(c.roadId)!
    const at = pointAtT(hp, c.at)
    const artLen = polylineLength(art.points)
    const artT = nearestT(at, art.points).t
    for (const side of [-1, 1]) {
      const ta = artT + (side * RAMP_ART_M) / artLen
      if (ta < 0 || ta > 1) continue
      const a = pointAtT(art.points, ta)
      const d = Math.hypot(a.x - at.x, a.y - at.y) || 1
      const ctrl = { x: at.x + ((a.x - at.x) / d) * RAMP_BULGE_M, y: at.y + ((a.y - at.y) / d) * RAMP_BULGE_M }
      for (const dir of [-1, 1]) {
        const th = c.at + (dir * RAMP_HWY_M) / len
        if (th < 0 || th > 1) continue
        const h = pointAtT(hp, th)
        if (![a, ctrl, h].every(inWindow)) continue
        ramps.push(ramp('R' + String(ramps.length + 1).padStart(3, '0'), a, ctrl, h))
      }
    }
  }
  return { crossings: out, ramps }
}

// -------------------------------------------------------------- no-build

const STRIP_HALF = HIGHWAY_WIDTH / 2 + 10

export function noBuildStrips(highway: Road, segments: HighwaySegment[]): Pt[][] {
  return segments.filter((s) => s.level !== 'sunken').map((s) => {
    const line = slicePolyline(highway.points, s.from, s.to)
    const off = (sign: number) => line.map((p, i) => {
      const a = line[Math.max(0, i - 1)]
      const b = line[Math.min(line.length - 1, i + 1)]
      const n = normalize({ x: b.x - a.x, y: b.y - a.y })
      return { x: p.x - n.y * STRIP_HALF * sign, y: p.y + n.x * STRIP_HALF * sign }
    })
    return [...off(1), ...off(-1).reverse()]
  })
}
