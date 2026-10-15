import { difference, intersection, type Geom } from '../clip'
import { boxOf, ringArea, type Box, type Pt } from '../geometry'
import type { Rng } from '../rng'
import { fitBox, holds } from './fitbox'
import { sidesOf, type Side } from './setback'

export interface StripParams { depth: number; width: [number, number]; gap: [number, number] | null; sides?: (s: Side[]) => number[] }
/** `corner` = interior angle in degrees; `filler` = gap, interior leftover or failed merge */
export interface StripLot { poly: Pt[]; chord: [Pt, Pt]; side: number; corner?: number; filler?: boolean }

const CORNER_MAX = 155
const EPS = 1e-6
const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y)
const unit = (a: Pt, b: Pt): Pt => { const l = dist(a, b) || 1; return { x: (b.x - a.x) / l, y: (b.y - a.y) / l } }
const left = (d: Pt): Pt => ({ x: -d.y, y: d.x })
/** offset vector of length-k offset lines meeting at a vertex between edges with inward normals n1, n2 */
const miter = (n1: Pt, n2: Pt, k: number): Pt => {
  const f = k / Math.max(0.1, 1 + n1.x * n2.x + n1.y * n2.y)
  return { x: (n1.x + n2.x) * f, y: (n1.y + n2.y) * f }
}
const ring = (p: Pt[]) => p.map((q) => [q.x, q.y] as [number, number])
const unring = (r: [number, number][]): Pt[] => r.slice(0, -1).map(([x, y]) => ({ x, y }))
const overlaps = (a: Box, b: Box) => a.x0 < b.x1 - 0.01 && b.x0 < a.x1 - 0.01 && a.y0 < b.y1 - 0.01 && b.y0 < a.y1 - 0.01
const longest = (r: Pt[]): [Pt, Pt] => {
  let best: [Pt, Pt] = [r[0], r[1 % r.length]]
  r.forEach((a, i) => { const b = r[(i + 1) % r.length]; if (dist(a, b) > dist(...best)) best = [a, b] })
  return best
}

/** point at arc length s along a polyline */
function atArc(pts: Pt[], s: number): Pt {
  let c = 0
  for (let i = 0; i + 1 < pts.length; i++) {
    const l = dist(pts[i], pts[i + 1])
    if (s <= c + l || i + 2 === pts.length) { const d = unit(pts[i], pts[i + 1]), t = Math.min(Math.max(s - c, 0), l); return { x: pts[i].x + d.x * t, y: pts[i].y + d.y * t } }
    c += l
  }
  return pts[0]
}

/** how far the inward normal from the midpoint of the longest edge runs before meeting another edge */
function depthAt(r: Pt[]): number {
  const [a, b] = longest(r), d = unit(a, b), nr = left(d), m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  let t = Infinity
  r.forEach((c, i) => {
    const e = r[(i + 1) % r.length], ex = e.x - c.x, ey = e.y - c.y, den = nr.x * ey - nr.y * ex
    if (Math.abs(den) < 1e-12) return
    const s = ((c.x - m.x) * ey - (c.y - m.y) * ex) / den, u = ((c.x - m.x) * nr.y - (c.y - m.y) * nr.x) / den
    if (s > 1e-9 && u >= 0 && u <= 1) t = Math.min(t, s)
  })
  return t
}

