import type { Pt } from '../geometry'
import { ringArea } from '../geometry'
import { union, type Ring } from '../clip'
import type { Rng } from '../rng'
import type { BlockStyle } from '../types'
import type { FitBox } from './fitbox'
import { SHAPES, cleanRing, fitShape, type DensityClass, type SheetZone } from './shapes'

type Id = 'E1' | 'E2' | 'E3' | 'E4' | 'E5' | 'E6'
interface CompositeDef { bodies: string[]; zones: SheetZone[]; density: DensityClass[]; rarity: number; inside: boolean }

/** R27 table; rarity uncommon 0.35, rare 0.08, common 1; `inside` = parts only inside the body (allowed on continuous fabrics) */
export const COMPOSITES: Record<Id, CompositeDef> = {
  E1: { bodies: ['A1', 'A2'], zones: ['residential', 'fringe'], density: ['sparse'], rarity: 0.35, inside: false },
  E2: { bodies: ['A4'], zones: ['residential', 'fringe'], density: ['sparse'], rarity: 0.35, inside: false },
  E3: { bodies: ['A3'], zones: ['corp', 'commerce'], density: ['dense', 'packed'], rarity: 0.35, inside: true },
  E4: { bodies: ['A1', 'A2', 'A20'], zones: ['corp', 'commerce'], density: ['dense', 'packed'], rarity: 0.35, inside: false },
  E5: { bodies: ['A2'], zones: ['corp'], density: ['packed'], rarity: 0.08, inside: true },
  E6: { bodies: ['A1', 'A3', 'A18'], zones: ['industrial'], density: ['sparse', 'dense'], rarity: 1, inside: false },
}

/** R27 chance order, first match */
export function compositeChance(fabric: BlockStyle, zone: SheetZone): number {
  if (fabric === 'villas') return 0.5
  if (fabric === 'detached') return 0.3
  if (zone === 'corp' || zone === 'commerce') return 0.25
  if (zone === 'industrial') return 0.3
  return 0.1
}

const P = (x: number, y: number): Pt => ({ x, y })
const rect = (x0: number, y0: number, x1: number, y1: number): Pt[] => [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)]
/** even integer in [lo, hi] (2 m grid), null when empty */
const even = (rng: Rng, lo: number, hi: number): number | null => {
  const a = Math.ceil(lo / 2 - 1e-9) * 2, b = Math.floor(hi / 2 + 1e-9) * 2
  return a > b ? null : a + 2 * rng.int(0, (b - a) / 2)
}
interface Body { id: string; w: number; d: number }
/** body id from the entry's list (first drawn that sizes), w and d even and inside the id's aspect; `wide` = d <= w */
function pickBody(rng: Rng, ids: string[], wlo: number, whi: number, dlo: number, dhi: number, wide = false): Body | null {
  const order = [...ids]
  while (order.length) {
    const id = order.splice(rng.int(0, order.length - 1), 1)[0], s = SHAPES[id], [alo, ahi] = s.aspect as [number, number]
    for (let t = 0; t < 4; t++) {
      const w = even(rng, Math.max(wlo, s.minW), whi)
      if (w === null) break
      const d = even(rng, Math.max(dlo, s.minD, alo * w), Math.min(dhi, ahi * w, wide ? w : Infinity))
      if (d !== null) return { id, w, d }
    }
  }
  return null
}

interface Plan { body: Body; bx: number; by: number; outer: Pt[][]; inner: Pt[][] }
type Planner = (rng: Rng, gw: number, gd: number, continuous: boolean) => Plan | null

