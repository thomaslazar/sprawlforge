import type { Pt } from '../geometry'
import { hashSeed, mulberry32 } from '../rng'
import type { SectorParams, Water } from '../types'

function bbox(points: Pt[]): { x: number; y: number; w: number; h: number } {
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

export function genGeography(params: SectorParams, sizeM: number): Water {
  if (!params.coast && !params.river) return { kind: 'none', polygon: [], bounds: null }
  const rng = mulberry32(hashSeed(params.seed, 'geo'))
  const steps = 12
  const step = sizeM / steps

  if (params.coast) {
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
