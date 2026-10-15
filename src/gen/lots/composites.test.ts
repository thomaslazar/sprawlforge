import { describe, expect, it } from 'vitest'
import { mulberry32 } from '../rng'
import { ringArea } from '../geometry'
import { boxRing, widthOk } from './fitbox'
import { compositeChance, makeComposite } from './composites'
import { firstWith, insideOrOn, interiorAngles, near90or270 } from './fixtures'

const box60x40 = { origin: { x: 0, y: 0 }, angle: 0, w: 60, d: 40 }

describe('composites', () => {
  it('composite parts stay in the fit box, on a 2 m grid, ≥ 6 m', () => {
    let made = 0
    for (let s = 0; s < 300; s++) for (const zone of ['residential', 'corp', 'industrial', 'fringe'] as const) {
      const fit = { origin: { x: 5, y: -3 }, angle: 0.4, w: 40, d: 36 }, c = makeComposite(fit, zone, zone === 'corp' ? 'packed' : 'sparse', false, mulberry32(s))
      if (!c) continue
      made++
      for (const p of [...c.footprint, ...c.details.flat()]) expect(insideOrOn(p, boxRing(fit), 0.05)).toBe(true)
      expect(widthOk(c.footprint, 6)).toBe(true); expect(c.shape).toMatch(/^E[1-6]$/)
      expect(ringArea(c.footprint)).toBeGreaterThan(0)
    }
    expect(made).toBeGreaterThan(100)
  })
  it('continuous fabrics take only E3 and E5', () => {
    for (let s = 0; s < 300; s++) { const c = makeComposite(box60x40, 'corp', 'packed', true, mulberry32(s)); if (c) expect(['E3', 'E5']).toContain(c.shape) }
  })
  it('continuous composites span the full fit width', () => {
    const fit = { origin: { x: 3, y: 2 }, angle: 0.7, w: 37.6, d: 21.4 }, [a, b] = boxRing(fit)
    let made = 0
    for (let s = 0; s < 300; s++) {
      const c = makeComposite(fit, 'corp', 'packed', true, mulberry32(s)); if (!c) continue
      made++
      for (const q of [a, b]) expect(Math.min(...c.footprint.map((p) => Math.hypot(p.x - q.x, p.y - q.y)))).toBeLessThan(0.05)
    }
    expect(made).toBeGreaterThan(50)
  })
  it('outside parts union rectilinearly; inside parts are details', () => {
    const e6 = firstWith('E6'), e3 = firstWith('E3')
    expect(interiorAngles(e6.footprint).every((a) => near90or270(a))).toBe(true); expect(e3.details).toHaveLength(2)
  })
  it('every composite id comes up and chances follow the R27 order', () => {
    for (const id of ['E1', 'E2', 'E3', 'E4', 'E5', 'E6'] as const) expect(firstWith(id).shape).toBe(id)
    expect([compositeChance('villas', 'corp'), compositeChance('detached', 'residential'), compositeChance('rows', 'commerce'), compositeChance('sheds', 'industrial'), compositeChance('rows', 'mixed')]).toEqual([0.5, 0.3, 0.25, 0.3, 0.1])
  })
})
