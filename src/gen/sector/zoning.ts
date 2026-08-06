import type { Pt } from '../geometry'
import { bboxOf, pointInRings } from '../geometry'
import { distToPolyline } from '../terrain/rivers'
import { hashSeed, mulberry32 } from '../rng'
import type { District, SectorParams, Terrain, ZoneType } from '../types'

const SHORE_DIST = 150

/** per-zone irregularity base — overlapping means any zone can land anywhere */
export const ZONE_IRREGULARITY: Record<ZoneType, number> = {
  corp: 0.15, industrial: 0.25, residential: 0.35,
  entertainment: 0.45, docks: 0.55, slum: 0.75,
}

const clamp = (lo: number, hi: number, v: number) => Math.max(lo, Math.min(hi, v))

function isShore(poly: Pt[], terrain: Terrain): boolean {
  // sample the polygon's own vertices plus each edge midpoint
  const points: Pt[] = [...poly]
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    points.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
  }

  for (const p of points) {
    // Check if point is in water
    for (const waterPoly of terrain.water) {
      const rings = waterPoly.map((ring) => ring.map(([x, y]) => ({ x, y })))
      if (pointInRings(p, rings)) return true
    }
    // Check if point is within SHORE_DIST of any water ring
    for (const waterPoly of terrain.water) {
      for (const ring of waterPoly) {
        // Close the ring by appending the first point
        const closedRing = [...ring, ring[0]]
        const pts = closedRing.map(([x, y]) => ({ x, y }))
        const dist = distToPolyline(p, pts)
        if (dist < SHORE_DIST) return true
      }
    }
  }
  return false
}

export function zoneWeights(params: SectorParams, shore: boolean): Record<ZoneType, number> {
  const c = params.corpDominance
  return {
    corp: 0.5 + 3 * c,
    residential: 3 - 1.5 * c,
    slum: 2.5 - 2 * c,
    industrial: 1.5,
    entertainment: 1,
    docks: shore ? 1.5 : 0,
  }
}

export function assignZones(districtPolys: Pt[][], params: SectorParams, terrain: Terrain): District[] {
  const rng = mulberry32(hashSeed(params.seed, 'zones'))
  const withBounds = districtPolys.map((poly) => ({ poly, bounds: bboxOf(poly) }))
  const sorted = withBounds.sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x)
  return sorted.map(({ poly, bounds }, i) => {
    const shore = isShore(poly, terrain)
    const weights = Object.entries(zoneWeights(params, shore)) as Array<[ZoneType, number]>
    const zone = rng.weighted(weights)
    // overlapping zone bases + jitter + global tag bias; floor > 0 — no
    // district is a perfect grid (spec §4.3)
    const irregularity = clamp(
      0.05, 0.95,
      ZONE_IRREGULARITY[zone] + (rng.next() - 0.5) * 0.4 + (params.irregularity - 0.5) * 0.6,
    )
    return {
      id: `D${String(i + 1).padStart(2, '0')}`,
      zone, name: '', bounds, poly, shore, irregularity,
      labelAt: { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 },
    }
  })
}
