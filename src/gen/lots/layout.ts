import { difference, intersection, type Geom } from '../clip'
import { pointInRings, ringArea, ringCentroid, simplifyPolyline, type Pt } from '../geometry'
import type { Rng } from '../rng'
import type { BlockStyle, LotKind } from '../types'
import { compositeChance, makeComposite } from './composites'
import { boxRing, fitBox, holds, widthOk, type FitBox } from './fitbox'
import type { Side } from './setback'
import { chooseShape, cornerShape, fitShape, placeBoxes, sizeShape, type DensityClass, type SheetZone } from './shapes'
import { STRIP_PARAMS, simpleParts, stripLots, type StripLot } from './strips'
import { sidesOf } from './setback'
import { insetOrLargest } from '../streets/lots'

/*
 * Draw order (rng.lots / rng.shapes / rng.composites), fixed per fabric:
 * - strip fabrics: lots: depth, gap (once per block), then stripLots' own draws, then per non-filler lot the vacancy chance and
 *   (villas only) the pool chance and up to 12 pool tries; a lot repeating its side neighbour's shape and width draws its shape once more; in dense/packed perimeter, terrace, shophouse and rows the interior leftover then draws per
 *   rear ring gap, depth and stripLots' draws (rearRings), its lots' shapes as `building`. Per lot, shapes: chooseShape, sizeShape, (fitShape mirror); composites: chance, then
 *   makeComposite's draws. A composite wins over the drawn shape.
 * - zeilen: lots: twist sign, twist size, first offset, one spacing per further line; shapes: fitShape per slab.
 * - tower-park / plaza: lots: n, then per try size (w, d), x, y; shapes: chooseShape on a successful placement, fitShape.
 * - podium: lots: width and depth fractions, x, y; shapes: fitShape (mirror, base template, turn, then per tower kind, size, x, y). bigbox: lots: hall fraction; then as `building`. sheds: lots: n, gap, per hall w, d.
 * - garage: lots: which short end.
 * `building` (halls, strip lots): shapes chooseShape + sizeShape, composites chance (+ composite), shapes fitShape.
 */

export type Bld = { shape: string; footprint: Pt[]; details: Pt[][] }
export interface LotOut { poly: Pt[]; kind: LotKind; buildings: Bld[]; vacant?: true }
export interface BlockCtx { zone: SheetZone; density: DensityClass; rng: { lots: Rng; shapes: Rng; composites: Rng } }

const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y)
const ring = (p: Pt[]) => p.map((q) => [q.x, q.y] as [number, number])
const unring = (r: [number, number][]): Pt[] => r.slice(0, -1).map(([x, y]) => ({ x, y }))
const ccw = (r: Pt[]) => (ringArea(r) < 0 ? [...r].reverse() : r)
const circle = (c: Pt, r: number): Pt[] => Array.from({ length: 24 }, (_, i) => ({ x: c.x + r * Math.cos((i * Math.PI) / 12), y: c.y + r * Math.sin((i * Math.PI) / 12) }))
/** the box (x along its front, y inward) inside `f` at (x, y), w x d */
const sub = (f: FitBox, x: number, y: number, w: number, d: number): FitBox => {
  const c = Math.cos(f.angle), s = Math.sin(f.angle)
  return { origin: { x: f.origin.x + c * x - s * y, y: f.origin.y + s * x + c * y }, angle: f.angle, w, d }
}

const CONTINUOUS = new Set<BlockStyle>(['perimeter', 'terrace', 'shophouse'])
const MODE: Partial<Record<BlockStyle, 'continuous' | 'detached' | 'villas' | 'gapped'>> = { perimeter: 'continuous', terrace: 'continuous', shophouse: 'continuous', detached: 'detached', villas: 'villas', rows: 'gapped', strip: 'gapped' }
const HALLS = ['A1', 'A2', 'A3', 'A18']
const ALLOWED: Partial<Record<BlockStyle, string[]>> = {
  perimeter: ['A1', 'A2', 'A3', 'A20'], terrace: ['A1'], shophouse: ['A1', 'A3'], detached: ['A1', 'A2', 'A4', 'A20'],
  rows: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A10', 'A17', 'A20', 'A23'], villas: ['A1', 'A2', 'A4', 'A5', 'A6', 'A7', 'A10', 'A20'], strip: ['A1', 'A2', 'A3', 'A4', 'A6', 'A8', 'A20'], compound: ['A2', 'A3', 'A6', 'A9', 'A11'],
}

