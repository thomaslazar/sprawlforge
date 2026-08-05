import type { Pt, Rect } from '../geometry'
import { pointInRings } from '../geometry'
import { distToPolyline } from '../terrain/rivers'
import { hashSeed, mulberry32 } from '../rng'
import type { District, SectorParams, Terrain, ZoneType } from '../types'

const SHORE_DIST = 150

function isShore(rect: Rect, terrain: Terrain): boolean {
  // 8 boundary points: 4 corners + 4 edge midpoints
  const points: Pt[] = [
    // corners
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.w, y: rect.y },
    { x: rect.x, y: rect.y + rect.h },
    { x: rect.x + rect.w, y: rect.y + rect.h },
    // edge midpoints
    { x: rect.x + rect.w / 2, y: rect.y },
    { x: rect.x + rect.w / 2, y: rect.y + rect.h },
    { x: rect.x, y: rect.y + rect.h / 2 },
    { x: rect.x + rect.w, y: rect.y + rect.h / 2 },
  ]

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

export function assignZones(districtRects: Rect[], params: SectorParams, terrain: Terrain): District[] {
  const rng = mulberry32(hashSeed(params.seed, 'zones'))
  const sorted = [...districtRects].sort((a, b) => a.y - b.y || a.x - b.x)
  return sorted.map((bounds, i) => {
    const shore = isShore(bounds, terrain)
    const weights = Object.entries(zoneWeights(params, shore)) as Array<[ZoneType, number]>
    return {
      id: `D${String(i + 1).padStart(2, '0')}`,
      zone: rng.weighted(weights),
      name: '',
      bounds,
      shore,
      // placeholder until generate.ts recomputes it from surviving blocks
      labelAt: { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 },
    }
  })
}
