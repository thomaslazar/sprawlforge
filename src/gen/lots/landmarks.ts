import * as clip from '../clip'
import { bboxOf, bspSplit, ringArea, ringCentroid, rotatePt, type Pt } from '../geometry'
import type { Rng } from '../rng'
import { distToPolyline } from '../terrain/rivers'
import { clipSegmentToRing, insetOrLargest, longestEdgeAngle } from '../streets/lots'
import { accepted, fitBox, holds } from './fitbox'
import { buildLot, type BlockCtx, type LotOut } from './layout'
import { sidesOf } from './setback'
import { stripLots } from './strips'

const COMPOUND_GATE = 12
/** a compound building keeps at least this far (m) from the fence */
const COMPOUND_CLEAR = 8

const toRing = (p: Pt[]) => p.map((q) => [q.x, q.y] as [number, number])
const fromRing = (r: [number, number][]): Pt[] => r.slice(0, -1).map(([x, y]) => ({ x, y }))
const ccw = (r: Pt[]) => (ringArea(r) < 0 ? [...r].reverse() : r)
const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y)
/** largest outer ring of a clip result, counter-clockwise */
const largestRing = (g: clip.MultiPolygon): Pt[] | null => {
  let best: Pt[] | null = null
  for (const pg of g) { const r = fromRing(pg[0]); if (!best || Math.abs(ringArea(r)) > Math.abs(ringArea(best))) best = r }
  return best && ccw(best)
}
/** the core pushed out by d (octagon and rectangle only: every edge moves d along its normal) */
export const outset = (core: Pt[], d: number): Pt[] => {
  const n = core.length
  return core.map((p, i) => {
    const a = core[(i + n - 1) % n], b = core[(i + 1) % n], u = { x: (p.x - a.x) / dist(a, p), y: (p.y - a.y) / dist(a, p) }, v = { x: (b.x - p.x) / dist(p, b), y: (b.y - p.y) / dist(p, b) }
    const n1 = { x: u.y, y: -u.x }, n2 = { x: v.y, y: -v.x }, k = d / (1 + n1.x * n2.x + n1.y * n2.y)
    return { x: p.x + (n1.x + n2.x) * k, y: p.y + (n1.y + n2.y) * k }
  })
}

/*
 * Draw order: megablock: rng (arg): the hive BSP's jitters. Compound: rng (arg): stripLots' draws (depth is fixed, min(60, fit depth)), then n in 2-4; shapes/composites inside buildLot, up to 3 draws per lot until one passes.
 */

/** R16 as the user ruled it (the old chaotic look): the hive BSP fills the whole buildable piece, every cell through the acceptance gate (a failing cell is a plaza lot); `core` is the piece */
export function megablockLots(piece: Pt[], rng: Rng): { core: Pt[]; lots: LotOut[]; alleys: Array<[Pt, Pt]> } {
  const core = ccw(piece), cc = ringCentroid(core), ht = longestEdgeAngle(core)
  const lots: LotOut[] = []
  const bsp = bspSplit(bboxOf(core.map((p) => rotatePt(p, -ht, cc))), { minCell: 30, gap: 2, jitter: 0.3, rng })
  for (const r of bsp.cells) {
    const cell = [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }].map((p) => rotatePt(p, ht, cc))
    for (const pg of clip.intersection([toRing(cell)], [toRing(core)])) {
      const poly = ccw(fromRing(pg[0]))
      if (Math.abs(ringArea(poly)) < 1) continue
      const front = poly.map((p, k): [Pt, Pt] => [p, poly[(k + 1) % poly.length]]).reduce((b, e) => (dist(...e) > dist(...b) ? e : b))
      const ok = poly.length > 3 && accepted(poly) && holds(fitBox(poly, front), 6, 8) // a triangle cut by the piece is plaza (T10: triangles are A16 only)
      lots.push(ok ? { poly, kind: 'building', buildings: [{ shape: 'hive', footprint: poly, details: [] }] } : { poly, kind: 'plaza', buildings: [] })
    }
  }
  const alleys = bsp.cuts.map(({ axis, strip }) => {
    const [a, b] = axis === 'x' ? [{ x: strip.x + strip.w / 2, y: strip.y }, { x: strip.x + strip.w / 2, y: strip.y + strip.h }] : [{ x: strip.x, y: strip.y + strip.h / 2 }, { x: strip.x + strip.w, y: strip.y + strip.h / 2 }]
    const segs = clipSegmentToRing(rotatePt(a, ht, cc), rotatePt(b, ht, cc), core)
    return { segs, len: segs.reduce((t, [p, q]) => t + dist(p, q), 0) }
  }).sort((x, y) => y.len - x.len).slice(0, 3).flatMap((k) => k.segs)
  return { core, lots, alleys }
}