/** R30 */
export function lotKind(lot: Pt[], buildings: Pt[][], filler: LotKind): LotKind {
  const built = buildings.reduce((s, b) => s + Math.abs(ringArea(b)), 0)
  return 1 - built / Math.abs(ringArea(lot)) < 0.15 - 1e-9 ? 'building' : filler
}

/** R29; ponytail: commerce leftovers are parking and corp leftovers plazas (the spec lists both for commerce), mixed is yard */
export function fillerOf(fabric: BlockStyle, zone: SheetZone, where: 'interior' | 'gap' | 'corner' | 'margin' | 'apron'): LotKind {
  if (where === 'corner' || where === 'margin' || fabric === 'plaza') return 'plaza'
  if (where === 'apron' || fabric === 'garage') return 'parking'
  if (fabric === 'strip') return 'yard'
  if (['terrace', 'zeilen', 'detached', 'villas'].includes(fabric) || (fabric === 'tower-park' && zone === 'residential')) return 'green'
  return zone === 'residential' || zone === 'fringe' ? 'green' : zone === 'corp' ? 'plaza' : zone === 'commerce' || zone === 'industrial' ? 'parking' : 'yard'
}

/** shape choice, sizing (R24 fallback A1 at 0.85), composite chance; `whole` = the box as given */
function building(allowed: string[], fit: FitBox, mode: 'continuous' | 'detached' | 'villas' | 'gapped' | 'whole', fabric: BlockStyle, ctx: BlockCtx): Bld | null {
  const { zone, density, rng } = ctx
  const id = chooseShape(allowed, zone, density, fit, rng.shapes)
  let box = id ? (mode === 'whole' ? fit : sizeShape(id, fit, mode, rng.shapes)) : null
  let shape = id
  if (!id || !box) {
    const w = Math.floor(0.85 * fit.w), d = Math.floor(0.85 * fit.d)
    shape = 'A1'; box = w >= 6 && d >= 10 ? { ...fit, w, d } : null
  }
  const comp = rng.composites.chance(compositeChance(fabric, zone)) ? makeComposite(fit, zone, density, CONTINUOUS.has(fabric), rng.composites) : null
  return comp ?? (box && shape ? { shape, ...fitShape(shape, box, rng.shapes) } : null)
}

/** the corner quad (corner, projection, inner point, projection) of a four-vertex lot, or null */
function cornerQuad(lot: StripLot): Pt[] | null {
  const p = ccw(lot.poly)
  if (p.length !== 4) return null
  const ang = p.map((v, i) => {
    const a = p[(i + 3) % 4], b = p[(i + 1) % 4]
    return (Math.acos(Math.max(-1, Math.min(1, ((a.x - v.x) * (b.x - v.x) + (a.y - v.y) * (b.y - v.y)) / (dist(a, v) * dist(b, v))))) * 180) / Math.PI
  })
  const k = ang.reduce((b, a, i) => (Math.abs(a - lot.corner!) < Math.abs(ang[b] - lot.corner!) ? i : b), 0)
  return [p[k], p[(k + 1) % 4], p[(k + 2) % 4], p[(k + 3) % 4]]
}

/** continuous fronts: fitBox snaps to a 1 m grid, so stretch the box over the whole chord (party walls touch) when the lot still holds it */
function widen(fit: FitBox, lot: StripLot): FitBox {
  const u = { x: Math.cos(fit.angle), y: Math.sin(fit.angle) }
  const xs = lot.chord.map((p) => (p.x - fit.origin.x) * u.x + (p.y - fit.origin.y) * u.y)
  const x0 = Math.min(...xs), w = Math.max(...xs) - x0
  if (w <= fit.w + 1e-9) return fit
  const box = sub(fit, x0, 0, w, fit.d)
  return difference([ring(boxRing(box))], [ring(lot.poly)]).every((pg) => Math.abs(ringArea(unring(pg[0]))) < 1e-3) ? box : fit
}

