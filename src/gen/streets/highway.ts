import { inWindow, onWindowEdge, pointAtT, pointInRings, polylineLength, segHit, segmentCrossesPolyline, simplifyPolyline, slicePolyline, type Pt } from '../geometry'
import { hashSeed, mulberry32, type Rng } from '../rng'
import { effectiveIrregularity } from '../sector/zoning'
import { inWater } from '../sector/bridges'
import { distToPolyline } from '../terrain/rivers'
import type {
  District, HighwayCrossing, HighwayLevel, HighwaySegment, Road, SectorParams, Terrain, ZoneType,
} from '../types'
import { buildRoadField, type BasisField, type RoadField } from './field'
import { FRONTAGE_ID_PREFIX, MAJOR, courseTangentAt, RoadIndex, measureCorridorWidth, traceStreamline, type TraceOpts } from './trace'

export const HIGHWAY_WIDTH = 32

const AXIS_JITTER = Math.PI / 9 // ± 20°
const ENTRY_ATTEMPTS = 3
const ENTRY_LO = 0.3
const ENTRY_SPAN = 0.4
const SPAN_TOL = 1 // "reaching the opposite edge within 1 m" counts as spanning (R11)
const APPROACH_M = 50
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
      field, 'major', { at, dir, axis: 'major', crossWater: false }, terrain, sizeM, index, bridged ? { ...opts, deckMax: 0 } : opts, rng, irregularityAt,
    )
    if (!seg) return points
    points = points ? points.concat(seg.slice(1)) : seg

    const last = points[points.length - 1]
    if (Math.abs(last[edge.travelCoord] - edge.oppositeValue(sizeM)) <= SPAN_TOL) return points // reached the far edge
    const onSide = last[edge.perpCoord] > 1e-6 && last[edge.perpCoord] < sizeM - 1e-6
    if (!onSide || bridged) return points // exited a side edge, or already used our one bridge (R12)

    const river = terrain.riverSlice
    if (!river) return points // no river: the stop was the sea or a lake

    // R12: the recent approach heading is the last ~50 m (a single step jitters on a bend)
    let back = points.length - 1
    for (let run = 0; back > 0 && run < APPROACH_M; back--) run += Math.hypot(points[back].x - points[back - 1].x, points[back].y - points[back - 1].y)
    const prev = back < points.length - 1 ? points[back] : last
    const heading = normalize({ x: last.x - prev.x, y: last.y - prev.y })
    const tangent = courseTangentAt(river.course, last)
    let normal = { x: -tangent.y, y: tangent.x }
    if (normal.x * heading.x + normal.y * heading.y < 0) normal = { x: -normal.x, y: -normal.y }
    normal = clampAngleTo(heading, normal, BRIDGE_MAX_TURN_FROM_HEADING) // R12

    const width = measureCorridorWidth(terrain, last, normal)
    if (width === null || width > HIGHWAY_DECK_MAX) return points // too wide to bridge — this trace is done

    // R1: a far-bank point computed from an in-window `last` plus a bounded
    // offset can still land fractionally outside — clamp before pushing.
    const farBank = clampToWindow({ x: last.x + normal.x * width, y: last.y + normal.y * width }, sizeM)
    // the chord must cross the river course itself (not a sea inlet or a lake beside it), as an arterial deck must
    if (!segmentCrossesPolyline(last, farBank, river.course)) return points
    points.push(farBank)
    at = farBank
    dir = normal
    bridged = true
  }
}

/** longest river span (m) the highway deck bridges; a wider one is steered along until it narrows */
export const HIGHWAY_DECK_MAX = 350

/** shoreLookahead 300: maxTurn = step / 300 is a 300 m turning radius, and a turn of angle a needs R*tan(a/2) of room (300 m at 90 deg); fitted on seeds, 200 and 250 each leave a test red */
export const HIGHWAY_OPTS: TraceOpts = { ...MAJOR, maxSteps: 2000, maxTurn: MAJOR.step / 300, bridgeRivers: false, stopAtSingularity: false, shoreLookahead: 300, deckMax: HIGHWAY_DECK_MAX }

