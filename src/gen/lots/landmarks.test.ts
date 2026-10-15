import { describe, expect, it } from 'vitest'
import { mulberry32 } from '../rng'
import type { Pt } from '../geometry'
import { densityClass } from './fabrics'
import { distToRing, insideOrOn, insideRing, rectPoly } from './fixtures'
import { accepted } from './fitbox'
import { compoundLots, megablockLots } from './landmarks'
import type { BlockCtx } from './layout'
import { buildable, sidesOf } from './setback'
import type { SheetZone } from './shapes'

const ctx = (seed: number, zone: SheetZone): BlockCtx => ({ zone, density: densityClass(0.5), rng: { lots: mulberry32(seed), shapes: mulberry32(seed + 1000), composites: mulberry32(seed + 2000) } })
const big = rectPoly(0, 0, 600, 500)
const isRectangle = (r: Pt[]) => r.length === 4 && r.every((p, i) => { const a = r[(i + 3) % 4], b = r[(i + 1) % 4]; return Math.abs((a.x - p.x) * (b.x - p.x) + (a.y - p.y) * (b.y - p.y)) < 1e-6 })

describe('landmark lots', () => {
  it('hive cells stay inside the core', () => {
    for (let s = 0; s < 5; s++) {
      const r = megablockLots(big, sidesOf(big), 200, ctx(s, 'mixed'), mulberry32(s))
      const hive = r.lots.flatMap((l) => l.buildings).filter((b) => b.shape === 'hive')
      expect(hive.length).toBeGreaterThan(10)
      for (const b of hive) expect(insideRing(b.footprint, r.core, 0.05)).toBe(true)
      for (const [a, b] of r.alleys) for (const p of [a, b]) expect(insideOrOn(p, r.core, 0.05)).toBe(true)
    }
  })
  it('a small megablock block falls back to the fit-box core', () => {
    const small = rectPoly(0, 0, 300, 260), r = megablockLots(small, sidesOf(small), 250, ctx(1, 'mixed'), mulberry32(1))
    expect(insideRing(r.core, buildable(small, [7.5, 7.5, 7.5, 7.5])[0], 0.05)).toBe(true)
    expect(isRectangle(r.core)).toBe(true)
  })
  it('a piece with no 26 m inset keeps a 6 m fit-box core and one plaza lot', () => {
    const tiny = rectPoly(0, 0, 40, 36), r = megablockLots(tiny, sidesOf(tiny), 20, ctx(1, 'mixed'), mulberry32(1))
    expect(r.core.length).toBeGreaterThanOrEqual(3)
    expect(insideRing(r.core, tiny, 0.05)).toBe(true)
    expect(r.lots.length).toBe(1); expect(r.lots[0].kind).toBe('plaza'); expect(r.lots[0].buildings).toEqual([])
    expect(r.alleys).toEqual([])
  })
  it('the ring around the core is perimeter-lotted', () => {
    for (let s = 0; s < 5; s++) {
      const r = megablockLots(big, sidesOf(big), 200, ctx(s, 'mixed'), mulberry32(s))
      const ring = r.lots.flatMap((l) => l.buildings).filter((b) => b.shape !== 'hive')
      expect(ring.length).toBeGreaterThanOrEqual(8)
      for (const b of ring) for (const p of b.footprint) expect(insideRing([p], r.core, 0.05) || distToRing(p, r.core) < 6 - 0.05 ? 1 : 0).toBe(0)
    }
  })
  it('a compound has 2-4 shapes, 8 m inside the fence', () => {
    const c = compoundLots(rectPoly(0, 0, 200, 160), { x: 100, y: 0 }, ctx(3, 'corp'), mulberry32(3))!
    const b = c.lots.flatMap((l) => l.buildings)
    expect(b.length).toBeGreaterThanOrEqual(2); expect(b.length).toBeLessThanOrEqual(4)
    for (const x of b) { for (const p of x.footprint) expect(distToRing(p, c.fence)).toBeGreaterThanOrEqual(8); if (!/^E/.test(x.shape)) expect(x.footprint.length).toBeLessThanOrEqual(12) }
  })
  it('compound buildings pass the acceptance gate, 2-4 or no compound', () => {
    // S42 B4701 (CMP3): the gate dropped a building after compoundLots counted it, leaving 1
    const fp = ([[3097.39, 3227.57], [3105.89, 3231.65], [3112.76, 3236.99], [3118.13, 3243.48], [3122.17, 3251.01], [3125.02, 3259.48], [3126.84, 3268.78], [3127.77, 3278.8], [3127.97, 3289.44], [3127.59, 3300.59], [3126.77, 3312.14], [3125.67, 3323.99], [3124.44, 3336.02], [3123.24, 3348.13], [3122.2, 3360.22], [3121.49, 3372.18], [3121.25, 3383.9], [3121.64, 3395.27], [3122.8, 3406.19], [3124.88, 3416.55], [3128.04, 3426.24], [3132.43, 3435.16], [3138.2, 3443.19], [3126.54, 3445.4], [3087.84, 3455.51], [3030.79, 3473.77], [3020.85, 3474.14], [3009.63, 3471.1], [3001.82, 3468.4], [2994.45, 3464.65], [2988.77, 3461.25], [2981.27, 3454.85], [2976.39, 3446.3], [2968.05, 3422.8], [2955.57, 3374.39], [2948.11, 3335.1], [2944.53, 3305.32], [2943.22, 3275.36], [2944.18, 3255.39], [2947.22, 3235.63], [2952.49, 3216.34], [2965.86, 3179.6]] as const).map(([x, y]) => ({ x, y }))
    for (let s = 0; s < 20; s++) {
      const c = compoundLots(fp, fp[0], ctx(s, 'corp'), mulberry32(s))
      if (!c) continue
      const bs = c.lots.flatMap((l) => l.buildings)
      expect(bs.length, `seed ${s}`).toBeGreaterThanOrEqual(2); expect(bs.length).toBeLessThanOrEqual(4)
      for (const b of bs) expect(accepted(b.footprint), `seed ${s} ${b.shape}`).toBe(true)
    }
  })
  it('a block too small for 2 compound buildings gives null', () => {
    expect(compoundLots(rectPoly(0, 0, 60, 60), { x: 30, y: 0 }, ctx(1, 'corp'), mulberry32(1))).toBeNull()
  })
})