/** per-lot step: corner rule (R26) -> shape -> size -> fit -> composite chance -> filler kind; also used for megablock rings */
export function buildLot(lot: StripLot, fabric: BlockStyle, ctx: BlockCtx, shapes?: string[], avoid?: { shape: string; w: number }): LotOut {
  const filler = (w: Parameters<typeof fillerOf>[2]) => fillerOf(fabric, ctx.zone, w)
  const none = (w: Parameters<typeof fillerOf>[2]): LotOut => ({ poly: lot.poly, kind: filler(w), buildings: [] })
  if (lot.filler) return none(lot.side < 0 ? 'interior' : 'gap')
  let fit = fitBox(lot.poly, lot.chord)
  if (CONTINUOUS.has(fabric) && !shapes) fit = widen(fit, lot)
  let b: Bld | null = null
  let direct = false
  const quad = lot.corner !== undefined ? cornerQuad(lot) : null
  if (quad) {
    const c = cornerShape(quad, lot.corner!, fabric, CONTINUOUS.has(fabric), Math.abs(ringArea(lot.poly)))
    if (c.id === 'A4' && holds(fit, 10, 10)) { b = { shape: 'A4', ...fitShape('A4', fit, ctx.rng.shapes) }; direct = true }
    else if (c.id && c.id !== 'A4') { b = { shape: c.id, footprint: c.footprint!, details: [] }; direct = true }
    else if (!c.id && !c.fit) return none('corner')
  }
  const draw = () => (shapes ? building(shapes, fit, 'gapped', fabric, ctx) : building(ALLOWED[fabric] ?? ['A1'], fit, MODE[fabric] ?? 'gapped', fabric, ctx))
  if (!direct) b = draw()
  // user review: the same shape at the same width as the previous lot on this side is drawn again, once
  if (!direct && b && avoid && b.shape === avoid.shape && frontWidth(b.footprint, lot.chord) === avoid.w) { const b2 = draw(); if (b2) b = b2 }
  if (!b) return none('interior')
  return { poly: lot.poly, kind: lotKind(lot.poly, [b.footprint], filler('interior')), buildings: [b] }
}

/** R29 pool: 4-6 x 8-12 m, 3 m clear of the house and the lot edge, 12 tries */
function pool(lot: LotOut, chord: [Pt, Pt], rng: Rng): LotOut[] {
  if (lot.kind !== 'green' || !lot.buildings.length || !rng.chance(0.4)) return []
  const fit = fitBox(lot.poly, chord), house: Geom = [ring(lot.buildings[0].footprint)]
  for (let t = 0; t < 12; t++) {
    const d = rng.int(4, 6), w = rng.int(8, 12)
    if (w > fit.w || d > fit.d) continue
    const x = rng.next() * (fit.w - w), y = rng.next() * (fit.d - d)
    const wide = ring(boxRing(sub(fit, x - 3, y - 3, w + 6, d + 6)))
    if (difference([wide], [ring(lot.poly)]).length || intersection([wide], house).length) continue
    return [{ poly: boxRing(sub(fit, x, y, w, d)), kind: 'pool', buildings: [] }]
  }
  return []
}

const whole = (piece: Pt[], fabric: BlockStyle, ctx: BlockCtx, bs: Bld[], where: Parameters<typeof fillerOf>[2] = 'interior'): LotOut[] =>
  [{ poly: piece, kind: lotKind(piece, bs.map((b) => b.footprint), fillerOf(fabric, ctx.zone, where)), buildings: bs }]

