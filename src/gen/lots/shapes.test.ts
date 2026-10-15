import { describe, expect, it } from 'vitest'
import { mulberry32 } from '../rng'
import { ringArea } from '../geometry'
import { boxRing, widthOk } from './fitbox'
import { CURVED_OR_SLANTED, SHAPES, chooseShape, cornerShape, fitShape, sizeShape } from './shapes'
import { insideOrOn, interiorAngles, minNonArcEdge, q40, q65, q90 } from './fixtures'

describe('shapes', () => {
  it('templates are rectilinear', () => { // T3
    const r = mulberry32(7)
    for (const [id, s] of Object.entries(SHAPES)) {
      if (CURVED_OR_SLANTED.has(id) || id === 'A15' || id === 'A16') continue
      for (let k = 0; k < 20; k++) {
        const w = s.minW + r.int(0, 40), d = s.aspect && s.aspect[0] === s.aspect[1] ? w : s.minD + r.int(0, 40)
        const box = { origin: { x: 10, y: 5 }, angle: 0.3, w, d }
        const { footprint } = fitShape(id, box, r)
        for (const a of interiorAngles(footprint)) expect(Math.min(Math.abs(a - 90), Math.abs(a - 270)), `${id} ${w}×${d}`).toBeLessThanOrEqual(1)
        for (const p of footprint) expect(insideOrOn(p, boxRing(box), 0.05)).toBe(true)
      }
    }
  })
  it('every template is counter-clockwise, ≥ 3 m per edge and ≥ 6 m wide at its min size', () => {
    for (const [id, s] of Object.entries(SHAPES)) if (id !== 'A15' && id !== 'A16') {
      for (const seed of [1, 2]) {
        const f = fitShape(id, { origin: { x: 0, y: 0 }, angle: 0, w: s.minW, d: s.minD }, mulberry32(seed)).footprint
        expect(ringArea(f), id).toBeGreaterThan(0); expect(minNonArcEdge(f), id).toBeGreaterThanOrEqual(3); expect(widthOk(f, 6), id).toBe(true)
      }
    }
  })
  it('arcs use 24 segments per circle', () => {
    expect(fitShape('A12', { origin: { x: 0, y: 0 }, angle: 0, w: 20, d: 20 }, mulberry32(1)).footprint).toHaveLength(24)
  })
  it('shape choice respects min size and the fabric list', () => {
    const box = { origin: { x: 0, y: 0 }, angle: 0, w: 12, d: 14 }
    for (let s = 0; s < 200; s++) expect(['A1', 'A2']).toContain(chooseShape(['A1', 'A2', 'A4', 'A9'], 'residential', 'dense', box, mulberry32(s)))
  })
  it('corner rule', () => {
    expect(cornerShape(q90, 90, 'perimeter', true, 400).id).toBe('A4'); expect(cornerShape(q65, 65, 'perimeter', true, 400).id).toBe('A15')
    expect(cornerShape(q40, 40, 'rows', false, 1600).id).toBe('A16'); expect(cornerShape(q40, 40, 'rows', false, 1400).id).toBeNull()
  })
  it('sizing stays inside the fit box', () => {
    const fit = { origin: { x: 3, y: 4 }, angle: 0, w: 40, d: 30 }
    for (const mode of ['continuous', 'detached', 'villas', 'gapped'] as const) for (let s = 0; s < 50; s++) {
      const b = sizeShape('A1', fit, mode, mulberry32(s))
      if (b) { expect(b.origin.x).toBeGreaterThanOrEqual(3); expect(b.origin.x + b.w).toBeLessThanOrEqual(43.01); expect(b.origin.y + b.d).toBeLessThanOrEqual(34.01) }
    }
  })
})
