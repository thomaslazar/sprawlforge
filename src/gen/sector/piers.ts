import { pointInRings, ringArea, type Pt } from '../geometry'
import { hashSeed, mulberry32 } from '../rng'
import type { District, Pier, SectorParams, Terrain } from '../types'

const EDGE_STEP = 30
const ROOT_WATER_TOL = 30
const PROBE_DIST = 40
const PIER_WIDTH = 6
const MIN_WATER_BODY = 20000
const MAX_PIERS_PER_DISTRICT = 2

// compass probes, clockwise from east
const COMPASS: Pt[] = [0, 45, 90, 135, 180, 225, 270, 315].map((deg) => {
  const r = (deg * Math.PI) / 180
  return { x: Math.cos(r), y: Math.sin(r) }
})

const toPt = ([x, y]: [number, number]): Pt => ({ x, y })

function nearestOnSegment(p: Pt, a: Pt, b: Pt): number {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const len2 = abx * abx + aby * aby || 1
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2))
  return Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby))
}

function distToRings(p: Pt, rings: Pt[][]): number {
  let best = Infinity
  for (const ring of rings)
    for (let i = 0; i < ring.length; i++)
      best = Math.min(best, nearestOnSegment(p, ring[i], ring[(i + 1) % ring.length]))
  return best
}

/** every 30 m sample along a rect's perimeter */
function edgeSamples(r: District['bounds'], step: number): Pt[] {
  const pts: Pt[] = []
  for (let x = r.x; x <= r.x + r.w; x += step) {
    pts.push({ x, y: r.y }, { x, y: r.y + r.h })
  }
  for (let y = r.y; y <= r.y + r.h; y += step) {
    pts.push({ x: r.x, y }, { x: r.x + r.w, y })
  }
  return pts
}

export function placePiers(districts: District[], terrain: Terrain, params: SectorParams): Pier[] {
  if (!params.piers) return []

  const waterPolys = terrain.water.map((poly) => poly.map((ring) => ring.map(toPt)))
  const landPolys = terrain.land.map((poly) => poly.map((ring) => ring.map(toPt)))
  // per-polygon |area|, computed once (rejects piers into puddles)
  const waterAreas = terrain.water.map((poly) => Math.abs(ringArea(poly[0].map(toPt))))

  const isLand = (p: Pt): boolean => landPolys.some((rings) => pointInRings(p, rings))
  const waterIndexAt = (p: Pt): number => waterPolys.findIndex((rings) => pointInRings(p, rings))
  const distToWater = (p: Pt): number =>
    Math.min(Infinity, ...waterPolys.map((rings) => distToRings(p, rings)))

  const rng = mulberry32(hashSeed(params.seed, 'piers'))
  const piers: Pier[] = []
  let n = 0

  const tooCloseToExisting = (a: Pt, b: Pt): boolean =>
    piers.some((existing) => {
      const [ex0, ex1] = existing.points
      const minX = Math.min(ex0.x, ex1.x) - PROBE_DIST
      const maxX = Math.max(ex0.x, ex1.x) + PROBE_DIST
      const minY = Math.min(ex0.y, ex1.y) - PROBE_DIST
      const maxY = Math.max(ex0.y, ex1.y) + PROBE_DIST
      const inBox = (p: Pt) => p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY
      return inBox(a) || inBox(b)
    })

  for (const district of districts) {
    if (district.zone !== 'docks' || !district.shore) continue
    let placedHere = 0
    for (const root of edgeSamples(district.bounds, EDGE_STEP)) {
      if (placedHere >= MAX_PIERS_PER_DISTRICT) break
      if (!isLand(root) || distToWater(root) > ROOT_WATER_TOL) continue

      const dir = COMPASS.find((d) => waterIndexAt({ x: root.x + d.x * PROBE_DIST, y: root.y + d.y * PROBE_DIST }) >= 0)
      if (!dir) continue

      const length = rng.int(40, 80)
      const end = { x: root.x + dir.x * length, y: root.y + dir.y * length }

      if (isLand(end)) continue
      if (tooCloseToExisting(root, end)) continue
      const wi = waterIndexAt(end)
      if (wi < 0 || waterAreas[wi] < MIN_WATER_BODY) continue

      n += 1
      piers.push({ id: `PR${String(n).padStart(2, '0')}`, points: [root, end], width: PIER_WIDTH })
      placedHere += 1
    }
  }

  return piers
}