const PLAN: Record<Id, Planner> = {
  E1(rng, gw, gd) { // corner tower, about half outside, at a front corner
    const s = even(rng, 6, 14) as number, o = 2 * Math.floor(s / 4), right = rng.chance(0.5)
    const body = pickBody(rng, COMPOSITES.E1.bodies, 10, Math.min(16, gw - o), 10, Math.min(16, gd - o))
    if (!body) return null
    const bx = right ? 0 : o, x0 = right ? bx + body.w - s + o : bx - o
    return { body, bx, by: o, outer: [rect(x0, 0, x0 + s, s)], inner: [] }
  },
  E2(rng, gw, gd) { // garage annex in front of a front corner, overlapping the front arm by 2 m so the union is one piece
    const aw = even(rng, 6, 8) as number, ah = even(rng, 6, 10) as number, oy = ah - 2
    const by = 2 * Math.ceil(oy / 2)
    const body = pickBody(rng, COMPOSITES.E2.bodies, 20, gw, 20, gd - by)
    if (!body) return null
    const x0 = rng.chance(0.5) ? 0 : body.w - aw
    return { body, bx: 0, by, outer: [rect(x0, by - oy, x0 + aw, by + 2)], inner: [] }
  },
  E3(rng, gw, gd, continuous) { // two roof towers, one per half of the body
    const body = pickBody(rng, COMPOSITES.E3.bodies, continuous ? gw : 30, gw, 10, gd)
    if (!body) return null
    const smax = Math.floor(Math.min(14, body.d - 4, body.w / 2 - 4) / 2) * 2
    const s1 = even(rng, 6, smax), s2 = even(rng, 6, smax)
    if (s1 === null || s2 === null) return null
    const h = Math.ceil((body.w / 2 + 1) / 2) * 2
    const x1 = even(rng, 2, body.w / 2 - 1 - s1), x2 = even(rng, h, body.w - 2 - s2)
    const y1 = even(rng, 2, body.d - 2 - s1), y2 = even(rng, 2, body.d - 2 - s2)
    if (x1 === null || x2 === null || y1 === null || y2 === null) return null
    return { body, bx: 0, by: 0, outer: [], inner: [rect(x1, y1, x1 + s1, y1 + s1), rect(x2, y2, x2 + s2, y2 + s2)] }
  },
  E4(rng, gw, gd) { // semicircular bay on the front edge; radius <= 8 so the front margin is at most 8 m
    const body = pickBody(rng, COMPOSITES.E4.bodies, 12, gw, 10, gd - 8)
    if (!body) return null
    const D = even(rng, Math.max(6, 0.3 * body.w), Math.min(16, 0.5 * body.w))
    if (D === null) return null
    const R = D / 2, by = 2 * Math.ceil(R / 2), cx = 2 * Math.round(body.w / 4)
    const arc = Array.from({ length: 13 }, (_, i) => { const a = Math.PI * (1 - i / 12); return P(cx + R * Math.cos(a), by - R * Math.sin(a)) })
    return { body, bx: 0, by, outer: [[...arc, P(cx + R, by + 2), P(cx - R, by + 2)]], inner: [] }
  },
  E5(rng, gw, gd) { // stepped squares 0.8 and 0.6 of the side, in one corner with a 2 m margin
    const body = pickBody(rng, COMPOSITES.E5.bodies, 10, gw, 10, gd)
    if (!body) return null
    const side = Math.min(body.w, body.d), s1 = Math.min(2 * Math.round(0.4 * side), Math.floor((side - 2) / 2) * 2), s2 = Math.max(6, Math.min(2 * Math.round(0.3 * side), s1 - 2))
    if (s2 > s1 - 2) return null
    const c = rng.int(0, 3), sq = (s: number) => { const x = c & 1 ? body.w - 2 - s : 2, y = c & 2 ? body.d - 2 - s : 2; return rect(x, y, x + s, y + s) }
    return { body, bx: 0, by: 0, outer: [], inner: [sq(s1), sq(s2)] }
  },
  E6(rng, gw, gd) { // head building flush on a short end of a hall lying along the box width
    const hw = even(rng, 16, 20) as number, hd = even(rng, 12, 16) as number
    const body = pickBody(rng, COMPOSITES.E6.bodies, 20, gw - hw, 10, gd, true)
    if (!body) return null
    if (Math.abs(hd - body.d) === 2 || Math.max(hd, body.d) > gd) return null
    const left = rng.chance(0.5), back = rng.chance(0.5), by = back ? Math.max(0, hd - body.d) : 0, bx = left ? hw : 0
    const x0 = left ? 0 : body.w - 2, y0 = back ? by + body.d - hd : by
    return { body, bx, by, outer: [rect(x0, y0, x0 + hw + 2, y0 + hd)], inner: [] }
  },
}

/**
 * R27–R28. Draw order: entry (weighted by rarity, redrawn without it when its planner fails) -> planner draws
 * (part sizes, side/corner, body id and size; see each planner) -> fitShape's mirror draw. Everything is planned and
 * unioned in the box's local frame (origin 0,0, angle 0, x along the front) and only the result is rotated into the world.
 */
export function makeComposite(fit: FitBox, zone: SheetZone, density: DensityClass, continuous: boolean, rng: Rng): { shape: string; footprint: Pt[]; details: Pt[][] } | null {
  const gw = Math.floor(fit.w / 2) * 2, gd = Math.floor(fit.d / 2) * 2
  const open = (Object.keys(COMPOSITES) as Id[]).filter((id) => { const c = COMPOSITES[id]; return c.zones.includes(zone) && c.density.includes(density) && (!continuous || c.inside) })
  while (open.length) {
    const id = rng.weighted(open.map((k) => [k, COMPOSITES[k].rarity] as const))
    open.splice(open.indexOf(id), 1)
    const plan = PLAN[id](rng, gw, gd, continuous)
    if (!plan) continue
    const { body, bx, by } = plan
    const b = fitShape(body.id, { origin: P(bx, by), angle: 0, w: body.w, d: body.d }, rng)
    let ring = b.footprint
    if (plan.outer.length) {
      const poly = (r: Pt[]): Ring[] => [r.map((p) => [p.x, p.y] as [number, number])]
      const u = union(poly(ring), ...plan.outer.map(poly))
      if (u.length !== 1 || u[0].length !== 1) continue // not one piece without holes
      ring = u[0][0].slice(0, -1).map(([x, y]) => P(x, y))
      if (ringArea(ring) < 0) ring.reverse()
    }
    const c = Math.cos(fit.angle), s = Math.sin(fit.angle)
    const world = (p: Pt): Pt => P(fit.origin.x + c * p.x - s * p.y, fit.origin.y + s * p.x + c * p.y)
    return { shape: id, footprint: cleanRing(ring.map(world)), details: [...b.details, ...plan.inner].map((r) => r.map(world)) }
  }
  return null
}