/** R17: fence and gate as before; 2-4 shaped lots in the 14 m inset, the rest yard; null = fall back to a normal block */
export function compoundLots(footprint: Pt[], gateToward: Pt, ctx: BlockCtx, rng: Rng, within?: Pt[][]): { fence: Pt[]; gate: [Pt, Pt]; lots: LotOut[] } | null {
  const fence = insetOrLargest(footprint, 4)
  if (!fence || fence.length < 3) return null
  const edges = fence.map((p, i) => ({ a: p, b: fence[(i + 1) % fence.length] }))
  const len = (e: { a: Pt; b: Pt }) => Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y)
  const mid = (e: { a: Pt; b: Pt }) => ({ x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 })
  const d2 = (e: { a: Pt; b: Pt }) => Math.hypot(mid(e).x - gateToward.x, mid(e).y - gateToward.y)
  const wide = edges.filter((e) => len(e) >= COMPOUND_GATE + 2)
  const edge = (wide.length > 0 ? wide : edges).reduce((best, e) => (wide.length > 0 ? (d2(e) < d2(best) ? e : best) : len(e) > len(best) ? e : best))
  const m = mid(edge), L = len(edge), ux = (edge.b.x - edge.a.x) / L, uy = (edge.b.y - edge.a.y) / L
  const gate: [Pt, Pt] = [{ x: m.x - (ux * COMPOUND_GATE) / 2, y: m.y - (uy * COMPOUND_GATE) / 2 }, { x: m.x + (ux * COMPOUND_GATE) / 2, y: m.y + (uy * COMPOUND_GATE) / 2 }]

  // from the footprint, not the fence: clipping the fence's many offset vertices again can stall the clipper
  // within the block's buildable (less the road strips): the highway's setback reaches past the 14 m inset
  const raw0 = insetOrLargest(footprint, 14)
  const raw = raw0 && within ? largestRing(clip.intersection([toRing(raw0)], within.map((w) => [toRing(w)]))) : raw0
  if (!raw || Math.abs(ringArea(raw)) < 200) return null
  const inner = ccw(raw), isides = sidesOf(inner), li = isides.reduce((b, s, i) => (dist(...s.chord) > dist(...isides[b].chord) ? i : b), 0)
  const depth = Math.min(60, fitBox(inner, isides[li].chord).d)
  const closed = [...fence, fence[0]], r = rng
  const strips = stripLots(inner, isides, { depth, width: [30, 60], gap: [10, 10], sides: () => [li] }, r)
  const want = r.int(2, 4)
  const lots: LotOut[] = []
  let taken = 0
  for (const l of strips) {
    const yard: LotOut = { poly: l.poly, kind: 'yard', buildings: [] }
    if (l.filler || taken >= want || !holds(fitBox(l.poly, l.chord), 20, 20)) { lots.push(yard); continue }
    // a mitered fence bulges at acute block corners: a building crowding it fails, as does one the acceptance gate rejects; 3 draws, then yard
    const ok = (b: Pt[]) => accepted(b) && !b.some((p) => distToPolyline(p, closed) < COMPOUND_CLEAR)
    let o: LotOut | null = null
    for (let t = 0; t < 3 && !o; t++) { const c = buildLot(l, 'compound', ctx); if (c.buildings.length && c.buildings.every((b) => ok(ccw(b.footprint)))) o = c }
    if (!o) { lots.push(yard); continue }
    lots.push(o); taken++
  }
  return taken < 2 ? null : { fence, gate, lots }
}