/** R15: up to 40 tries per building, >= 20 m apart; `size` draws a candidate w x d */
function scatter(fit: FitBox, n: number, size: () => [number, number] | null, allowed: string[], ctx: BlockCtx): Bld[] {
  const r = ctx.rng.lots, placed: number[][] = [], out: Bld[] = []
  for (let i = 0; i < n; i++) {
    for (let t = 0; t < 40; t++) {
      const sz = size()
      if (!sz) break
      const [w, d] = sz, x = r.int(0, Math.floor(fit.w - w)), y = r.int(0, Math.floor(fit.d - d))
      if (placed.some((p) => Math.hypot(Math.max(0, x - p[0] - p[2], p[0] - x - w), Math.max(0, y - p[1] - p[3], p[1] - y - d)) < 20)) continue
      const id = chooseShape(allowed, ctx.zone, ctx.density, { ...fit, w, d }, ctx.rng.shapes)
      if (!id) continue
      const dd = id === 'A13' ? Math.round(w * 0.65) : d
      placed.push([x, y, w, d])
      out.push({ shape: id, ...fitShape(id, sub(fit, x, y, w, dd), ctx.rng.shapes) })
      break
    }
  }
  return out
}

/** R14 */
function zeilen(piece: Pt[], chord: [Pt, Pt], ctx: BlockCtx): Bld[] {
  const r = ctx.rng.lots
  const ang = Math.atan2(chord[1].y - chord[0].y, chord[1].x - chord[0].x) + (r.chance(0.5) ? 1 : -1) * r.next() * (15 * Math.PI) / 180
  const c = Math.cos(ang), s = Math.sin(ang)
  const toF = (p: Pt): Pt => ({ x: p.x * c + p.y * s, y: -p.x * s + p.y * c })
  const fromF = (x: number, y: number): Pt => ({ x: x * c - y * s, y: x * s + y * c })
  const F = piece.map(toF), ymin = Math.min(...F.map((p) => p.y)), ymax = Math.max(...F.map((p) => p.y))
  const out: Bld[] = []
  let y = ymin + 6 + r.next() * 10
  for (; y + 6 <= ymax; y += r.int(25, 35)) {
    const band = intersection([ring(piece)], [ring([fromF(-1e5, y - 6), fromF(1e5, y - 6), fromF(1e5, y + 6), fromF(-1e5, y + 6)])])
    let best: [number, number] | null = null
    for (const pg of band) {
      const P = unring(pg[0]).map(toF)
      const len = (x: number) => {
        const ys: number[] = []
        P.forEach((a, i) => { const b = P[(i + 1) % P.length]; if (a.x <= x !== b.x <= x) ys.push(a.y + ((x - a.x) / (b.x - a.x)) * (b.y - a.y)) })
        ys.sort((p, q) => p - q)
        let l = 0
        for (let i = 0; i + 1 < ys.length; i += 2) l += ys[i + 1] - ys[i]
        return l
      }
      const xs = [...new Set([...P.map((p) => p.x), ...Array.from({ length: Math.ceil(Math.max(...P.map((p) => p.x))) - Math.floor(Math.min(...P.map((p) => p.x))) + 1 }, (_, k) => Math.floor(Math.min(...P.map((p) => p.x))) + k)])].sort((a, b) => a - b)
      let run: [number, number] | null = null
      const close = () => { if (run && (!best || run[1] - run[0] > best[1] - best[0])) best = run; run = null }
      for (let i = 0; i + 1 < xs.length; i++) {
        if (xs[i + 1] - xs[i] < 1e-6) continue
        if (len(xs[i] + 1e-6) >= 12 - 1e-3 && len(xs[i + 1] - 1e-6) >= 12 - 1e-3) run = run ? [run[0], xs[i + 1]] : [xs[i], xs[i + 1]]
        else close()
      }
      close()
    }
    if (!best) continue
    const [a, b] = best as [number, number], L = Math.floor(Math.min(80, b - a))
    if (L < 40) continue
    const x0 = a + (b - a - L) / 2
    out.push({ shape: 'A3', ...fitShape('A3', { origin: fromF(x0, y - 6), angle: ang, w: L, d: 12 }, ctx.rng.shapes) })
  }
  return out
}

