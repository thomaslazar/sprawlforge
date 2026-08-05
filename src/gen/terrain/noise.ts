import { hashSeed, mulberry32 } from '../rng'

const smooth = (t: number) => t * t * (3 - 2 * t)

export function valueNoise2D(seed: number): (x: number, y: number) => number {
  // Perf: hashSeed + mulberry32 setup per corner sample dominated generate
  // time (a 128² contour grid revisits the same lattice points across many
  // (x,y) samples). Memoize per noise instance — a 128² sample touches at
  // most ~17k distinct lattice points per octave, so the cache stays small;
  // nothing is ever evicted.
  const cache = new Map<string, number>()
  const latticeValue = (ix: number, iy: number): number => {
    const key = `${ix},${iy}`
    let v = cache.get(key)
    if (v === undefined) {
      v = mulberry32(hashSeed(seed, ix, iy)).next()
      cache.set(key, v)
    }
    return v
  }
  return (x, y) => {
    const ix = Math.floor(x)
    const iy = Math.floor(y)
    const fx = smooth(x - ix)
    const fy = smooth(y - iy)
    const v00 = latticeValue(ix, iy)
    const v10 = latticeValue(ix + 1, iy)
    const v01 = latticeValue(ix, iy + 1)
    const v11 = latticeValue(ix + 1, iy + 1)
    return (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy
  }
}

/**
 * Warps (x,y) through two independent fractal noises so downstream sampling
 * (height noise) picks up organic, non-axis-aligned distortion instead of
 * looking like a lattice was stretched. amp/scale are in the same units as
 * x/y (world metres) — scale is the warp noise's own lattice size, amp is
 * the max displacement.
 */
export function domainWarp2D(seed: number, amp: number, scale: number) {
  const nx = fractalNoise2D(hashSeed(seed, 'warp-x'))
  const ny = fractalNoise2D(hashSeed(seed, 'warp-y'))
  return (x: number, y: number): { x: number; y: number } => ({
    x: x + amp * (nx(x / scale, y / scale) - 0.5) * 2,
    y: y + amp * (ny(x / scale, y / scale) - 0.5) * 2,
  })
}

export function fractalNoise2D(seed: number, octaves = 4, lacunarity = 2, gain = 0.5) {
  const layers = Array.from({ length: octaves }, (_, i) =>
    valueNoise2D(hashSeed(seed, 'oct', i)),
  )
  return (x: number, y: number): number => {
    let amp = 1
    let freq = 1
    let sum = 0
    let norm = 0
    for (const layer of layers) {
      sum += amp * layer(x * freq, y * freq)
      norm += amp
      amp *= gain
      freq *= lacunarity
    }
    return sum / norm
  }
}
