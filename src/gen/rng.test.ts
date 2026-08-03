import { describe, expect, it } from 'vitest'
import { hashSeed, mulberry32 } from './rng'

describe('hashSeed', () => {
  it('is deterministic and part-sensitive', () => {
    expect(hashSeed(4711, 'D07')).toBe(hashSeed(4711, 'D07'))
    expect(hashSeed(4711, 'D07')).not.toBe(hashSeed(4711, 'D08'))
    expect(hashSeed(4711, 'D07')).not.toBe(hashSeed(4712, 'D07'))
  })
  it('returns a uint32', () => {
    const h = hashSeed('anything', 42)
    expect(Number.isInteger(h)).toBe(true)
    expect(h).toBeGreaterThanOrEqual(0)
    expect(h).toBeLessThanOrEqual(0xffffffff)
  })
})

describe('mulberry32', () => {
  it('same seed gives same sequence', () => {
    const a = mulberry32(123)
    const b = mulberry32(123)
    expect([a.next(), a.next(), a.next()]).toEqual([b.next(), b.next(), b.next()])
  })
  it('next() is in [0,1)', () => {
    const r = mulberry32(1)
    for (let i = 0; i < 1000; i++) {
      const v = r.next()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
  it('int(min,max) is inclusive and in range', () => {
    const r = mulberry32(7)
    const seen = new Set<number>()
    for (let i = 0; i < 500; i++) {
      const v = r.int(2, 5)
      expect(v).toBeGreaterThanOrEqual(2)
      expect(v).toBeLessThanOrEqual(5)
      seen.add(v)
    }
    expect(seen.size).toBe(4)
  })
  it('weighted respects zero weights', () => {
    const r = mulberry32(9)
    for (let i = 0; i < 200; i++) {
      expect(r.weighted([['a', 0], ['b', 1]] as const)).toBe('b')
    }
  })
  it('pick returns an element', () => {
    const r = mulberry32(5)
    expect(['x', 'y', 'z']).toContain(r.pick(['x', 'y', 'z']))
  })
})
