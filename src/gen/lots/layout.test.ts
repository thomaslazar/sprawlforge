import { describe, expect, it } from 'vitest'
import { boxOf, ringArea, ringCentroid, type Pt } from '../geometry'
import { mulberry32 } from '../rng'
import { fitBox } from './fitbox'
import { distToRing, insideRing, pairOverlapMax, rectPoly } from './fixtures'
import { VACANT, layoutPiece, lotKind, type BlockCtx } from './layout'
import { sidesOf } from './setback'
import { densityClass } from './fabrics'
import type { DensityClass, SheetZone } from './shapes'

const piece = rectPoly(0, 0, 160, 120)
const sides = sidesOf(piece, piece.map(() => 7.5))
const ctx = (seed: number, zone: SheetZone): BlockCtx => ({ zone, density: densityClass(0.5), rng: { lots: mulberry32(seed), shapes: mulberry32(seed + 1000), composites: mulberry32(seed + 2000) } })
const FABRICS = ['perimeter', 'terrace', 'shophouse', 'rows', 'zeilen', 'detached', 'villas', 'tower-park', 'podium', 'bigbox', 'sheds', 'plaza', 'garage', 'strip', 'blockfill'] as const
const gapBox = (a: Pt[], b: Pt[]) => { const p = boxOf(a), q = boxOf(b); return Math.hypot(Math.max(0, p.x0 - q.x1, q.x0 - p.x1), Math.max(0, p.y0 - q.y1, q.y0 - p.y1)) }

