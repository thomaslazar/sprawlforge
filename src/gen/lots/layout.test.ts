import { describe, expect, it } from 'vitest'
import { boxOf, ringArea, ringCentroid, type Pt } from '../geometry'
import { mulberry32 } from '../rng'
import { fitBox } from './fitbox'
import { distToRing, insideRing, pairOverlapMax, rectPoly } from './fixtures'
import { layoutPiece, lotKind, type BlockCtx } from './layout'
import { sidesOf } from './setback'
import { densityClass } from './fabrics'
import type { SheetZone } from './shapes'

const piece = rectPoly(0, 0, 160, 120)
const sides = sidesOf(piece, piece.map(() => 7.5))
const ctx = (seed: number, zone: SheetZone): BlockCtx => ({ zone, density: densityClass(0.5), rng: { lots: mulberry32(seed), shapes: mulberry32(seed + 1000), composites: mulberry32(seed + 2000) } })
const FABRICS = ['perimeter', 'terrace', 'shophouse', 'rows', 'zeilen', 'detached', 'villas', 'tower-park', 'podium', 'bigbox', 'sheds', 'plaza', 'garage', 'strip'] as const
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
  it('continuous fronts touch', () => {
    for (let s = 0; s < 10; s++) {
      const fronts = layoutPiece(piece, sides, 'perimeter', ctx(s, 'residential')).flatMap((l) => l.buildings).map((b) => boxOf(b.footprint)).filter((b) => Math.abs(b.y0) < 1e-6).sort((a, b) => a.x0 - b.x0)
      expect(fronts.length).toBeGreaterThan(5)
      for (let i = 1; i < fronts.length; i++) expect(Math.abs(fronts[i].x0 - fronts[i - 1].x1), `seed ${s}`).toBeLessThanOrEqual(0.05)
    }
  })
  it('terrace builds on two antiparallel sides and leaves green', () => {
    for (let s = 0; s < 10; s++) {
      const out = layoutPiece(piece, sides, 'terrace', ctx(s, 'residential'))
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
  it('tower-park towers stand 20 m apart', () => {
    for (let s = 0; s < 10; s++) {
      const bs = layoutPiece(piece, sides, 'tower-park', ctx(s, 'corp')).flatMap((l) => l.buildings)
      expect(bs.length).toBeGreaterThanOrEqual(1); expect(bs.length).toBeLessThanOrEqual(3)
      for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) expect(gapBox(bs[i].footprint, bs[j].footprint)).toBeGreaterThanOrEqual(20 - 1e-6)
    }
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
