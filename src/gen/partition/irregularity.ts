import type { Pt } from '../geometry'
import { hashSeed } from '../rng'
import { fractalNoise2D } from '../terrain/noise'

/**
 * Smooth 0..1 irregularity field, low frequency (feature size ~ `scale`
 * meters) so a 2-6km sector shows a handful of coherent regions — some
 * grid-like, some meandering — instead of one uniform look everywhere.
 * Deterministic per seed.
 */
export function irregularityField(seed: number, opts?: { scale?: number }): (p: Pt) => number {
  const scale = opts?.scale ?? 1500
  const noise = fractalNoise2D(hashSeed(seed, 'irregularity-field'), 3)
  return (p: Pt) => noise(p.x / scale, p.y / scale)
}