describe('layoutPiece', () => {
  it('every fabric keeps buildings inside their lots and lots inside the piece', () => {
    for (const f of FABRICS) for (let s = 0; s < 10; s++) {
      const out = layoutPiece(piece, sides, f, ctx(s, f === 'bigbox' || f === 'sheds' ? 'industrial' : 'residential'))
      for (const l of out) { expect(insideRing(l.poly, piece, 0.05), f).toBe(true); for (const b of l.buildings) expect(insideRing(b.footprint, l.poly, 0.05), `${f} ${b.shape}`).toBe(true) }
      expect(pairOverlapMax(out.filter((l) => l.kind !== 'pool').map((l) => l.poly)), f).toBeLessThanOrEqual(0.5)
    }
  })
  it('non-rectangular pieces keep buildings inside their lots and lots inside the piece', () => {
    const P = (...a: number[][]): Pt[] => a.map(([x, y]) => ({ x, y }))
    const trap = P([0, 0], [160, 0], [160 - 120 / Math.tan((70 * Math.PI) / 180), 120], [0, 120]) // one 70 degree end
    const reflex = P([0, 0], [160, 0], [160, 60], [90, 60], [90, 120], [0, 120])
    for (const pc of [trap, reflex]) for (const f of FABRICS) for (let s = 0; s < 5; s++) {
      const out = layoutPiece(pc, sidesOf(pc, pc.map(() => 7.5)), f, ctx(s, f === 'bigbox' || f === 'sheds' ? 'industrial' : 'residential'))
      for (const l of out) { expect(insideRing(l.poly, pc, 0.05), f).toBe(true); for (const b of l.buildings) expect(insideRing(b.footprint, l.poly, 0.05), `${f} ${b.shape}`).toBe(true) }
    }
  })
  it('perimeter 90 degree corners carry an A4', () => {
    for (let s = 0; s < 5; s++) {
      const a4 = layoutPiece(piece, sides, 'perimeter', ctx(s, 'residential')).flatMap((l) => l.buildings).filter((b) => b.shape === 'A4')
      expect(a4.length, `seed ${s}`).toBe(4)
    }
  })
  it('podium keeps a 40 m floor on a small piece', () => {
    const small = rectPoly(0, 0, 42, 42)
    for (let s = 0; s < 5; s++) {
      const b = layoutPiece(small, sidesOf(small, small.map(() => 7.5)), 'podium', ctx(s, 'corp'))[0].buildings[0], x = boxOf(b.footprint)
      expect(x.x1 - x.x0, `seed ${s}`).toBeGreaterThanOrEqual(40 - 1e-6); expect(x.y1 - x.y0).toBeGreaterThanOrEqual(40 - 1e-6)
    }
  })
  it('podium: a template whose box is 0.2-0.45 of the fit box, at most 90 m a side, towers inside it, the rest plaza or green (user review)', () => {
    const big = rectPoly(0, 0, 220, 200)
    for (const [pc, zone, rest] of [[piece, 'corp', 'plaza'], [big, 'commerce', 'plaza'], [piece, 'residential', 'green']] as const) for (let s = 0; s < 10; s++) {
      const out = layoutPiece(pc, sidesOf(pc, pc.map(() => 7.5)), 'podium', ctx(s, zone)), b = out[0].buildings[0], x = boxOf(b.footprint), fb = boxOf(pc)
      expect(b.shape).toBe('A19')
      expect(Math.max(x.x1 - x.x0, x.y1 - x.y0), `seed ${s}`).toBeLessThanOrEqual(90 + 1e-6)
      const share = ((x.x1 - x.x0) * (x.y1 - x.y0)) / ((fb.x1 - fb.x0) * (fb.y1 - fb.y0)) // the podium's box; an L, U or D fills less of it
      if (pc === piece) { expect(share, `seed ${s}`).toBeGreaterThanOrEqual(0.2); expect(share).toBeLessThanOrEqual(0.45) }
      for (const t of b.details) expect(insideRing(t, b.footprint, 0.05), `seed ${s}`).toBe(true)
      expect(out[0].kind).toBe(rest)
    }
  })
  it('dense frontage blocks lot their interior in rear rings; sparse ones keep one ring (user review)', () => {
    const fromSides = (c: Pt) => Math.min(c.x, c.y, 160 - c.x, 120 - c.y)
    for (const f of ['perimeter', 'terrace', 'shophouse', 'rows'] as const) for (let s = 0; s < 5; s++) {
      const dense = layoutPiece(piece, sides, f, ctx(s, 'residential'))
      const bs = dense.flatMap((l) => l.buildings)
      if (f === 'perimeter') expect(bs.some((b) => fromSides(ringCentroid(b.footprint)) >= 30), `${f} seed ${s}`).toBe(true) // fronts are <= 20 m deep
      else expect(bs.length, `${f} seed ${s}`).toBeGreaterThan(layoutPiece(piece, sides, f, { ...ctx(s, 'residential'), density: 'sparse' }).flatMap((l) => l.buildings).length)
      expect(pairOverlapMax(dense.map((l) => l.poly)), `${f} seed ${s}`).toBeLessThanOrEqual(0.5)
      for (const l of dense) { expect(insideRing(l.poly, piece, 0.05)).toBe(true); for (const b of l.buildings) expect(insideRing(b.footprint, l.poly, 0.05)).toBe(true) }
      if (f !== 'perimeter') continue
      const sparse = layoutPiece(piece, sides, f, { ...ctx(s, 'residential'), density: 'sparse' }).flatMap((l) => l.buildings)
      expect(sparse.every((b) => fromSides(ringCentroid(b.footprint)) < 30), `sparse seed ${s}`).toBe(true)
    }
  })
  it('blockfill: unequal masses fill the piece, lightwells inside them (user review)', () => {
    const P = (...a: number[][]): Pt[] => a.map(([x, y]) => ({ x, y }))
    const odd = P([0, 0], [150, 10], [170, 90], [60, 130], [-10, 70])
    let qualifying = 0
    for (const pc of [rectPoly(0, 0, 150, 110), odd]) for (let s = 0; s < 10; s++) {
      const out = layoutPiece(pc, sidesOf(pc, pc.map(() => 7.5)), 'blockfill', { ...ctx(s, 'corp'), density: 'packed' })
      const bs = out.flatMap((l) => l.buildings)
      expect(bs.length, `seed ${s}`).toBeGreaterThanOrEqual(2)
      expect(bs.reduce((t, b) => t + ringArea(b.footprint), 0) / ringArea(pc), `seed ${s}`).toBeGreaterThanOrEqual(0.85)
      expect(pairOverlapMax(bs.map((b) => b.footprint))).toBeLessThanOrEqual(0.5)
      const widths = bs.map((b) => Math.round(ringArea(b.footprint)))
      expect(new Set(widths).size, `seed ${s}`).toBe(widths.length) // unequal masses
      for (const b of bs) {
        expect(['B1', 'B1T']).toContain(b.shape)
        for (const d of b.details) { expect(insideRing(d, b.footprint, 0.05)).toBe(true); for (const p of d) expect(distToRing(p, b.footprint)).toBeGreaterThanOrEqual(4 - 0.05) }
        const fp = b.footprint, e = fp.map((p, k) => [p, fp[(k + 1) % fp.length]] as [Pt, Pt]).sort((u, v) => Math.hypot(v[1].x - v[0].x, v[1].y - v[0].y) - Math.hypot(u[1].x - u[0].x, u[1].y - u[0].y))[0], fb = fitBox(fp, e) // fit box along the longest edge
        if (b.shape === 'B1' && ringArea(b.footprint) > 900 && Math.min(fb.w, fb.d) >= 14) { qualifying++; expect(b.details.length, `seed ${s}`).toBeGreaterThanOrEqual(1) }
      }
      for (const l of out) for (const b of l.buildings) expect(insideRing(b.footprint, l.poly, 0.05)).toBe(true)
    }
    expect(qualifying).toBeGreaterThan(0)
  })
  it('variation along fronts (user review): ragged back line, vacant lots, few repeats', () => {
    // depth along the front side of a perimeter block varies
    const depths = Array.from({ length: 10 }, (_, s) => layoutPiece(piece, sides, 'perimeter', { ...ctx(s, 'residential'), density: 'sparse' })
      .flatMap((l) => l.buildings).map((b) => boxOf(b.footprint)).filter((b) => Math.abs(b.y0) < 1e-6 && b.x0 > 20 && b.x1 < 140).map((b) => b.y1 - b.y0)).flat()
    const mean = depths.reduce((a, b) => a + b, 0) / depths.length
    expect(Math.sqrt(depths.reduce((a, b) => a + (b - mean) ** 2, 0) / depths.length)).toBeGreaterThanOrEqual(1.5)
    // vacancy share per density class over >= 2000 strip lots
    for (const [dc, p] of Object.entries(VACANT) as Array<[DensityClass, number]>) {
      let n = 0, v = 0
      const thin = rectPoly(0, 0, 300, 50) // no interior left for rear rings, so every lot is a frontage lot
      for (let s = 0; n < 2000; s++) for (const l of layoutPiece(thin, sidesOf(thin, thin.map(() => 7.5)), 'rows', { ...ctx(s, 'mixed'), density: dc })) {
        if (l.vacant) v++
        if (l.vacant || l.buildings.length) n++
      }
      expect(Math.abs(v / n - p), `${dc} ${v / n}`).toBeLessThanOrEqual(0.01)
    }
    // consecutive lots on one side rarely repeat shape and width
    let pairs = 0, same = 0
    for (let s = 0; s < 200; s++) {
      const bs = layoutPiece(piece, sides, 'rows', ctx(s, 'mixed')).flatMap((l) => l.buildings).map((b) => ({ b: boxOf(b.footprint), shape: b.shape })).filter((x) => Math.abs(x.b.y0) < 1e-6).sort((p, q) => p.b.x0 - q.b.x0)
      for (let i = 1; i < bs.length; i++) { pairs++; if (bs[i].shape === bs[i - 1].shape && Math.round(bs[i].b.x1 - bs[i].b.x0) === Math.round(bs[i - 1].b.x1 - bs[i - 1].b.x0)) same++ }
    }
    expect(same / pairs).toBeLessThanOrEqual(0.02)
  }, 30000)
  it('continuous fronts touch', () => {
    for (let s = 0; s < 10; s++) {
      const out = layoutPiece(piece, sides, 'perimeter', ctx(s, 'residential'))
      const fronts = out.flatMap((l) => l.buildings).map((b) => boxOf(b.footprint)).filter((b) => Math.abs(b.y0) < 1e-6).sort((a, b) => a.x0 - b.x0)
      const vacant = out.filter((l) => l.vacant).map((l) => boxOf(l.poly)) // a vacant lot (user review) is the only gap allowed
      expect(fronts.length).toBeGreaterThan(5)
      const coveredBy = (a: number, b: number) => vacant.reduce((t, v) => t + Math.max(0, Math.min(b, v.x1) - Math.max(a, v.x0)), 0)
      for (let i = 1; i < fronts.length; i++) {
        const gap = fronts[i].x0 - fronts[i - 1].x1
        expect(Math.abs(gap) - coveredBy(fronts[i - 1].x1, fronts[i].x0), `seed ${s}`).toBeLessThanOrEqual(0.05)
      }
    }
  })
  it('terrace builds on two antiparallel sides and leaves green', () => {
    for (let s = 0; s < 10; s++) {
      const out = layoutPiece(piece, sides, 'terrace', { ...ctx(s, 'residential'), density: 'sparse' }) // dense ones lot their interior (rear rings)
      const bs = out.flatMap((l) => l.buildings)
      expect(bs.length).toBeGreaterThan(0)
      for (const b of bs) { const x = boxOf(b.footprint); expect(x.y1 <= 12.01 || x.y0 >= 107.99, `seed ${s}`).toBe(true) }
      expect(out.some((l) => l.kind === 'green')).toBe(true)
    }
  })
  it('zeilen slabs are 12 m deep, 40-80 m long, 25-35 m apart', () => {
    for (let s = 0; s < 10; s++) {
      const slabs = layoutPiece(piece, sides, 'zeilen', ctx(s, 'residential')).flatMap((l) => l.buildings)
      expect(slabs.length, `seed ${s}`).toBeGreaterThan(1)
      const rows = slabs.map((b) => {
        const r = b.footprint
        const e = r.map((p, i) => [p, r[(i + 1) % r.length]] as [Pt, Pt]).reduce((m, x) => (Math.hypot(x[1].x - x[0].x, x[1].y - x[0].y) > Math.hypot(m[1].x - m[0].x, m[1].y - m[0].y) ? x : m))
        if (e[1].x < e[0].x) e.reverse() // slabs are near-horizontal; mirrored ones come out reversed
        const f = fitBox(r, e)
        expect(f.d).toBeCloseTo(12, 1); expect(f.w).toBeGreaterThanOrEqual(40 - 1e-6); expect(f.w).toBeLessThanOrEqual(80 + 1e-6)
        const c = ringCentroid(r), L = Math.hypot(e[1].x - e[0].x, e[1].y - e[0].y)
        return -c.x * ((e[1].y - e[0].y) / L) + c.y * ((e[1].x - e[0].x) / L)
      }).sort((a, b) => a - b)
      for (let i = 1; i < rows.length; i++) { expect(rows[i] - rows[i - 1], `seed ${s}`).toBeGreaterThanOrEqual(25 - 0.01); expect(rows[i] - rows[i - 1]).toBeLessThanOrEqual(35 + 0.01) }
    }
  })
  it('bigbox has a parking front and a yard rear', () => {
    for (let s = 0; s < 10; s++) {
      const out = layoutPiece(piece, sides, 'bigbox', ctx(s, 'industrial'))
      expect(out.filter((l) => l.kind === 'parking').length).toBe(1)
      const yard = out.filter((l) => l.kind === 'yard')
      expect(yard.length).toBe(1)
      expect(out.flatMap((l) => l.buildings).length).toBe(1)
      for (const b of out.flatMap((l) => l.buildings)) expect(insideRing(b.footprint, yard[0].poly, 0.05)).toBe(true)
    }
  })
  it('plaza: 1-2 pavilions, 16 m to half the fit box a side, 20 m apart (user review)', () => {
    for (const [w, d] of [[40, 40], [60, 45], [160, 120]]) for (let s = 0; s < 10; s++) {
      const pc = rectPoly(0, 0, w, d), bs = layoutPiece(pc, sidesOf(pc, pc.map(() => 7.5)), 'plaza', ctx(s, 'corp')).flatMap((l) => l.buildings)
      expect(bs.length, `${w}x${d} seed ${s}`).toBeGreaterThanOrEqual(1); expect(bs.length).toBeLessThanOrEqual(2)
      for (const b of bs) { const x = boxOf(b.footprint); expect(x.x1 - x.x0).toBeLessThanOrEqual(w / 2 + 1e-6); expect(x.y1 - x.y0).toBeLessThanOrEqual(d / 2 + 1e-6) }
      if (bs.length === 2) expect(gapBox(bs[0].footprint, bs[1].footprint)).toBeGreaterThanOrEqual(20 - 1e-6)
    }
  })
  it('plaza: a fit box of 20-31 m a side still holds one pavilion, 16 m up to the side less 4 m', () => {
    for (const [w, d] of [[20, 20], [24, 31], [31, 26]]) for (let s = 0; s < 10; s++) {
      const pc = rectPoly(0, 0, w, d), bs = layoutPiece(pc, sidesOf(pc, pc.map(() => 7.5)), 'plaza', ctx(s, 'corp')).flatMap((l) => l.buildings)
      expect(bs.length, `${w}x${d} seed ${s}`).toBe(1)
      const x = boxOf(bs[0].footprint); expect(x.x1 - x.x0).toBeLessThanOrEqual(w - 4 + 1e-6); expect(x.y1 - x.y0).toBeLessThanOrEqual(d - 4 + 1e-6)
    }
  })
  it('bigbox and sheds halls stay within 120 m a side on a 300 x 100 m piece', () => {
    const pc = rectPoly(0, 0, 300, 100)
    for (const f of ['bigbox', 'sheds'] as const) for (let s = 0; s < 10; s++) {
      const bs = layoutPiece(pc, sidesOf(pc, pc.map(() => 7.5)), f, ctx(s, 'industrial')).flatMap((l) => l.buildings)
      expect(bs.length, `${f} seed ${s}`).toBeGreaterThanOrEqual(1)
      for (const b of bs) { const x = boxOf(b.footprint); expect(Math.max(x.x1 - x.x0, x.y1 - x.y0), `${f} seed ${s}`).toBeLessThanOrEqual(120 + 1e-6) }
    }
  })
  it('tower-park towers stand 12 m apart', () => {
    for (let s = 0; s < 10; s++) {
      const bs = layoutPiece(piece, sides, 'tower-park', ctx(s, 'corp')).flatMap((l) => l.buildings)
      expect(bs.length).toBeGreaterThanOrEqual(2); expect(bs.length).toBeLessThanOrEqual(8)
      for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) expect(gapBox(bs[i].footprint, bs[j].footprint)).toBeGreaterThanOrEqual(12 - 1e-6)
    }
    const count = (w: number, s: number) => { const pc = rectPoly(0, 0, w, w); return layoutPiece(pc, sidesOf(pc, pc.map(() => 7.5)), 'tower-park', ctx(s, 'corp')).flatMap((l) => l.buildings).length }
    for (let s = 0; s < 5; s++) expect(count(100, s), `100 m ${s}`).toBeGreaterThanOrEqual(2)
    for (let s = 0; s < 5; s++) { expect(count(140, s), `big ${s}`).toBeGreaterThanOrEqual(4); expect(count(65, s), `small ${s}`).toBeLessThanOrEqual(2) }
  })
  it('villas pools sit inside green lots, 3 m clear', () => {
    let pools = 0
    for (let s = 0; s < 20; s++) {
      const out = layoutPiece(piece, sides, 'villas', ctx(s, 'residential'))
      for (const p of out.filter((l) => l.kind === 'pool')) {
        pools++
        const host = out.find((l) => l.kind === 'green' && l.buildings.length && insideRing(p.poly, l.poly, 0.05))
        expect(host, `seed ${s}`).toBeTruthy()
        const house = host!.buildings[0].footprint
        for (const q of p.poly) { expect(distToRing(q, house)).toBeGreaterThanOrEqual(3 - 1e-6); expect(distToRing(q, host!.poly)).toBeGreaterThanOrEqual(3 - 1e-6) }
        for (const q of house) expect(distToRing(q, p.poly)).toBeGreaterThanOrEqual(3 - 1e-6)
      }
    }
    expect(pools).toBeGreaterThan(0)
  })
  it('lot kind by open ground', () => {
    expect(lotKind(rectPoly(0, 0, 10, 10), [rectPoly(0, 0, 10, 9)], 'yard')).toBe('building')
    expect(lotKind(rectPoly(0, 0, 10, 10), [rectPoly(0, 0, 10, 8)], 'yard')).toBe('yard')
  })
  it('garage is one 60 x 40 building on a parking lot', () => {
    const out = layoutPiece(piece, sides, 'garage', ctx(1, 'residential'))
    expect(out.length).toBe(1); expect(out[0].kind).toBe('parking')
    expect(Math.abs(ringArea(out[0].buildings[0].footprint))).toBeCloseTo(2400, 3); expect(out[0].buildings[0].details.length).toBe(2)
  })
})