export function traceHighway(
  params: SectorParams, terrain: Terrain, sizeM: number,
): { road: Road; field: RoadField } {
  const rng = mulberry32(hashSeed(params.seed, 'highway'))
  const irregularityAt = effectiveIrregularity(params)
  const opts = HIGHWAY_OPTS

  let best: Pt[] | null = null
  let bestField: RoadField | null = null
  // R11: longest attempt that ends on an adjacent edge, used when no opposite-edge pair spans
  let adjacent: Pt[] | null = null
  let adjacentField: RoadField | null = null
  let spanned = false
  let turned: Pt[] | null = null
  let turnedField: RoadField | null = null

  edgeLoop: for (const edge of EDGES) {
    const axis = edge.axisBase + (rng.next() * 2 - 1) * AXIS_JITTER
    const field = buildRoadField(params, terrain, sizeM, [spineBasis(axis)])

    for (let attempt = 0; attempt < ENTRY_ATTEMPTS; attempt++) {
      const pos = sizeM * (ENTRY_LO + ENTRY_SPAN * rng.next())
      const seedAt = edge.seedAt(pos, sizeM)
      if (inWater(terrain, seedAt)) continue // R11: skip a wet entry point

      const candidate = traceFromEdge(field, edge, seedAt, terrain, sizeM, opts, rng, irregularityAt)
      if (!candidate) continue
      const last = candidate[candidate.length - 1]
      // a hairpin (ends back on its entry edge) ranks below every other attempt
      const hairpin = Math.abs(last[edge.travelCoord] - (sizeM - edge.oppositeValue(sizeM))) <= SPAN_TOL
      if (hairpin) {
        if (!turned || polylineLength(candidate) > polylineLength(turned)) { turned = candidate; turnedField = field }
        continue
      }
      if (!best || polylineLength(candidate) > polylineLength(best)) { best = candidate; bestField = field }

      const p = last[edge.perpCoord]
      if ((p <= SPAN_TOL || p >= sizeM - SPAN_TOL) && (!adjacent || polylineLength(candidate) > polylineLength(adjacent))) {
        adjacent = candidate
        adjacentField = field
      }
      if (Math.abs(last[edge.travelCoord] - edge.oppositeValue(sizeM)) <= SPAN_TOL) {
        best = candidate
        bestField = field
        spanned = true
        break edgeLoop // R11: the first edge with a spanning trace wins
      }
    }
  }

  if (!spanned && adjacent) { best = adjacent; bestField = adjacentField }
  if (!best) { best = turned; bestField = turnedField }

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
        // a road that merely ends on the highway (T-junction, or an end inside the highway strip) does not cross it
        const rp = road.points
        const hitPt = f === null ? null : { x: hp[j].x + f * (hp[j + 1].x - hp[j].x), y: hp[j].y + f * (hp[j + 1].y - hp[j].y) }
        const atEnd = hitPt && [rp[0], rp[rp.length - 1]].some((e) => Math.hypot(e.x - hitPt.x, e.y - hitPt.y) < HIGHWAY_WIDTH / 2 + 6)
        if (f !== null && !atEnd) {
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
const IC_CONTINUE_M = 300
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
  /** the four ramps' [arterial end, control, highway end], or null unless all four fit */
  const rampTriples = (c: HighwayCrossing): Array<[Pt, Pt, Pt]> | null => {
    const art = arterials.get(c.roadId)!
    const at = pointAtT(hp, c.at)
    const artLen = polylineLength(art.points)
    const artT = nearestT(at, art.points).t
    const res: Array<[Pt, Pt, Pt]> = []
    for (const side of [-1, 1]) {
      const ta = artT + (side * RAMP_ART_M) / artLen
      if (ta < 0 || ta > 1) return null
      const a = pointAtT(art.points, ta)
      const d = Math.hypot(a.x - at.x, a.y - at.y) || 1
      const ctrl = { x: at.x + ((a.x - at.x) / d) * RAMP_BULGE_M, y: at.y + ((a.y - at.y) / d) * RAMP_BULGE_M }
      for (const dir of [-1, 1]) {
        const th = c.at + (dir * RAMP_HWY_M) / len
        if (th < 0 || th > 1) return null
        const h = pointAtT(hp, th)
        if (![a, ctrl, h].every((q) => inWindow(q, sizeM))) return null
        // a ramp never runs over water (an interchange beside a highway bridge)
        if (ramp('', a, ctrl, h).points.some((q) => inWater(terrain, q))) return null
        res.push([a, ctrl, h])
      }
    }
    return res
  }
  // ramps fold into loops when the arterial crosses at a shallow angle
  const squareEnough = (c: HighwayCrossing) => {
    const at = pointAtT(hp, c.at)
    const h = courseTangentAt(hp, at)
    const a = courseTangentAt(arterials.get(c.roadId)!.points, at)
    return Math.abs(h.x * a.x + h.y * a.y) <= Math.cos(Math.PI / 4)
  }
  /** both sides run >= IC_CONTINUE_M of arc from the crossing, or meet another arterial within it */
  const continues = (c: HighwayCrossing) => {
    const art = arterials.get(c.roadId)!
    const artLen = polylineLength(art.points)
    const s = nearestT(pointAtT(hp, c.at), art.points).t * artLen
    const others = [...arterials.values()].filter((o) => o !== art)
    return [s, artLen - s].every((arc) => {
      if (arc >= IC_CONTINUE_M) return true
      const end = pointAtT(art.points, arc === s ? 0 : 1)
      return others.some((o) => distToPolyline(end, o.points) <= 6)
    })
  }
  const ok = (c: HighwayCrossing) =>
    arterials.has(c.roadId) && !chosen.includes(c) && squareEnough(c) && continues(c)
    && !inWater(terrain, pointAtT(hp, c.at))
    && Math.abs(c.at * len - target) <= IC_REACH_M
    && chosen.every((o) => Math.abs(o.at - c.at) * len >= IC_REACH_M)
    && !starts.some((s) => Math.abs(c.at * len - s) < IC_TRANSITION_CLEAR_M)
    && rampTriples(c) !== null
  for (let s = IC_SPACING_M; s < len; s += IC_SPACING_M) {
    target = s
    let best: HighwayCrossing | null = null
    for (const c of out) if (ok(c) && (!best || Math.abs(c.at * len - s) < Math.abs(best.at * len - s))) best = c
    if (best) { best.interchange = true; chosen.push(best) }
  }
  const ramps: Road[] = []
  for (const c of chosen) {
    for (const [a, ctrl, h] of rampTriples(c)!) {
      ramps.push(ramp('R' + String(ramps.length + 1).padStart(3, '0'), a, ctrl, h))
    }
  }
  return { crossings: out, ramps }
}

// -------------------------------------------------------------- no-build

export const STRIP_HALF = HIGHWAY_WIDTH / 2 + 10

export function noBuildStrips(highway: Road, segments: HighwaySegment[]): Pt[][] {
  // consecutive non-sunken segments merge into one run, so per-segment caps leave no zero-width spikes in lots
  const runs: Array<{ from: number; to: number }> = []
  for (const s of segments) {
    if (s.level === 'sunken') continue
    const last = runs[runs.length - 1]
    if (last && Math.abs(last.to - s.from) < 1e-9) last.to = s.to
    else runs.push({ from: s.from, to: s.to })
  }
  return runs.map((s) => {
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

// -------------------------------------------------------------- frontage

export { FRONTAGE_ID_PREFIX }
export const FRONTAGE_OFF = STRIP_HALF + 26
const FRONTAGE_WIDTH = 9
const FRONTAGE_MIN_M = 60
const EXTEND_N = 6

/** the runs of `pts` (dense samples) satisfying `keep`, ends bisected onto the boundary, each >= FRONTAGE_MIN_M long and simplified to 1 m */
function cutPieces(pts: Pt[], keep: (p: Pt) => boolean): Pt[][] {
  const onEdge = (good: Pt, bad: Pt): Pt => {
    let lo = good
    let hi = bad
    for (let i = 0; i < 5; i++) {
      const mid = { x: (lo.x + hi.x) / 2, y: (lo.y + hi.y) / 2 }
      if (keep(mid)) lo = mid
      else hi = mid
    }
    return lo
  }
  // a cut that runs against the line's own direction (a fold) is not refined
  const ahead = (from: Pt, to: Pt, ref: Pt | undefined) => !ref || (to.x - from.x) * (from.x - ref.x) + (to.y - from.y) * (from.y - ref.y) > 0
  const runs: Pt[][] = [[]]
  pts.forEach((p, i) => {
    if (keep(p)) {
      if (!runs.at(-1)!.length && i > 0 && ahead(p, pts[i - 1], pts[i + 1])) runs.at(-1)!.push(onEdge(p, pts[i - 1]))
      runs.at(-1)!.push(p)
    } else if (runs.at(-1)!.length) {
      if (ahead(pts[i - 1], p, pts[i - 2])) runs.at(-1)!.push(onEdge(pts[i - 1], p))
      runs.push([])
    }
  })
  return runs.filter((r) => r.length >= 2 && polylineLength(r) >= FRONTAGE_MIN_M).map((r) => simplifyPolyline(r, 1))
}

/**
 * A street offset FRONTAGE_OFF from each side of the whole highway (levels are not known yet, trimFrontage
 * removes the sunken stretches), cut at water, obstacles and the window. ponytail: 10 m sampling, a pond narrower than that is missed.
 */
export function frontageRoads(highway: Road, terrain: Terrain, sizeM: number, obstacles: Pt[][]): Road[] {
  const hp = highway.points
  if (hp.length < 2) return []
  const n0 = Math.max(1, Math.ceil(polylineLength(hp) / SAMPLE_M))
  const core = Array.from({ length: n0 + 1 }, (_, i) => pointAtT(hp, i / n0))
  // run the end tangents on past the window so the offset lines reach the edge instead of stopping short of it
  // (only at an end on the window edge: past a highway that stops at the shore there is nothing to line)
  const ext = (a: Pt, b: Pt) => {
    if (!onWindowEdge(b, sizeM, SPAN_TOL)) return []
    const u = normalize({ x: b.x - a.x, y: b.y - a.y })
    return Array.from({ length: EXTEND_N }, (_, k) => ({ x: b.x + u.x * SAMPLE_M * (k + 1), y: b.y + u.y * SAMPLE_M * (k + 1) }))
  }
  const samples = [...ext(core[1], core[0]).reverse(), ...core, ...ext(core[n0 - 1] ?? core[0], core[n0])]
  const n = samples.length - 1
  // distToPolyline: an offset point folded in on the inside of a sharp highway bend sits closer than FRONTAGE_OFF
  const ok = (p: Pt) => inWindow(p, sizeM) && !inWater(terrain, p) && !pointInRings(p, obstacles)
    && distToPolyline(p, hp) >= FRONTAGE_OFF - 2
  return ([['L', 1], ['R', -1]] as const).flatMap(([tag, sign]) => {
    const off = samples.map((p, i) => {
      const a = samples[Math.max(0, i - 1)]
      const b = samples[Math.min(n, i + 1)]
      const nm = normalize({ x: b.x - a.x, y: b.y - a.y })
      return { x: p.x - nm.y * FRONTAGE_OFF * sign, y: p.y + nm.x * FRONTAGE_OFF * sign }
    })
    // a sample whose step runs against the highway's own direction is a fold at a kink: drop it
    const folded = new Set(off.filter((q, i) => i > 0 && (q.x - off[i - 1].x) * (samples[i].x - samples[i - 1].x) + (q.y - off[i - 1].y) * (samples[i].y - samples[i - 1].y) <= 0))
    return cutPieces(off, (q) => ok(q) && !folded.has(q)).map((points, i): Road => ({
      id: `${FRONTAGE_ID_PREFIX}${i + 1}${tag}`, class: 'street', width: FRONTAGE_WIDTH, name: null, points,
    }))
  })
}

/** drop the frontage stretches whose nearest highway point lies on a sunken segment; split roads get a letter suffix */
export function trimFrontage(frontage: Road[], highway: Road, segments: HighwaySegment[]): Road[] {
  return frontage.flatMap((r) => {
    const dense: Pt[] = [r.points[0]]
    for (let i = 1; i < r.points.length; i++) {
      const a = r.points[i - 1]
      const b = r.points[i]
      const k = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / DENSE_M)
      for (let s = 1; s <= k; s++) dense.push({ x: a.x + ((b.x - a.x) * s) / k, y: a.y + ((b.y - a.y) * s) / k })
    }
    const keep = (p: Pt) => levelAt(segments, nearestT(p, highway.points).t) !== 'sunken'
    if (dense.every(keep)) return [r]
    return cutPieces(dense, keep).map((points, i) => ({ ...r, id: r.id + String.fromCharCode(97 + i), points }))
  })
}
