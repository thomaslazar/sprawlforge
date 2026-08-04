import { hashSeed, mulberry32 } from '../rng'

const smooth = (t: number) => t * t * (3 - 2 * t)

/** deterministic lattice value in [0,1) for integer coordinates */
function latticeValue(seed: number, ix: number, iy: number): number {
  return mulberry32(hashSeed(seed, ix, iy)).next()
}

export function valueNoise2D(seed: number): (x: number, y: number) => number {
  return (x, y) => {
    const ix = Math.floor(x)
    const iy = Math.floor(y)
    const fx = smooth(x - ix)
    const fy = smooth(y - iy)
    const v00 = latticeValue(seed, ix, iy)
    const v10 = latticeValue(seed, ix + 1, iy)
    const v01 = latticeValue(seed, ix, iy + 1)
    const v11 = latticeValue(seed, ix + 1, iy + 1)
    return (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy
  }
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