function bigbox(piece: Pt[], chord: [Pt, Pt], fabric: BlockStyle, ctx: BlockCtx): LotOut[] {
  const fit = fitBox(piece, chord), f = 0.5 + 0.2 * ctx.rng.lots.next()
  const hw = Math.floor(fit.w * f), hd = Math.floor(fit.d * f), box = sub(fit, Math.floor((fit.w - hw) / 2), fit.d - hd, hw, hd)
  const hall = building(HALLS, box, 'whole', fabric, ctx)
  const half = ring(boxRing(sub(fit, -1e4, fit.d - hd, 2e4, 1e4)))
  const polyOf = (pg: [number, number][][]) => ccw(unring(pg[0]))
  const out: LotOut[] = []
  const hc = hall ? ringCentroid(hall.footprint) : null
  for (const pg of difference([ring(piece)], [half])) if (Math.abs(ringArea(polyOf(pg))) >= 1) out.push({ poly: polyOf(pg), kind: fillerOf(fabric, ctx.zone, 'apron'), buildings: [] })
  for (const pg of intersection([ring(piece)], [half])) {
    const poly = polyOf(pg)
    if (Math.abs(ringArea(poly)) < 1) continue
    const mine = hall && hc && pointInRings(hc, [poly]) ? [hall] : []
    out.push(mine.length ? { poly, kind: lotKind(poly, [hall!.footprint], 'yard'), buildings: mine } : { poly, kind: fillerOf(fabric, ctx.zone, 'apron'), buildings: [] })
  }
  return out
}

function sheds(piece: Pt[], chord: [Pt, Pt], fabric: BlockStyle, ctx: BlockCtx): Bld[] {
  const fit = fitBox(piece, chord), r = ctx.rng.lots
  let n = r.int(1, 3), g = r.int(8, 20)
  while (n > 1 && n * 30 + (n - 1) * 8 > fit.w) n--
  if (n * 30 + (n - 1) * g > fit.w) g = 8
  const maxW = Math.floor((fit.w - (n - 1) * g) / n), maxD = Math.floor(fit.d)
  if (maxW < 30 || maxD < 30) return []
  const ws = Array.from({ length: n }, () => [r.int(30, Math.min(80, maxW)), r.int(30, Math.min(80, maxD))])
  let x = Math.floor((fit.w - ws.reduce((s, w) => s + w[0], 0) - (n - 1) * g) / 2)
  const out: Bld[] = []
  for (const [w, d] of ws) {
    const h = building(HALLS, sub(fit, x, 0, w, d), 'whole', fabric, ctx)
    if (h) out.push(h)
    x += w + g
  }
  return out
}

