import { bboxOf, bspSplit, pointInRings, ringArea, ringCentroid, rotatePt, type Pt } from '../geometry'
import { generateName } from '../names/names'
import { getPack } from '../names/packs'
import { hashSeed, mulberry32 } from '../rng'
import {
  assignHighwayLevels, buildInterchanges, cutStreetsAtGround, highwayCrossings, noBuildStrips,
} from '../streets/highway'
import {
  buildPlanarGraph, clipFacesToLand, facesOf, dropSlivers, pruneDanglers, windowRing,
} from '../streets/graph'
import { RoadIndex, endKey, pruneDangling } from '../streets/trace'
import { distToPolyline } from '../terrain/rivers'
import { SIDEWALK, clipSegmentToRing, corridorRects, fillLots, insetRing, longestEdgeAngle } from '../streets/lots'
import { sampleTerrain } from '../terrain'
import { HIGHWAY_WIDTH } from '../streets/highway'
import { GENERATOR_VERSION, type Block, type District, type Road, type SectorModel, type SectorParams, type Terrain } from '../types'
import { placePiers } from './piers'
import { placePois } from './pois'
import { dryRuns, inWater, markWetSpans } from './bridges'
import { traceRoads } from './streets'
import { assignZones } from './zoning'

/**
 * Districts whose blocks all drowned to waterline clipping have nothing to
 * anchor a label to — drop them (ids simply gap; they're identifiers, not
 * indices — nothing downstream indexes by array position). Survivors get
 * labelAt: the area-weighted centroid of their surviving blocks, so the
 * label sits over land even when the district's bounds rect is mostly sea.
 */
export function deriveDistricts(districts: District[], blocks: Block[]): District[] {
  return districts.flatMap((d) => {
    const dBlocks = blocks.filter((b) => b.districtId === d.id)
    if (dBlocks.length === 0) return []
    let sx = 0, sy = 0, sArea = 0
    for (const b of dBlocks) {
      const area = Math.abs(ringArea(b.footprint))
      const c = ringCentroid(b.footprint)
      sx += c.x * area
      sy += c.y * area
      sArea += area
    }
    return [{ ...d, labelAt: { x: sx / sArea, y: sy / sArea } }]
  })
}

type Face = { poly: Pt[]; footprint: Pt[] }

/** roads → cleaned faces clipped to land (dangling stubs pruned, slivers dropped) */
function facesFor(roads: Road[], boundaries: Pt[][], terrain: Terrain): Face[] {
  const g = pruneDanglers(buildPlanarGraph(roads, boundaries))
  return clipFacesToLand(dropSlivers(facesOf(g)), terrain)
}

const FRONTAGE_M = HIGHWAY_WIDTH / 2 + 16
const HIGHWAY_NEAR_M = HIGHWAY_WIDTH / 2 + 12

/** where segments a-b and c-d cross, or null */
function segCross(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const den = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x)
  if (Math.abs(den) < 1e-9) return null
  const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / den
  const u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / den
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) } : null
}

/**
 * The highway never anchors a street, so a face bounded by it gets a frontage street (the highway-side
 * edges offset inward by FRONTAGE_M) and every cut that would end on the highway stops on that instead.
 */
function frontageOf(f: Face, highway: Road): Array<[Pt, Pt]> {
  const out: Array<[Pt, Pt]> = []
  const ring = f.footprint
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length]
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    if ([a, b, mid].some((p) => distToPolyline(p, highway.points) > 6)) continue
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
    const u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len }
    let n = { x: -u.y, y: u.x }
    if (!pointInRings({ x: mid.x + n.x, y: mid.y + n.y }, [ring])) n = { x: -n.x, y: -n.y }
    const o = (p: Pt, k: number) => ({ x: p.x + n.x * FRONTAGE_M + u.x * k, y: p.y + n.y * FRONTAGE_M + u.y * k })
    out.push(...clipSegmentToRing(o(a, -60), o(b, 60), ring))
  }
  return out
}

const MAX_BLOCK_M2 = 60000
const INFILL_NEAR_M = 150
const INFILL_PASSES = 3

