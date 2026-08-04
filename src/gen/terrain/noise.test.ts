import { describe, expect, it } from 'vitest'
import { fractalNoise2D, valueNoise2D } from './noise'

describe('valueNoise2D', () => {
  it('is deterministic per seed', () => {
    const a = valueNoise2D(7)
    const b = valueNoise2D(7)
    expect(a(1.3, 4.7)).toBe(b(1.3, 4.7))
    expect(valueNoise2D(8)(1.3, 4.7)).not.toBe(a(1.3, 4.7))
  })
  it('stays in [0,1) and is continuous', () => {
    const n = valueNoise2D(3)
    let prev = n(0, 0.5)
    for (let x = 0.01; x < 4; x += 0.01) {
      const v = n(x, 0.5)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
      expect(Math.abs(v - prev)).toBeLessThan(0.08) // no jumps at 0.01 steps
      prev = v
    }
  })
})

describe('fractalNoise2D', () => {
  it('is deterministic and bounded', () => {
    const f = fractalNoise2D(42)
    expect(f(2.2, 3.3)).toBe(fractalNoise2D(42)(2.2, 3.3))
    for (let i = 0; i < 500; i++) {
      const v = f(i * 0.37, i * 0.11)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
  it('has more small-scale variation than a single octave', () => {
    const single = valueNoise2D(42)
    const multi = fractalNoise2D(42, 5)
    const rough = (fn: (x: number, y: number) => number) => {
      let sum = 0
      for (let x = 0; x < 2; x += 0.02) sum += Math.abs(fn(x + 0.02, 1.5) - fn(x, 1.5))
      return sum
    }
    expect(rough(multi)).toBeGreaterThan(rough(single))
  })
})