/** a counter-clockwise ring with its edges under 3 m cut away at a convex end (the cut stays inside); arc runs keep theirs */
function trimShortEdges(r0: Pt[]): Pt[] {
  const r = r0.slice()
  const turn = (i: number) => { const n = r.length, a = r[(i + n - 1) % n], b = r[i], c = r[(i + 1) % n]; return Math.atan2((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x), (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) }
  const arc = (i: number) => Math.abs(turn(i)) <= (15.5 * Math.PI) / 180
  for (let guard = r0.length; guard > 0 && r.length > 4; guard--) {
    const n = r.length
    const i = r.findIndex((p, k) => dist(p, r[(k + 1) % n]) < 3 && !(arc(k) && arc((k + 1) % n)) && (turn(k) > 0 || turn((k + 1) % n) > 0))
    if (i < 0) break
    r.splice(turn(i) > 0 ? i : (i + 1) % n, 1)
  }
  return r
}

/**
 * User review (D10): a dense core block as one built mass. The piece is cut by 2-6 lines across it, perpendicular to its
 * longest side, 15-45 m apart, into unequal masses (party walls); a mass under 60 m2, narrower than 8 m or a triangle merges
 * into its neighbour (its cut goes). Masses over 900 m2 get 1-3 lightwells 6-14 m, over 2500 m2 one courtyard 14-30 m
 * (4 m in, 4 m apart, 2 m grid), drawn as details; in packed corp/commerce a block carries 1-2 towers 20-30 m on its
 * largest mass (shape 'B1T') with probability 0.3. Draw order: lots: cut count, spacings, tower chance, tower count;
 * shapes: per mass lightwell or courtyard count and sizes and positions, then the towers.
 */
function blockfill(piece: Pt[], chord: [Pt, Pt], ctx: BlockCtx): LotOut[] {
  const r = ctx.rng.lots, ang = Math.atan2(chord[1].y - chord[0].y, chord[1].x - chord[0].x), c = Math.cos(ang), sn = Math.sin(ang)
  const toF = (p: Pt): Pt => ({ x: p.x * c + p.y * sn, y: -p.x * sn + p.y * c })
  const fromF = (p: Pt): Pt => ({ x: p.x * c - p.y * sn, y: p.x * sn + p.y * c })
  const F = piece.map(toF), x0 = Math.min(...F.map((p) => p.x)), x1 = Math.max(...F.map((p) => p.x)), y0 = Math.min(...F.map((p) => p.y)) - 1, y1 = Math.max(...F.map((p) => p.y)) + 1
  const n = r.int(2, 6), cuts: number[] = []
  for (let x = x0 + 15 + 30 * r.next(); cuts.length < n && x < x1 - 15; x += 15 + 30 * r.next()) cuts.push(x)
  const ok = (m: Pt[]) => m.length > 3 && ringArea(m) >= 60 && widthOk(m, 8)
  const massesOf = (cs: number[]) => {
    const xs = [x0 - 1, ...cs, x1 + 1]
    return xs.slice(1).flatMap((b, i) => intersection([ring(piece)], [ring([{ x: xs[i], y: y0 }, { x: b, y: y0 }, { x: b, y: y1 }, { x: xs[i], y: y1 }].map(fromF))])
      .flatMap((pg) => simpleParts(ccw(unring(pg[0])))).map((poly) => ({ band: i, poly })))
  }
  let cs = cuts, ms = massesOf(cs)
  for (let bad = ms.find((m) => !ok(m.poly)); bad && cs.length; bad = ms.find((m) => !ok(m.poly))) { // each pass drops a cut: bounded by n
    const drop = Math.min(bad.band, cs.length - 1) // band i lies between cut i - 1 and cut i: merge it across cut i, the last band across the last cut
    cs = cs.filter((_, k) => k !== drop)
    ms = massesOf(cs)
  }
  const towered = (ctx.zone === 'corp' || ctx.zone === 'commerce') && ctx.density === 'packed' && r.chance(0.3)
  const nt = towered ? r.int(1, 2) : 0
  const big = ms.reduce((b, m, i) => (ringArea(m.poly) > ringArea(ms[b].poly) ? i : b), 0)
  const rs = ctx.rng.shapes
  return ms.map((m, i): LotOut => {
    if (!ok(m.poly)) return { poly: m.poly, kind: fillerOf('blockfill', ctx.zone, 'interior'), buildings: [] }
    const fp = trimShortEdges(m.poly), local = fp.map(toF), a = ringArea(fp)
    const lw = Math.max(...local.map((p) => p.x)) - Math.min(...local.map((p) => p.x)), ld = Math.max(...local.map((p) => p.y)) - Math.min(...local.map((p) => p.y))
    let k = 0
    const fitW = (v: number, side: number) => Math.min(v, Math.max(6, 2 * Math.floor((side - 8) / 2))) // a well needs 4 m of wall each side: shrink to what the slab holds (not below 6)
    const boxes = i === big && nt ? placeBoxes(local, nt, () => { const t = rs.int(20, 30); return [t, t] }, 4, 6, rs)
      : a > 2500 ? placeBoxes(local, 1, () => { const sh = 2 * Math.floor(k++ / 4); return [Math.max(6, fitW(2 * rs.int(7, 15), lw) - sh), Math.max(6, fitW(2 * rs.int(7, 15), ld) - sh)] }, 4, 4, rs) // courtyard, shrinking to a lightwell on thin slabs
        : a > 900 ? placeBoxes(local, rs.int(1, 3), () => { const sh = 2 * Math.floor(k++ / 8); return [Math.max(6, fitW(2 * rs.int(3, 7), lw) - sh), Math.max(6, fitW(2 * rs.int(3, 7), ld) - sh)] }, 4, 4, rs) : []
    const details = boxes.map(([x, y, w, d]) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + d }, { x, y: y + d }].map(fromF))
    return { poly: m.poly, kind: lotKind(m.poly, [fp], fillerOf('blockfill', ctx.zone, 'interior')), buildings: [{ shape: i === big && nt ? 'B1T' : 'B1', footprint: fp, details }] }
  })
}

