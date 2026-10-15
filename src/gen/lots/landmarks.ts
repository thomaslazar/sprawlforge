import * as clip from '../clip'
import { bboxOf, bspSplit, ringArea, ringCentroid, rotatePt, type Pt } from '../geometry'
import type { Rng } from '../rng'
import { distToPolyline } from '../terrain/rivers'
import { clipSegmentToRing, insetOrLargest, longestEdgeAngle } from '../streets/lots'
import { fitBox, boxRing, holds, widthOk } from './fitbox'
import { buildLot, type BlockCtx, type LotOut } from './layout'
import { sidesOf, type Side } from './setback'
import { STRIP_PARAMS, stripLots } from './strips'

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
const insideOf = (inner: Pt[], outer: Pt[]) => clip.difference([toRing(inner)], [toRing(outer)]).every((pg) => Math.abs(ringArea(fromRing(pg[0]))) < 0.01)

const octagon = (c: Pt, r: number, theta: number): Pt[] =>
  Array.from({ length: 8 }, (_, k) => { const a = theta - Math.PI / 2 - Math.PI / 8 + (k * Math.PI) / 4; return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) } })

/** the core of R16 at scale s; `rect` = block-aligned rectangle of the octagon's area with the piece's aspect */
function coreAt(c: Pt, r: number, theta: number, aspect: number, rect: boolean): Pt[] {
  if (!rect) return octagon(c, r, theta)
  const area = 2 * Math.SQRT2 * r * r, w = Math.sqrt(area * aspect), h = area / w
  return [[-w, -h], [w, -h], [w, h], [-w, h]].map(([x, y]) => rotatePt({ x: c.x + x / 2, y: c.y + y / 2 }, theta, c))
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
 * Draw order: rng (arg): rectangle-or-octagon chance, then the hive BSP's jitters. ctx.rng.lots: perimeter strip depth,
 * stripLots' draws; ctx.rng.shapes/composites inside buildLot for the ring lots. Compound: rng (arg): stripLots' draws (depth is fixed, min(60, fit depth)), then n in 2-4; shapes/composites inside buildLot.
 */

/** insetOrLargest, minus the point-reflected ring insetRing returns for a piece thinner than 2d (its vertices sit inside, but < d from the boundary) */
function inner(piece: Pt[], d: number): Pt[] | null {
  const r = insetOrLargest(piece, d), closed = [...piece, piece[0]]
  return r && r.every((p) => distToPolyline(p, closed) >= d - 0.5) ? r : null
}

/** R16: octagon or equal-area rectangle core, perimeter ring around it, hive BSP inside */
export function megablockLots(piece: Pt[], sides: Side[], radius: number, ctx: BlockCtx, rng: Rng): { core: Pt[]; lots: LotOut[]; alleys: Array<[Pt, Pt]> } {
  const rect = rng.chance(0.5)
  const inset = inner(piece, 26)
  // a piece with no 26 m inset: the core is its 6 m fit box (no hive, no ring) over one plaza lot; a megablock never vanishes
  if (!inset) {
    const p = ccw(piece), small = inner(p, 6)
    const core = small ? boxRing(fitBox(ccw(small), sidesOf(ccw(small)).reduce((b, x) => (dist(...x.chord) > dist(...b.chord) ? x : b)).chord)) : p
    return { core, lots: [{ poly: p, kind: 'plaza', buildings: [] }], alleys: [] }
  }
  const theta = longestEdgeAngle(piece), c = ringCentroid(piece)
  const rot = piece.map((p) => rotatePt(p, -theta, c)), bb = bboxOf(rot), aspect = bb.w / bb.h
  let core: Pt[] | null = null
  for (let s = 1; s >= 0.6 - 1e-9; s -= 0.05) {
    const cand = coreAt(c, radius * s, theta, aspect, rect)
    if (insideOf(cand, inset)) { core = cand; break }
  }
  if (!core) { const ic = ccw(inset), chord = sidesOf(ic).reduce((b, x) => (dist(...x.chord) > dist(...b.chord) ? x : b)).chord; core = boxRing(fitBox(ic, chord)) }

  const lots: LotOut[] = []
  // ring: outer strips from the buildable's sides, inner strips outward from core + 6 m; the leftover is yard
  const hole = ccw(outset(core, 6))
  for (const l of stripLots(piece, sides, STRIP_PARAMS.perimeter!(ctx.rng.lots), ctx.rng.lots, [hole])) {
    const o = buildLot(l, 'perimeter', ctx)
    lots.push(l.filler && l.side < 0 ? { ...o, kind: 'yard' } : o)
  }

  // hive: BSP in the core frame, cells clipped to the core only
  const cc = ringCentroid(core), ht = longestEdgeAngle(core)
  const bsp = bspSplit(bboxOf(core.map((p) => rotatePt(p, -ht, cc))), { minCell: 30, gap: 2, jitter: 0.3, rng })
  for (const r of bsp.cells) {
    const cell = [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }].map((p) => rotatePt(p, ht, cc))
    const poly = largestRing(clip.intersection([toRing(cell)], [toRing(core)]))
    if (!poly) continue
    const edgeAt = (k: number): [Pt, Pt] => [poly[k], poly[(k + 1) % poly.length]]
    const edgeMin = Math.min(...poly.map((_, k) => dist(...edgeAt(k))))
    const front = poly.map((_, k) => edgeAt(k)).reduce((b, e) => (dist(...e) > dist(...b) ? e : b))
    const ok = Math.abs(ringArea(poly)) >= 60 && edgeMin >= 3 && widthOk(poly, 6) && holds(fitBox(poly, front), 6, 8)
    lots.push(ok ? { poly, kind: 'building', buildings: [{ shape: 'hive', footprint: poly, details: [] }] } : { poly, kind: 'plaza', buildings: [] })
  }
  const alleys = bsp.cuts.map(({ axis, strip }) => {
    const [a, b] = axis === 'x' ? [{ x: strip.x + strip.w / 2, y: strip.y }, { x: strip.x + strip.w / 2, y: strip.y + strip.h }] : [{ x: strip.x, y: strip.y + strip.h / 2 }, { x: strip.x + strip.w, y: strip.y + strip.h / 2 }]
    const segs = clipSegmentToRing(rotatePt(a, ht, cc), rotatePt(b, ht, cc), core)
    return { segs, len: segs.reduce((t, [p, q]) => t + dist(p, q), 0) }
  }).sort((x, y) => y.len - x.len).slice(0, 3).flatMap((k) => k.segs)
  return { core, lots, alleys }
}

/** R17: fence and gate as before; 2-4 shaped lots in the 14 m inset, the rest yard; null = fall back to a normal block */
export function compoundLots(footprint: Pt[], gateToward: Pt, ctx: BlockCtx, rng: Rng, clear: Pt[][] = []): { fence: Pt[]; gate: [Pt, Pt]; lots: LotOut[] } | null {
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
  const raw = insetOrLargest(footprint, 14)
  if (!raw) return null
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
    const o = buildLot(l, 'compound', ctx)
    // a mitered fence bulges at acute block corners: a building crowding it goes back to yard
    // ... and so does one inside a road's setback strip (the 14 m inset is short of an arterial's or the highway's)
    const crowds = (b: Pt[]) => b.some((p) => distToPolyline(p, closed) < COMPOUND_CLEAR) || clear.some((c) => clip.intersection([toRing(b)], [toRing(c)]).length > 0)
    if (!o.buildings.length || o.buildings.some((b) => crowds(b.footprint))) { lots.push(yard); continue }
    lots.push(o); taken++
  }
  return taken < 2 ? null : { fence, gate, lots }
}