/**
 * Safety net for voids the tracer leaves: every face over MAX_BLOCK_M2 of LAND (water sampled out; skipped when its centroid is
 * within INFILL_NEAR_M of the window edge) is BSP-split into ~100 m cells; the cut
 * centrelines, clipped to the face, become ordinary street-class roads (ids continue the S counter).
 * A cut ending on the highway is dropped (a street never ends there). Only the split face is re-faced (its own ring is the boundary), and a piece still too big goes
 * round again, so the cost stays local instead of re-running the whole planar graph.
 */
function infillFaces(faces: Face[], roads: Road[], others: Road[], highway: Road | undefined, terrain: Terrain, sizeM: number, centres: Pt[], cores: Pt[][]): { faces: Face[]; infill: Road[]; dropped: Set<string> } {
  const dropped = new Set<string>()
  let next = Math.max(0, ...roads.map((r) => Number(/^S(\d+)/.exec(r.id)?.[1] ?? 0)))
  const rng = mulberry32(hashSeed(terrain.metroSeed, 'infill'))
  const infill: Road[] = []
  // ponytail: land area on a 20 m sample grid (called only for faces over MAX_BLOCK_M2 raw), so +-1 % noise at the threshold
  const landM2 = (ring: Pt[]) => {
    const b = bboxOf(ring)
    let land = 0
    for (let x = b.x; x < b.x + b.w; x += 20) for (let y = b.y; y < b.y + b.h; y += 20) {
      const s = { x: x + 10, y: y + 10 }
      if (pointInRings(s, [ring]) && !inWater(terrain, s)) land += 400
    }
    return land
  }
  const tooBig = (f: Face) => {
    if (Math.abs(ringArea(f.footprint)) <= MAX_BLOCK_M2) return false
    // a face holding an arcology / megablock centre is the landmark's ground: nothing is split there
    if (centres.some((c) => pointInRings(c, [f.footprint]))) return false
    const c = ringCentroid(f.footprint)
    if (Math.min(c.x, c.y, sizeM - c.x, sizeM - c.y) < INFILL_NEAR_M) return false
    return landM2(f.footprint) > MAX_BLOCK_M2
  }
  let work = faces
  for (let pass = 0; pass < INFILL_PASSES; pass++) {
    const out: Face[] = []
    let split = false
    for (const f of work) {
      if (!tooBig(f)) { out.push(f); continue }
      const ring = insetRing(f.footprint, SIDEWALK) ?? f.footprint
      const theta = longestEdgeAngle(f.footprint)
      const ctr = ringCentroid(ring)
      const { cuts } = bspSplit(bboxOf(ring.map((p) => rotatePt(p, -theta, ctr))), { minCell: 100, gap: 9, jitter: 0.25, rng })
      const pieces: Road[] = []
      const gaps: Pt[][] = []
      // a face that only overlaps a core keeps its split, minus the cuts that would run through the core
      const inCore = (p: Pt, q: Pt) => [0, 0.25, 0.5, 0.75, 1].some((t) => cores.some((core) => pointInRings({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t }, [core])))
      const add = (p: Pt, q: Pt) => {
        if (inCore(p, q)) return
        next += 1
        pieces.push({ id: `S${String(next).padStart(3, '0')}`, class: 'street', points: [p, q], width: 9, name: null })
      }
      const frontage = highway ? frontageOf(f, highway) : []
      for (const [p, q] of frontage) add(p, q)
      const nearHw = (e: Pt) => !!highway && distToPolyline(e, highway.points) <= HIGHWAY_NEAR_M
      for (const { axis, strip } of cuts) {
        const [a, b] = axis === 'x'
          ? [{ x: strip.x + strip.w / 2, y: strip.y }, { x: strip.x + strip.w / 2, y: strip.y + strip.h }]
          : [{ x: strip.x, y: strip.y + strip.h / 2 }, { x: strip.x + strip.w, y: strip.y + strip.h / 2 }]
        for (const [u, v] of clipSegmentToRing(rotatePt(a, theta, ctr), rotatePt(b, theta, ctr), f.footprint)) {
          const runs = dryRuns(terrain, u, v)
          // the wet stretches between runs are not roads but still divide the face, so a lake never joins its two shores
          let from = u
          for (const [r0, r1] of runs) { if (Math.hypot(r0.x - from.x, r0.y - from.y) > 1) gaps.push([from, r0]); from = r1 }
          if (Math.hypot(v.x - from.x, v.y - from.y) > 1) gaps.push([from, v])
          for (const [p0, q0] of runs) {
          let p = p0, q = q0
          // stop a cut that would end on the highway at the frontage street; none there: drop it
          let ok = true
          for (const end of [0, 1]) {
            const e = end ? q : p, o = end ? p : q
            if (!nearHw(e)) continue
            const hit = frontage.map(([c, d]) => segCross(o, e, c, d)).find((x) => x !== null)
            if (hit) { if (end) q = hit; else p = hit } else ok = false
          }
          if (ok && Math.hypot(q.x - p.x, q.y - p.y) > 5) add(p, q)
          }
        }
      }
      // the BSP box is the ring's bbox, so on a concave face a cut can stop short of the ring: run a loose end on
      // until it meets the ring or another piece (nearest hit within 300 m)
      const reach = (e: Pt, from: Pt, self: Road): Pt | null => {
        const len = Math.hypot(e.x - from.x, e.y - from.y) || 1
        const far = { x: e.x + ((e.x - from.x) / len) * 300, y: e.y + ((e.y - from.y) / len) * 300 }
        let best: Pt | null = null, bestD = Infinity
        const consider = (c: Pt, d: Pt, onRing: boolean) => {
          const h = segCross(e, far, c, d)
          const dist = h ? Math.hypot(h.x - e.x, h.y - e.y) : Infinity
          if (dist > 0.5 && dist < bestD && !(onRing && nearHw(h!))) { best = h; bestD = dist }
        }
        for (let i = 0; i < f.footprint.length; i++) consider(f.footprint[i], f.footprint[(i + 1) % f.footprint.length], true)
        for (const o of pieces) if (o !== self) consider(o.points[0], o.points[1], false)
        return best
      }
      // a cut trimmed at the shore ends up to 10 m short of the water: that end is anchored (the shore is the block edge)
      const shore = (e: Pt) => [0, 1, 2, 3, 4, 5, 6, 7].some((k) => inWater(terrain, { x: e.x + 12 * Math.cos((k * Math.PI) / 4), y: e.y + 12 * Math.sin((k * Math.PI) / 4) }))
      const looseAt = (e: Pt, self: Road) => !shore(e) && !pieces.some((o) => o !== self && distToPolyline(e, o.points) <= 8) && distToPolyline(e, [...f.footprint, f.footprint[0]]) > 6
      for (const r of pieces) {
        for (const end of [0, 1]) {
          const e = r.points[end], o = r.points[1 - end]
          if (!looseAt(e, r)) continue
          const hit = reach(e, o, r)
          if (hit) r.points[end] = hit
        }
      }
      // weld each end that stops within 8 m of another piece onto it exactly (the highway test wants <= 6 m)
      for (const r of pieces) {
        for (const end of [0, 1]) {
          const e = r.points[end]
          let best: Pt | null = null, bd = 8
          for (const o of pieces) {
            if (o === r) continue
            const [c, d] = o.points
            const l2 = (d.x - c.x) ** 2 + (d.y - c.y) ** 2 || 1
            const t = Math.max(0, Math.min(1, ((e.x - c.x) * (d.x - c.x) + (e.y - c.y) * (d.y - c.y)) / l2))
            const q = { x: c.x + t * (d.x - c.x), y: c.y + t * (d.y - c.y) }
            const dist = Math.hypot(q.x - e.x, q.y - e.y)
            if (dist < bd) { bd = dist; best = q }
          }
          if (best) r.points[end] = best
        }
      }
      // loose ends were run on above: one that now reaches into a core goes
      for (let i = pieces.length - 1; i >= 0; i--) if (inCore(pieces[i].points[0], pieces[i].points[1])) pieces.splice(i, 1)
      // a piece must be anchored at both ends (another piece, or the face ring away from the highway); dead ends go
      const closed = [...f.footprint, f.footprint[0]]
      const anchored = (e: Pt, self: Road) => shore(e) || (!(highway && distToPolyline(e, highway.points) <= 8) && distToPolyline(e, closed) <= 6)
        || pieces.some((o) => o !== self && distToPolyline(e, o.points) <= 8)
      for (let again = true; again;) {
        again = false
        for (let i = pieces.length - 1; i >= 0; i--) {
          const r = pieces[i]
          if (!anchored(r.points[0], r) || !anchored(r.points[1], r)) { pieces.splice(i, 1); again = true }
        }
      }
      // the sub-faces lie inside f.footprint, which is already land: no land clipping needed
      const sub: Face[] = pieces.length ? dropSlivers(facesOf(pruneDanglers(buildPlanarGraph(pieces, [f.footprint, ...gaps])))).map((poly) => ({ poly, footprint: poly })).filter((x) => landM2(x.footprint) > 0) : []
      if (sub.length < 2) { out.push(f); continue }
      infill.push(...pieces)
      // a dead-end street stranded inside the split face would now cross a sub-block: it goes
      for (const r of roads) {
        if (dropped.has(r.id) || r.class !== 'street' || !pointInRings(r.points[Math.floor(r.points.length / 2)], [f.footprint])) continue
        const loose = [r.points[0], r.points[r.points.length - 1]].some((e) => distToPolyline(e, [...f.footprint, f.footprint[0]]) > 6
          && ![...others, ...pieces].some((o) => o.id !== r.id && distToPolyline(e, o.points) <= 6))
        if (loose) dropped.add(r.id)
      }
      out.push(...sub)
      split = true
    }
    work = out
    if (!split) break
  }
  return { faces: work, infill, dropped }
}