/** user review: the chance a strip lot stays vacant, per density class */
export const VACANT: Record<DensityClass, number> = { sparse: 0.15, dense: 0.05, packed: 0.02 }
/** a footprint's extent along the chord, whole metres */
export const frontWidth = (fp: Pt[], chord: [Pt, Pt]): number => {
  const l = dist(...chord) || 1, ux = (chord[1].x - chord[0].x) / l, uy = (chord[1].y - chord[0].y) / l, xs = fp.map((p) => p.x * ux + p.y * uy)
  return Math.round(Math.max(...xs) - Math.min(...xs))
}

const REAR = new Set<BlockStyle>(['perimeter', 'terrace', 'shophouse', 'rows'])
const REAR_SHAPES = ['A1', 'A2', 'A3', 'A20']
/** inset by d and simplified at 1 m (the offset leaves slivers and doubled vertices), or null when the inset is gone or point-reflected */
const insetBy = (r: Pt[], d: number): Pt[] | null => {
  const q = insetOrLargest(r, d)
  if (!q || q.length < 3 || ringArea(ccw(q)) <= 1 || !q.every((p) => pointInRings(p, [r]))) return null
  const c = ccw(q), s = simplifyPolyline([...c, c[0]], 1).slice(0, -1)
  const parts = simpleParts(s.length >= 3 ? s : c)
  return parts.length ? parts.reduce((b, p) => (ringArea(p) > ringArea(b) ? p : b)) : null
}
/**
 * User review (D7): in dense and packed blocks the interior left by the frontage strips is lotted again behind a 4 m lane,
 * ring after ring (depth 10-16, frontage 8-20, gap 2-4, A1/A2/A3/A20 sized 'gapped'), while the leftover holds a
 * 20 x 20 m box and 600 m2; the last leftover is yard (green in residential). The lane stays unlotted.
 */
function rearRings(leftover: Pt[], fabric: BlockStyle, ctx: BlockCtx): LotOut[] {
  const yard = (poly: Pt[]): LotOut => ({ poly, kind: ctx.zone === 'residential' ? 'green' : 'yard', buildings: [] })
  const out: LotOut[] = []
  let rest = [ccw(leftover)]
  for (let ring = 0; ring < 6 && rest.length; ring++) { // ponytail: 6 rings bound the loop; a 600 m2 floor ends it long before
    const next: Pt[][] = []
    for (const poly of rest) {
      const inner = Math.abs(ringArea(poly)) >= 600 && holds(fitBox(poly, longestEdge(poly)), 20, 20) ? insetBy(poly, 4) : null
      if (!inner) { out.push(yard(poly)); continue }
      const r = ctx.rng.lots, g = r.int(2, 4)
      for (const l of stripLots(inner, sidesOf(inner), { depth: r.int(10, 16), width: [8, 20], gap: [g, g] }, r)) {
        if (l.filler && l.side < 0) { next.push(l.poly); continue }
        out.push(buildLot({ ...l, corner: undefined }, fabric, ctx, REAR_SHAPES))
      }
    }
    rest = next
  }
  for (const poly of rest) out.push(yard(poly))
  return out
}
const longestEdge = (r: Pt[]): [Pt, Pt] => r.map((p, i): [Pt, Pt] => [p, r[(i + 1) % r.length]]).reduce((b, e) => (dist(...e) > dist(...b) ? e : b))