/** R5-R9, R12: strips of depth D behind the sides, corner lots, merge, interior filler. Pieces are counter-clockwise; `holes` edges become outward-facing sides. */
export function stripLots(piece: Pt[], sides: Side[], p: StripParams, rng: Rng, holes: Pt[][] = []): StripLot[] {
  const D = p.depth
  const holeSides = holes.map((h) => sidesOf(ringArea(h) > 0 ? [...h].reverse() : h))
  const all = [...sides, ...holeSides.flat()]
  const chosen = new Set(p.sides ? p.sides(all) : all.map((_, i) => i))
  const chordLen = (s: Side) => dist(s.chord[0], s.chord[1])
  // ponytail: a piece thinner than D (probed from its longest edge only) gets one whole lot, no strips; in-between widths are left to the clipper
  if (!holes.length && depthAt(piece) < D) {
    const side = all.reduce((b, s, i) => (chordLen(s) > chordLen(all[b]) ? i : b), 0)
    const chord = all[side].chord
    return [{ poly: piece, chord, side, ...(holds(fitBox(piece, chord), 6, 8) ? {} : { filler: true }) }]
  }
  const pieceGeom: Geom = [ring(piece), ...holes.map(ring)]
  const out: StripLot[] = []
  const laid: { poly: Pt[]; box: Box }[] = []
  const lay = (l: StripLot) => { out.push(l); laid.push({ poly: l.poly, box: boxOf(l.poly) }) }

  /** the piece-clipped part of poly not covered by `hit`, largest outer ring, counter-clockwise; null when nothing is left */
  const trim = (poly: Pt[], hit: Pt[][]): Pt[] | null => {
    let g = intersection([ring(poly)], pieceGeom)
    if (hit.length && g.length) g = difference(g, ...hit.map((h) => [ring(h)] as Geom))
    let best: Pt[] | null = null, ba = 1
    for (const pg of g) { const r = unring(pg[0]), a = Math.abs(ringArea(r)); if (a >= ba) { best = ringArea(r) < 0 ? r.reverse() : r; ba = a } }
    return best
  }

  // corner lots (R7); the strips end at their projections
  const trimS = new Map<number, number>(), trimE = new Map<number, number>()
  const groups: number[][] = []
  let o = 0
  for (const g of [sides, ...holeSides]) { groups.push(g.map((_, i) => o + i)); o += g.length }
  for (const g of groups) {
    if (g.length < 2) continue
    g.forEach((a, k) => {
      const b = g[(k + 1) % g.length]
      if (!chosen.has(a) || !chosen.has(b)) return
      const A = all[a].pts, B = all[b].pts, v = A[A.length - 1]
      const da = unit(A[A.length - 2], v), db = unit(B[0], B[1])
      const cross = da.x * db.y - da.y * db.x
      if (cross <= 0) return
      const theta = Math.PI - Math.atan2(cross, da.x * db.x + da.y * db.y)
      if ((theta * 180) / Math.PI >= CORNER_MAX) return
      const t = D / Math.tan(theta / 2)
      const p1 = atArc(A.slice().reverse(), t), p2 = atArc(B, t), m = miter(left(da), left(db), D)
      const poly = trim([v, p2, { x: v.x + m.x, y: v.y + m.y }, p1], laid.map((l) => l.poly).filter((l) => overlaps(boxOf(l), boxOf([v, p2, p1]))))
      trimE.set(a, t); trimS.set(b, t)
      if (!poly) return
      lay({ poly, chord: dist(p1, v) >= dist(v, p2) ? [p1, v] : [v, p2], side: a, corner: (theta * 180) / Math.PI })
    })
  }

  // strips, longest side first (R5)
  const order = [...chosen].sort((i, j) => chordLen(all[j]) - chordLen(all[i]))
  for (const si of order) {
    const pts = all[si].pts, n = pts.length
    const cum = [0]
    for (let i = 1; i < n; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]))
    const en = pts.slice(1).map((q, i) => left(unit(pts[i], q)))
    const off = pts.map((_, j) => (j === 0 ? { x: en[0].x * D, y: en[0].y * D } : j === n - 1 ? { x: en[n - 2].x * D, y: en[n - 2].y * D } : miter(en[j - 1], en[j], D)))
    const a0 = trimS.get(si) ?? 0, a1 = cum[n - 1] - (trimE.get(si) ?? 0)
    if (a1 - a0 < EPS) continue

    // cut the arc into widths (and gaps); a rest below the minimum widens the previous lot
    const [wmin, wmax] = p.width
    const segs: { s: number; e: number; gap?: boolean }[] = []
    let c = a0
    const draw = (r: [number, number]) => r[0] + rng.next() * (r[1] - r[0])
    while (a1 - c >= wmax) {
      const w = draw(p.width)
      segs.push({ s: c, e: c + w }); c += w
      if (p.gap && a1 - c > 0) { const g = Math.min(draw(p.gap), a1 - c); segs.push({ s: c, e: c + g, gap: true }); c += g }
    }
    if (segs.length && segs[segs.length - 1].gap) c = segs.pop()!.s
    if (a1 - c >= wmin) segs.push({ s: c, e: a1 })
    else if (segs.length) segs[segs.length - 1].e = a1

    const prior = laid.slice()
    type Cut = { s: number; e: number; gap?: boolean; poly: Pt[]; chord: [Pt, Pt]; ok: boolean; merged?: boolean }
    const make = (s: number, e: number, gap?: boolean): Cut | null => {
      const front: Pt[] = [], o2: Pt[] = []
      const at = (x: number) => {
        const j = cum.findIndex((q) => Math.abs(q - x) < EPS)
        if (j >= 0) return { q: pts[j], v: off[j] }
        const i = cum.findIndex((q, k) => k + 1 < n && x > q && x < cum[k + 1])
        const d = unit(pts[i], pts[i + 1]), t = x - cum[i]
        return { q: { x: pts[i].x + d.x * t, y: pts[i].y + d.y * t }, v: { x: en[i].x * D, y: en[i].y * D } }
      }
      const put = (r: { q: Pt; v: Pt }) => { front.push(r.q); o2.push(r.v) }
      put(at(s))
      for (let j = 1; j < n - 1; j++) if (cum[j] > s + EPS && cum[j] < e - EPS) put({ q: pts[j], v: off[j] })
      put(at(e))
      const raw = [...front, ...front.map((q, i) => ({ x: q.x + o2[i].x, y: q.y + o2[i].y })).reverse()]
      let poly: Pt[] | null = raw
      const rb = boxOf(raw)
      const hit = prior.filter((l) => overlaps(l.box, rb)).map((l) => l.poly)
      if (front.length > 2 || hit.length) poly = trim(raw, hit) // plain quad unless it spans a vertex or touches a trim
      if (!poly) return null
      const chord: [Pt, Pt] = [front[0], front[front.length - 1]]
      return { s, e, gap, poly, chord, ok: gap ? false : holds(fitBox(poly, chord), 6, 8) }
    }

    const cuts = segs.map((g) => make(g.s, g.e, g.gap)).filter((x): x is Cut => !!x)
    // R12: a failing lot merges into the next lot on its side (the previous for the last), once
    const res: Cut[] = []
    for (let i = 0; i < cuts.length; i++) {
      const l = cuts[i]
      if (l.gap || l.ok) { res.push(l); continue }
      const j = cuts.findIndex((m, k) => k > i && !m.gap)
      if (j >= 0) {
        const m = make(l.s, cuts[j].e)
        if (m) res.push({ ...m, merged: true })
        i = j
        continue
      }
      let pi = res.length - 1
      while (pi >= 0 && res[pi].gap) pi--
      const m = pi >= 0 && !res[pi].merged ? make(res[pi].s, l.e) : null
      if (m) { res.length = pi; res.push({ ...m, merged: true }) } else res.push(l)
    }
    for (const l of res) lay({ poly: l.poly, chord: l.chord, side: si, ...(l.gap || !l.ok ? { filler: true } : {}) })
  }

  // R9: what the lots leave of the piece, one filler per leftover polygon
  const rest = difference(pieceGeom, ...laid.map((l) => [ring(l.poly)] as Geom))
  const push = (ringPts: [number, number][]) => {
    const r = unring(ringPts)
    if (Math.abs(ringArea(r)) >= 1) out.push({ poly: ringArea(r) < 0 ? r.reverse() : r, chord: longest(r), side: -1, filler: true })
  }
  // a ring-shaped leftover (holes) is cut by the extended sides of the hole box, in the frame of the longest piece edge, into simple pieces
  const [fa, fb] = longest(piece), fu = unit(fa, fb), fn = left(fu)
  const toF = ([x, y]: [number, number]) => ({ x: (x - fa.x) * fu.x + (y - fa.y) * fu.y, y: (x - fa.x) * fn.x + (y - fa.y) * fn.y })
  const fromF = (x: number, y: number): [number, number] => [fa.x + fu.x * x + fn.x * y, fa.y + fu.y * x + fn.y * y]
  const B = 1e5
  for (const pg of rest) {
    if (pg.length < 2) { push(pg[0]); continue }
    const hp = pg.slice(1).flat().map(toF), x0 = Math.min(...hp.map((q) => q.x)), x1 = Math.max(...hp.map((q) => q.x)), y0 = Math.min(...hp.map((q) => q.y)), y1 = Math.max(...hp.map((q) => q.y))
    const rect = (a: number, b: number, c: number, d: number): Geom => [[fromF(a, c), fromF(b, c), fromF(b, d), fromF(a, d)]]
    for (const r of [rect(-B, x0, -B, B), rect(x1, B, -B, B), rect(x0, x1, -B, y0), rect(x0, x1, y1, B)]) for (const part of intersection([pg], r)) push(part[0])
  }
  return out
}
