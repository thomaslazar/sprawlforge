import type { Pt } from '../geometry'
import { hashSeed, mulberry32 } from '../rng'
import { TERRAIN_KINDS, type SectorParams, type TerrainKind, type Water } from '../types'

function bbox(points: Pt[]): { x: number; y: number; w: number; h: number } {
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

// interim: v1 water shapes driven by the v2 terrain param; replaced in the
// terrain-adapter task
export function resolveTerrainKind(params: SectorParams): TerrainKind {
  if (params.terrain !== 'auto') return params.terrain
  return mulberry32(hashSeed(params.seed, 'terrain-kind')).pick(TERRAIN_KINDS)
}

export function genGeography(params: SectorParams, sizeM: number): Water {
  const kind = resolveTerrainKind(params)
  const wantsCoast = kind === 'coastal' || kind === 'bay' || kind === 'estuary' || kind === 'island'
  const wantsRiver = kind === 'river' || kind === 'estuary'
  if (!wantsCoast && !wantsRiver) return { kind: 'none', polygon: [], bounds: null }
  const rng = mulberry32(hashSeed(params.seed, 'geo'))
  const steps = 12
  const step = sizeM / steps

  if (wantsCoast) {
    const baseX = sizeM * 0.78
    const amp = sizeM * 0.04
    const edge: Pt[] = []
    for (let i = 0; i <= steps; i++) {
      edge.push({ x: baseX + (rng.next() * 2 - 1) * amp, y: i * step })
    }
    const polygon: Pt[] = [
      ...edge,
      { x: sizeM, y: sizeM },
      { x: sizeM, y: 0 },
    ]
    return { kind: 'coast', polygon, bounds: bbox(polygon) }
  }

  const centerY = sizeM * (0.35 + rng.next() * 0.3)
  const half = (sizeM * 0.05) / 2
  const amp = sizeM * 0.02
  const top: Pt[] = []
  const bottom: Pt[] = []
  for (let i = 0; i <= steps; i++) {
    const jitter = (rng.next() * 2 - 1) * amp
    top.push({ x: i * step, y: centerY + jitter - half })
    bottom.push({ x: i * step, y: centerY + jitter + half })
  }
  const polygon = [...top, ...bottom.reverse()]
  return { kind: 'river', polygon, bounds: bbox(polygon) }
}
