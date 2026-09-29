import type { Pt } from '../geometry'
import { hashSeed } from '../rng'
import { fractalNoise2D } from '../terrain/noise'

// fractalNoise2D (3 octaves, gain 0.5) sums independent bilinear lattices, so
// like any sum of several near-uniform variables it clusters toward the
// center: empirically it rarely strays past ~0.5 ± 0.4 even sampled over many
// periods, and a single sector-sized sample (a few noise periods) often only
// reaches ~0.5 ± 0.2-0.3. Left raw, the field would rarely produce values
// below GRID_BLEND_START (0.15, twisted.ts — pure grid axis) or comfortably
// above MEANDER_MIN_IRR (0.4, twisted.ts — meander kicks in): every region
// would read as the same medium-organic blend. Stretch it back out: measure
// the deviation from center against that empirical half-width, then run it
// through smootherstep (zero derivative at 0/1) so near-center noise still
// varies smoothly while noise straying even moderately from center gets
// pushed hard toward the grid or wild ends.
const STRETCH_CENTER = 0.5
const STRETCH_HALF_WIDTH = 0.4

const smootherstep = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)

function stretchContrast(raw: number): number {
  const u = Math.max(-1, Math.min(1, (raw - STRETCH_CENTER) / STRETCH_HALF_WIDTH))
  return smootherstep((u + 1) / 2)
}

/**
 * Smooth 0..1 irregularity field, low frequency (feature size ~ `scale`
 * meters) so a 2-6km sector shows a handful of coherent regions — some
 * grid-like, some meandering — instead of one uniform look everywhere.
 * Deterministic per seed.
 */
export function irregularityField(seed: number, opts?: { scale?: number }): (p: Pt) => number {
  // ~1km: even the smallest (2km) sector then spans 2+ noise periods (2+
  // distinct regions); a larger default would make small sectors show only
  // one region, defeating the point of a spatial field.
  const scale = opts?.scale ?? 1000
  const noise = fractalNoise2D(hashSeed(seed, 'irregularity-field'), 3)
  return (p: Pt) => stretchContrast(noise(p.x / scale, p.y / scale))
}