/** §3.4 / R13-R15, R23-R30 for every fabric but megablock and compound */
export function layoutPiece(piece: Pt[], sides: Side[], fabric: BlockStyle, ctx: BlockCtx): LotOut[] {
  const strips = STRIP_PARAMS[fabric]
  if (strips) {
    const rng = ctx.rng.lots
    const lots = stripLots(piece, sides, strips(rng), rng)
    const rear = REAR.has(fabric) && ctx.density !== 'sparse'
    let prev: { side: number; shape: string; w: number } | null = null
    return lots.flatMap((l) => {
      if (rear && l.filler && l.side < 0) return rearRings(l.poly, fabric, ctx)
      // user review: a strip lot stays vacant now and then (R29 filler)
      if (!l.filler && rng.chance(VACANT[ctx.density])) { prev = null; return [{ poly: l.poly, kind: fillerOf(fabric, ctx.zone, 'interior'), buildings: [], vacant: true as const }] }
      const o = buildLot(l, fabric, ctx, undefined, prev && prev.side === l.side ? prev : undefined)
      const b = o.buildings[0]
      prev = b ? { side: l.side, shape: b.shape, w: frontWidth(b.footprint, l.chord) } : null
      return [o, ...(fabric === 'villas' ? pool(o, l.chord, rng) : [])]
    })
  }
  const chord = sides.reduce((b, s) => (dist(...s.chord) > dist(...b.chord) ? s : b)).chord
  const fit = () => fitBox(piece, chord), r = ctx.rng.lots
  switch (fabric) {
    case 'zeilen': return whole(piece, fabric, ctx, zeilen(piece, chord, ctx))
    case 'tower-park': {
      const f = fit(), cap = Math.floor(Math.min(f.w, f.d))
      return whole(piece, fabric, ctx, scatter(f, Math.min(8, Math.max(2, Math.round(f.w * f.d / 3500))), () => { const s = Math.min(r.int(24, 36), cap); return [s, s] }, ['A2', 'A11', 'A12', 'A13', 'A14'], ctx))
    }
    case 'plaza': {
      const f = fit(), hw = Math.floor(0.4 * f.w), hd = Math.floor(0.4 * f.d)
      return whole(piece, fabric, ctx, scatter(f, r.int(0, 2), () => (hw < 16 || hd < 16 ? null : [r.int(16, hw), r.int(16, hd)]), ['A11', 'A12', 'A14', 'A17', 'A21', 'A22', 'A23'], ctx))
    }
    case 'podium': { // user review: 0.45-0.65 of the fit box a side (40 m floor, 90 m cap), anywhere in it on the 2 m grid; the rest plaza, green in residential
      const f = fit(), side = (v: number) => Math.min(v, Math.max(40, Math.min(90, Math.floor(v * (0.45 + 0.2 * r.next())))))
      const w = side(f.w), d = side(f.d), x = 2 * r.int(0, Math.floor((f.w - w) / 2)), y = 2 * r.int(0, Math.floor((f.d - d) / 2))
      return whole(piece, fabric, ctx, [{ shape: 'A19', ...fitShape('A19', sub(f, x, y, w, d), ctx.rng.shapes) }], ctx.zone === 'residential' ? 'interior' : 'margin')
    }
    case 'blockfill': return blockfill(piece, chord, ctx)
    case 'bigbox': return bigbox(piece, chord, fabric, ctx)
    case 'sheds': return whole(piece, fabric, ctx, sheds(piece, chord, fabric, ctx))
    case 'garage': {
      const f = fit()
      if (!holds(f, 60, 40) || f.w < 60) return [{ poly: piece, kind: 'parking', buildings: [] }]
      const box = sub(f, Math.floor((f.w - 60) / 2), 0, 60, 40), cx = r.chance(0.5) ? 16 : 44, at = (x: number, y: number) => sub(box, x, y, 0, 0).origin
      const ringAt = (rad: number) => circle(at(cx, 20), rad)
      return [{ poly: piece, kind: 'parking', buildings: [{ shape: 'F14', footprint: boxRing(box), details: [ringAt(10), ringAt(2)] }] }]
    }
  }
  throw new Error(`layoutPiece: no layout for ${fabric}`)
}