const centroidDist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)

/** block -> district by centroid containment, else nearest district centroid */
function toBlocks(faces: Face[], districts: District[]): Block[] {
  if (districts.length === 0) return []
  const centers = districts.map((d) => ringCentroid(d.poly))
  const perDistrict = new Map<string, number>()
  return faces.map((f) => {
    const c = ringCentroid(f.poly)
    let di = districts.findIndex((d) => pointInRings(c, [d.poly]))
    if (di < 0) {
      di = 0
      centers.forEach((dc, k) => { if (centroidDist(c, dc) < centroidDist(c, centers[di])) di = k })
    }
    const districtId = districts[di].id
    const n = (perDistrict.get(districtId) ?? 0) + 1
    perDistrict.set(districtId, n)
    return { id: `B${districtId.slice(1)}${String(n).padStart(2, '0')}`, districtId, poly: f.poly, footprint: f.footprint, style: 'rows', alleys: [], flags: {} }
  })
}

/**
 * A ground-level cut leaves street ends at the corridor edge; the highway never
 * anchors a street, so cut those back to a real junction. Ends outside the
 * corridor were already validated by traceRoads and are kept as they are.
 */
function pruneCutStreets(streets: Road[], arterials: Road[], highway: Road, terrain: Terrain, sizeM: number): Road[] {
  const index = new RoadIndex(200)
  for (const r of [...arterials, ...streets]) index.add(r.id, r.points, r.class)
  const keep = new Set<string>()
  for (const r of streets) {
    for (const p of [r.points[0], r.points[r.points.length - 1]]) {
      if (distToPolyline(p, highway.points) > HIGHWAY_WIDTH / 2 + 10) keep.add(endKey(p))
    }
  }
  return pruneDangling(streets, index, terrain, sizeM, { accept: (c) => c !== 'highway', interiorOnly: true, minLength: 60, keep })
}

