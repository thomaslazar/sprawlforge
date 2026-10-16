import { describe, expect, it } from 'vitest'
import { boxOf, ringArea } from '../geometry'
import { mulberry32 } from '../rng'
import { fitBox, holds } from './fitbox'
import { difference } from '../clip'
import { arcSide, frontage, lShape, pairOverlapMax, rectPoly } from './fixtures'
import { sidesOf } from './setback'
import { STRIP_PARAMS, isSimple, simpleParts, stripLots, type StripParams } from './strips'

const P: StripParams = { depth: 16, width: [10, 18], gap: null }
const run = (piece: ReturnType<typeof rectPoly>, seed: number, p = P) => stripLots(piece, sidesOf(piece), p, mulberry32(seed))

describe('stripLots', () => {
  it('strips on a rectangle', () => {
    const lots = run(rectPoly(0, 0, 100, 60), 1)
    const corners = lots.filter((l) => l.corner !== undefined)
    expect(corners).toHaveLength(4)
    for (const c of corners) {
      const b = boxOf(c.poly)
      expect(c.corner).toBeCloseTo(90, 6)
      expect(b.x1 - b.x0).toBeCloseTo(16, 2); expect(b.y1 - b.y0).toBeCloseTo(16, 2); expect(ringArea(c.poly)).toBeCloseTo(256, 2)
    }
    expect(pairOverlapMax(lots.map((l) => l.poly))).toBeLessThanOrEqual(0.5)
    expect(Math.abs(lots.filter((l) => l.filler).reduce((a, l) => a + ringArea(l.poly), 0) - 68 * 28)).toBeLessThan(1)
    for (const l of lots.filter((l) => !l.filler && l.corner === undefined)) expect(frontage(l)).toBeGreaterThanOrEqual(10)
  })
  it('reflex corner strips do not overlap', () => {
    const L = lShape(120, 120, 60)
    expect(pairOverlapMax(run(L, 2).map((l) => l.poly))).toBeLessThanOrEqual(0.5)
  })
  it('lots along a curved side', () => {
    const piece = [...arcSide({ x: 0, y: 0 }, 200, 60, 12), { x: 0, y: 150 }]
    const lots = run(piece, 3).filter((l) => !l.filler)
    expect(lots.length).toBeGreaterThan(3)
    expect(pairOverlapMax(lots.map((l) => l.poly))).toBeLessThanOrEqual(0.5)
    for (const l of lots) expect(holds(fitBox(l.poly, l.chord), 6, 8)).toBe(true)
  })
  it('a lot too narrow for 6 x 8 merges into its neighbour', () => {
    const lots = run(rectPoly(0, 0, 37.5, 60), 4, { ...P, width: [5.5, 5.5] })
    const strip = lots.filter((l) => !l.filler && l.corner === undefined)
    expect(strip.length).toBeGreaterThan(0)
    for (const l of strip) expect(frontage(l)).toBeGreaterThanOrEqual(6 - 1e-9) // no 5.5 m lot survives
    expect(strip.some((l) => frontage(l) >= 11 - 1e-9)).toBe(true) // a merge happened
    for (const l of lots.filter((l) => !l.filler)) expect(holds(fitBox(l.poly, l.chord), 6, 8)).toBe(true)
  })
  it('acute corner lot', () => {
    const tri = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 * Math.tan((40 * Math.PI) / 180) }]
    expect(run(tri, 5).some((l) => Math.abs((l.corner ?? 0) - 40) < 0.5)).toBe(true)
  })
  it('a block narrower than the strip depth', () => {
    expect(run(rectPoly(0, 0, 100, 12), 6).filter((l) => !l.filler).length).toBeLessThanOrEqual(1)
  })
  it('a wide-frontage sliver thinner than D is cut along its front, not one slab', () => {
    const lots = run(rectPoly(0, 0, 300, 11), 4, { depth: 20, width: [15, 60], wide: true, gap: [3, 3], sides: () => [0] }).filter((l) => !l.filler)
    expect(lots.length).toBeGreaterThanOrEqual(4)
    for (const l of lots) { const b = boxOf(l.poly); expect(b.x1 - b.x0).toBeLessThanOrEqual(75 + 1e-6); expect(b.y1 - b.y0).toBeLessThanOrEqual(11 + 1e-6) }
  })
  it('gaps become filler lots', () => {
    const lots = run(rectPoly(0, 0, 100, 60), 7, { ...P, gap: [3, 5] })
    expect(lots.filter((l) => l.filler).length).toBeGreaterThan(1)
    expect(pairOverlapMax(lots.map((l) => l.poly))).toBeLessThanOrEqual(0.5)
  })
  it('holes: leftover splits into simple fillers, strips face the hole', () => {
    const piece = rectPoly(0, 0, 400, 300), hole = rectPoly(140, 100, 120, 100)
    const lots = stripLots(piece, sidesOf(piece), P, mulberry32(8), [hole])
    expect(pairOverlapMax(lots.map((l) => l.poly))).toBeLessThanOrEqual(0.5)
    const inHole = (q: { x: number; y: number }) => q.x > 140 + 0.05 && q.x < 260 - 0.05 && q.y > 100 + 0.05 && q.y < 200 - 0.05
    const fillers = lots.filter((l) => l.filler)
    expect(fillers.length).toBeGreaterThan(1)
    for (const f of fillers) for (const q of f.poly) expect(inHole(q)).toBe(false)
    expect(lots.filter((l) => l.side >= 4 && !l.filler && l.corner === undefined).length).toBeGreaterThan(0)
    for (const l of lots.filter((l) => l.side >= 4 && !l.filler && l.corner === undefined)) {
      for (const q of l.chord) expect(Math.min(Math.abs(q.x - 140), Math.abs(q.x - 260), Math.abs(q.y - 100), Math.abs(q.y - 200))).toBeLessThan(1e-6)
      const b = fitBox(l.poly, l.chord)
      const c = { x: b.origin.x + Math.cos(b.angle) * b.w / 2 - Math.sin(b.angle) * b.d / 2, y: b.origin.y + Math.sin(b.angle) * b.w / 2 + Math.cos(b.angle) * b.d / 2 }
      expect(inHole(c)).toBe(false)
      const mid = { x: (l.chord[0].x + l.chord[1].x) / 2, y: (l.chord[0].y + l.chord[1].y) / 2 }
      expect(Math.hypot(c.x - 200, c.y - 150)).toBeGreaterThan(Math.hypot(mid.x - 200, mid.y - 150)) // fit box lies outward of the hole wall
    }
  })
  it('a strip lot where the piece is thinner than D stays inside the piece', () => {
    // S42 B3101: plain quads ran out through the far side of a narrow wedge
    const notch = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 60 }, { x: 60, y: 60 }, { x: 50, y: 12 }, { x: 40, y: 60 }, { x: 0, y: 60 }]
    const ring = (r: typeof notch) => r.map((p) => [p.x, p.y] as [number, number])
    for (let seed = 1; seed <= 10; seed++) for (const l of run(notch, seed)) {
      const out = difference([ring(l.poly)], [ring(notch)]).reduce((t, pg) => t + Math.abs(ringArea(pg[0].slice(0, -1).map(([x, y]) => ({ x, y })))), 0)
      expect(out, `seed ${seed}`).toBeLessThan(0.05)
    }
  })
  it('two corner lots on a short side do not overlap', () => {
    // S2268 B4605 (shophouse, D 20): the second corner quad's inner point reached past its corner's box, and the clipper
    // returned the first corner lot as a hole touching the second's outline
    const piece = ([[2354.336, 1948.742], [2285.621, 1993.321], [2253.711, 2007.34], [2222.775, 1966.311], [2239.467, 1953.724], [2251.628, 1980.427], [2252.145, 1981.674], [2254.255, 1983.784], [2257.011, 1984.926], [2259.995, 1984.926], [2262.751, 1983.784], [2264.861, 1981.674], [2266.003, 1978.918], [2266.003, 1975.934], [2264.861, 1973.177], [2264.767, 1973.083], [2251.737, 1944.472], [2315.096, 1896.7]] as const).map(([x, y]) => ({ x, y }))
    const sb = piece.map((_, i) => (i < 2 || i === piece.length - 1 ? 12 : 7.5))
    const lots = stripLots(piece, sidesOf(piece, sb), { depth: 20, width: [6, 8], gap: null }, mulberry32(1))
    expect(lots.filter((l) => l.corner !== undefined).length).toBeGreaterThanOrEqual(5)
    expect(pairOverlapMax(lots.map((l) => l.poly))).toBeLessThanOrEqual(0.5)
  })
  it('gapped lots either side of a convex bend do not overlap behind it', () => {
    // S42 B0703 (rows, D 25, gap 3): the perpendicular back corners of the lots before and after the bend converge
    const piece = ([[2248.74, 1396.77], [2342.16, 1424.41], [2383.92, 1440.06], [2385.74, 1505.43], [2351.11, 1535.28], [2316.76, 1535.28], [2291.52, 1499.52], [2260.76, 1422.85], [2245.35, 1426.49], [2245.35, 1396.01]] as const).map(([x, y]) => ({ x, y }))
    const sb = [5, 5, 7.5, 12, 7.5, 7.5, 7.5, 7.5, 7.5, 5]
    for (let seed = 1; seed <= 20; seed++) {
      const lots = stripLots(piece, sidesOf(piece, sb), { depth: 25, width: [12, 30], gap: [3, 3] }, mulberry32(seed))
      expect(pairOverlapMax(lots.map((l) => l.poly)), `seed ${seed}`).toBeLessThanOrEqual(0.5)
    }
  })
  it('simpleParts mends degenerate clipper rings', () => {
    const sq = rectPoly(0, 0, 20, 20)
    // a spike (S426 LOT00021: ... (76.2,137.3), (76.1,137.3), (76.2,137.3) ...) goes, the square stays
    const spiked = [sq[0], { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 20.0001, y: 30 }, { x: 20, y: 10 }, sq[2], sq[3]]
    expect(simpleParts(spiked).map((r) => Math.round(ringArea(r)))).toEqual([400])
    // a pinch (one vertex visited twice) splits into its two loops
    const pinched = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }, { x: 10, y: 10 }, { x: 0, y: 10 }]
    expect(simpleParts(pinched).map((r) => Math.round(ringArea(r))).sort((a, b) => a - b)).toEqual([50, 100])
    // a lobe twisted clockwise is dropped, a long thin needle is kept
    const bow = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }]
    for (const r of simpleParts(bow)) expect(ringArea(r)).toBeGreaterThan(0)
    const needle = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 60, y: 0.4 }, { x: 20, y: 0.6 }, { x: 20, y: 20 }, { x: 0, y: 20 }]
    expect(simpleParts(needle)).toHaveLength(1); expect(simpleParts(needle)[0]).toHaveLength(6)
    for (const r of [spiked, pinched, bow]) for (const p of simpleParts(r)) expect(isSimple(p)).toBe(true)
  })
  it('wide flag skews widths to the wide end (max of two draws, mean ~30 vs 25)', () => {
    const piece = rectPoly(0, 0, 3000, 60)
    const mean = (wide?: true) => {
      const ws = stripLots(piece, sidesOf(piece), { depth: 12, width: [10, 40], wide, gap: null, sides: () => [0] }, mulberry32(3)).filter((l) => !l.filler && l.corner === undefined).map((l) => Math.hypot(l.chord[1].x - l.chord[0].x, l.chord[1].y - l.chord[0].y))
      return ws.reduce((t, w) => t + w, 0) / ws.length
    }
    expect(mean(true)).toBeGreaterThanOrEqual(26)
    expect(mean(true)).toBeGreaterThan(mean() + 2)
  })
  it('highway strip params: lots at least 35 m long on average, depth 14-30', () => {
    const piece = rectPoly(0, 0, 3000, 60), r = mulberry32(5)
    const lens: number[] = []
    for (let k = 0; k < 40; k++) {
      const p = STRIP_PARAMS.strip!(r)
      expect(p.depth).toBeGreaterThanOrEqual(14); expect(p.depth).toBeLessThanOrEqual(30)
      for (const l of stripLots(piece, sidesOf(piece), { ...p, sides: () => [0] }, r)) if (!l.filler && l.corner === undefined) lens.push(Math.hypot(l.chord[1].x - l.chord[0].x, l.chord[1].y - l.chord[0].y))
    }
    expect(lens.reduce((t, w) => t + w, 0) / lens.length).toBeGreaterThanOrEqual(35)
  })
})
