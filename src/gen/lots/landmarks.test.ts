import { describe, expect, it } from 'vitest'
import { mulberry32 } from '../rng'
import { ringArea } from '../geometry'
import { densityClass } from './fabrics'
import { distToRing, insideOrOn, insideRing, rectPoly } from './fixtures'
import { accepted } from './fitbox'
import { compoundLots, megablockLots } from './landmarks'
import type { BlockCtx } from './layout'
import type { SheetZone } from './shapes'

const ctx = (seed: number, zone: SheetZone): BlockCtx => ({ zone, density: densityClass(0.5), rng: { lots: mulberry32(seed), shapes: mulberry32(seed + 1000), composites: mulberry32(seed + 2000) } })
const big = rectPoly(0, 0, 600, 500)

describe('landmark lots', () => {
  it('hive cells fill the piece and stay inside it', () => {
    for (let s = 0; s < 5; s++) {
      const r = megablockLots(big, mulberry32(s))
      const hive = r.lots.flatMap((l) => l.buildings).filter((b) => b.shape === 'hive')
      expect(hive.length).toBeGreaterThan(20)
      expect(r.core).toEqual(big)
      for (const b of hive) expect(insideRing(b.footprint, big, 0.05)).toBe(true)
      for (const [a, b] of r.alleys) for (const p of [a, b]) expect(insideOrOn(p, big, 0.05)).toBe(true)
      expect(r.lots.reduce((t, l) => t + Math.abs(ringArea(l.poly)), 0)).toBeGreaterThan(0.8 * 600 * 500) // only the 2 m alleys are left
      for (const l of r.lots) if (l.kind === 'building') expect(accepted(l.poly)).toBe(true)
    }
  })
  it('a thin megablock piece still gets a cell or a plaza lot', () => {
    const thin = rectPoly(0, 0, 120, 14), r = megablockLots(thin, mulberry32(1))
    expect(r.lots.length).toBeGreaterThanOrEqual(1)
    for (const l of r.lots) expect(insideRing(l.poly, thin, 0.05)).toBe(true)
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
    let made = 0
    for (let s = 0; s < 20; s++) {
      const c = compoundLots(fp, fp[0], ctx(s, 'corp'), mulberry32(s))
      if (!c) continue
      made++
      const bs = c.lots.flatMap((l) => l.buildings)
      expect(bs.length, `seed ${s}`).toBeGreaterThanOrEqual(2); expect(bs.length).toBeLessThanOrEqual(4)
      for (const b of bs) expect(accepted(b.footprint), `seed ${s} ${b.shape}`).toBe(true)
    }
    expect(made).toBeGreaterThan(0)
  })
  it('compound lots stay inside the buildable they are given', () => {
    // S426 B0301: a highway along one side (26 m setback) reaches past the 14 m inset
    const fp = rectPoly(0, 0, 200, 160), within = [rectPoly(14, 26, 172, 120)]
    for (let s = 0; s < 5; s++) {
      const c = compoundLots(fp, { x: 100, y: 160 }, ctx(s, 'corp'), mulberry32(s), within)
      expect(c).not.toBeNull()
      for (const l of c!.lots) expect(insideRing(l.poly, within[0], 0.05), `seed ${s}`).toBe(true)
    }
  })
  it('a block too small for 2 compound buildings gives null', () => {
    expect(compoundLots(rectPoly(0, 0, 60, 60), { x: 30, y: 0 }, ctx(1, 'corp'), mulberry32(1))).toBeNull()
  })
})