export function generateSector(params: SectorParams): SectorModel {
  const sizeM = params.size * 1000
  const pack = getPack(params.pack)

  const terrain = sampleTerrain(params, sizeM)
  const { highway, arterials, streets, arcologies, megablocks } = traceRoads(params, terrain, sizeM)
  const boundaries = [windowRing(sizeM), ...terrain.land.map((poly) => poly[0].map(([x, y]) => ({ x, y })))]

  const districtFaces = facesFor([...(highway ? [highway] : []), ...arterials], boundaries, terrain)
  const districts = assignZones(districtFaces.map((f) => f.poly), params, terrain, [
    ...arcologies.map((a) => ({ at: a.center, zone: 'corp' as const, flag: { arcology: a.id } })),
    ...megablocks.map((m) => ({ at: m.center, zone: 'slum' as const, flag: { megablock: m.id } })),
  ])

  // highway levels decide where streets stop at the ground-level highway
  const levelRng = mulberry32(hashSeed(params.seed, 'highway-levels'))
  const segments = highway ? assignHighwayLevels(highway, districts, terrain, levelRng) : []
  const minorAll = highway ? pruneCutStreets(cutStreetsAtGround(streets, highway, segments), arterials, highway, terrain, sizeM) : streets
  const crossings = highway ? highwayCrossings(highway, [...arterials, ...minorAll], segments, levelRng) : []
  const { crossings: finalCrossings, ramps } = highway
    ? buildInterchanges(highway, crossings, arterials, segments, terrain, sizeM)
    : { crossings, ramps: [] as Road[] }
  const hw = highway ? [{ ...highway, segments, crossings: finalCrossings }] : []

  const { faces, infill, dropped } = infillFaces(facesFor([...hw, ...arterials, ...minorAll], boundaries, terrain), minorAll, arterials, highway, terrain, sizeM, [...arcologies, ...megablocks].map((l) => l.center), megablocks.map((k) => k.core))
  const minor = minorAll.filter((r) => !dropped.has(r.id))
  const rawBlocks = toBlocks(faces, districts)

  const roads = markWetSpans([...hw, ...arterials, ...minor, ...infill, ...ramps], terrain)

  const nameRng = mulberry32(hashSeed(params.seed, 'names'))
  const namedDistricts = districts.map((d) => ({
    ...d,
    name: generateName(nameRng.pick(pack.districtPatterns), pack.tables, nameRng),
  }))
  // one name per arterial/highway, shared by every piece markWetSpans split it into
  const roadNames = new Map<string, string>()
  const namedRoads = roads.map((r) => {
    if (r.class === 'street' || r.class === 'ramp') return r
    const base = r.id.split('-')[0]
    if (!roadNames.has(base)) roadNames.set(base, generateName(nameRng.pick(pack.streetPatterns), pack.tables, nameRng))
    return { ...r, name: roadNames.get(base)! }
  })

  // last draws on the names stream, so district and street names stay as they were
  const namedArcologies = arcologies.map((a) => ({ ...a, name: generateName(nameRng.pick(pack.arcologyPatternsByDesign[a.design] ?? pack.arcologyPatterns), pack.tables, nameRng) }))
  const namedMegablocks = megablocks.map((m) => ({ ...m, name: generateName(nameRng.pick(pack.megablockPatterns), pack.tables, nameRng) }))

  const { buildings, blocks, megablockFootprints } = fillLots(namedDistricts, rawBlocks, params, terrain, [
    ...(highway ? noBuildStrips(highway, segments) : []),
    ...roads.filter((r) => r.class !== 'highway').flatMap((r) => corridorRects(r.points, r.width / 2 + SIDEWALK)),
  ], undefined, { arcologies, megablocks })
  const megablocksOut = namedMegablocks.map((m) => ({ ...m, footprint: megablockFootprints.get(m.id) ?? [] }))
  const finalDistricts = deriveDistricts(namedDistricts, blocks)
  const pois = placePois(finalDistricts, buildings, pack, params, { arcologies: namedArcologies, megablocks: megablocksOut })
  const piers = placePiers(finalDistricts, terrain, params)

  return {
    meta: {
      seed: params.seed,
      generatorVersion: GENERATOR_VERSION,
      params,
      sizeM,
      metroSeed: terrain.metroSeed,
    },
    terrain,
    roads: namedRoads,
    districts: finalDistricts,
    blocks,
    buildings,
    pois,
    piers,
    arcologies: namedArcologies,
    megablocks: megablocksOut,
  }
}
