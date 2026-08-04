import { bspSplit, type Cut, type Pt, type Rect } from '../geometry'
import { hashSeed, mulberry32, type Rng } from '../rng'
import type { Road, SectorParams, Terrain } from '../types'
import { clipRoadsToLand, inWater, planBridges } from './bridges'

const HIGHWAY_W = 32
const ARTERIAL_W = 18
const STREET_W = 9

function cutToRoad(cut: Cut, id: string, cls: Road['class'], width: number): Road {
  const s = cut.strip
  const points =
    cut.axis === 'x'
      ? [{ x: s.x + s.w / 2, y: s.y }, { x: s.x + s.w / 2, y: s.y + s.h }]
      : [{ x: s.x, y: s.y + s.h / 2 }, { x: s.x + s.w, y: s.y + s.h / 2 }]
  return { id, class: cls, points, width, name: null }
}

// Bounding box of the land multipolygon — the one slab districts lay out
// into. Precise waterline clipping of streets/blocks/buildings is Task 7+.
function landSlabs(terrain: Terrain, sizeM: number): Rect[] {
  const sector: Rect = { x: 0, y: 0, w: sizeM, h: sizeM }
  const rings = terrain.land.flat()
  if (rings.length === 0) return [sector]
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  return [{ x: minX, y: minY, w: maxX - minX, h: maxY - minY }]
}

function splitByHighway(slabs: Rect[], params: SectorParams, rng: Rng, roads: Road[]): Rect[] {
  if (params.size < 3) return slabs
  const out: Rect[] = []
  const landW = Math.max(...slabs.map((s) => s.x + s.w))
  const hx = landW * (1 / 3 + rng.next() / 3)
  let n = 0
  for (const slab of slabs) {
    if (hx > slab.x + 200 && hx < slab.x + slab.w - 200) {
      n += 1
      roads.push({
        id: `H${n}`,
        class: 'highway',
        points: [{ x: hx, y: slab.y }, { x: hx, y: slab.y + slab.h }],
        width: HIGHWAY_W,
        name: null,
      })
      out.push({ ...slab, w: hx - HIGHWAY_W / 2 - slab.x })
      out.push({ ...slab, x: hx + HIGHWAY_W / 2, w: slab.x + slab.w - hx - HIGHWAY_W / 2 })
    } else {
      out.push(slab)
    }
  }
  return out
}

const SNAP_TOL = 20
// A bridge's landing point is deliberately displaced from its host road's line (pushed onto
// land, or re-oriented perpendicular to the river) so it rarely sits within SNAP_TOL of the
// nearby grid it should join. Bridges get a wider search radius to reconnect to that grid.
// ponytail: fixed radius, not a real shortest-path snap; revisit if a landing ever needs to
// reach past a full block to find its street.
const BRIDGE_SNAP_TOL = 150

function nearestOnSegment(p: Pt, a: Pt, b: Pt): { pt: Pt; t: number; d: number } {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const len2 = abx * abx + aby * aby || 1
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2))
  const pt = { x: a.x + t * abx, y: a.y + t * aby }
  return { pt, t, d: Math.hypot(p.x - pt.x, p.y - pt.y) }
}

// BSP cuts meet as T-junctions (one road's endpoint lands mid-span of
// another) rather than sharing an endpoint, so the raw output reads as
// hundreds of disconnected components. Snap each endpoint onto the nearest
// other road within tolerance and splice that point into the host road's
// polyline so the two actually share a vertex.
function snapJunctions(roads: Road[], terrain: Terrain): Road[] {
  const out = roads.map((r) => ({ ...r, points: [...r.points] }))

  const attempt = (i: number, end: number, tol: number): boolean => {
    const p = out[i].points[end]
    let best: { j: number; seg: number; pt: Pt; d: number } | null = null
    for (let j = 0; j < out.length; j++) {
      if (j === i) continue
      const pts = out[j].points
      for (let seg = 0; seg < pts.length - 1; seg++) {
        const { pt, t, d } = nearestOnSegment(p, pts[seg], pts[seg + 1])
        // t near 0/1 is already an endpoint-to-endpoint match; only mid-span touches need
        // splicing. Never snap onto a wet point — an unclipped arterial can legitimately
        // run through water under its bridge.
        if (d < tol && t > 0.02 && t < 0.98 && !inWater(terrain, pt) && (!best || d < best.d))
          best = { j, seg, pt, d }
      }
    }
    if (!best) return false
    out[i].points[end] = best.pt
    out[best.j].points.splice(best.seg + 1, 0, best.pt)
    return true
  }

  // pass 1: tight tolerance for ordinary T-junctions; bridges get the wide radius
  // immediately since their landing point is deliberately displaced from the host
  // road's line (pushed onto land, or re-oriented perpendicular to the river).
  for (let i = 0; i < out.length; i++) {
    const tol = out[i].bridge ? BRIDGE_SNAP_TOL : SNAP_TOL
    for (const end of [0, out[i].points.length - 1]) attempt(i, end, tol)
  }

  // pass 2: rescue anything still fully isolated (no point of this road within tol of any
  // other road's line) — e.g. a water-clipped street fragment whose only neighbor was
  // dropped entirely — with the same wide radius.
  const isIsolated = (i: number): boolean =>
    out[i].points.every((p) => {
      for (let j = 0; j < out.length; j++) {
        if (j === i) continue
        const pts = out[j].points
        for (let seg = 0; seg < pts.length - 1; seg++)
          if (nearestOnSegment(p, pts[seg], pts[seg + 1]).d < SNAP_TOL) return false
      }
      return true
    })
  for (let i = 0; i < out.length; i++) {
    if (out[i].bridge || !isIsolated(i)) continue
    attempt(i, 0, BRIDGE_SNAP_TOL)
  }

  return out
}

export function layoutRoads(
  params: SectorParams,
  terrain: Terrain,
  sizeM: number,
): { roads: Road[]; districtRects: Rect[]; blocksByDistrict: Rect[][] } {
  const rng = mulberry32(hashSeed(params.seed, 'roads'))
  const roads: Road[] = []

  const slabs = splitByHighway(landSlabs(terrain, sizeM), params, rng, roads)

  const districtRects: Rect[] = []
  let a = 0
  for (const slab of slabs) {
    const { cells, cuts } = bspSplit(slab, { minCell: 500, gap: ARTERIAL_W, jitter: 0.18, rng })
    for (const cut of cuts) {
      a += 1
      roads.push(cutToRoad(cut, `A${String(a).padStart(2, '0')}`, 'arterial', ARTERIAL_W))
    }
    districtRects.push(...cells)
  }

  const streetCell = 160 - params.density * 70
  const blocksByDistrict: Rect[][] = []
  let s = 0
  for (const district of districtRects) {
    const { cells, cuts } = bspSplit(district, { minCell: streetCell, gap: STREET_W, jitter: 0.2, rng })
    for (const cut of cuts) {
      s += 1
      roads.push(cutToRoad(cut, `S${String(s).padStart(3, '0')}`, 'street', STREET_W))
    }
    blocksByDistrict.push(cells)
  }

  const grounded = clipRoadsToLand(roads, terrain)
  const bridges = planBridges(grounded, terrain)
  return { roads: snapJunctions([...grounded, ...bridges], terrain), districtRects, blocksByDistrict }
}
