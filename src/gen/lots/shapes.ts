import type { Pt } from '../geometry'
import { pointInRings, ringArea } from '../geometry'
import { distToPolyline } from '../terrain/rivers'
import type { Rng } from '../rng'
import type { BlockStyle } from '../types'
import type { FitBox } from './fitbox'

export type SheetZone = 'residential' | 'mixed' | 'commerce' | 'corp' | 'industrial' | 'fringe'
export type DensityClass = 'sparse' | 'dense' | 'packed'
export interface ShapeDef { aspect: [number, number] | null; minW: number; minD: number; minArea?: number; zones: SheetZone[] | 'any'; density: DensityClass[] | 'any'; rarity: 1 | 0.35 | 0.08 }

const C = 1, U = 0.35, R = 0.08
const def = (aspect: [number, number] | null, minW: number, minD: number, zones: SheetZone[] | 'any', density: DensityClass[] | 'any', rarity: 1 | 0.35 | 0.08, minArea?: number): ShapeDef =>
  ({ aspect, minW, minD, zones, density, rarity, ...(minArea ? { minArea } : {}) })
const RES: SheetZone = 'residential', MIX: SheetZone = 'mixed', COM: SheetZone = 'commerce', CORP: SheetZone = 'corp', IND: SheetZone = 'industrial'

/** §3.6 table */
export const SHAPES: Record<string, ShapeDef> = {
  A1: def([0.5, 2], 6, 10, 'any', 'any', C),
  A2: def([0.85, 1.15], 10, 10, 'any', 'any', C),
  A3: def([0.15, 0.4], 30, 10, [RES, MIX, COM, CORP, IND], ['dense', 'packed'], U),
  A4: def([0.7, 1.4], 20, 20, [RES, MIX, COM], ['dense'], C),
  A5: def([0.6, 1.2], 26, 22, [RES, MIX, CORP], ['dense'], C),
  A6: def([0.6, 1.2], 24, 20, [COM, CORP], ['dense'], U),
  A7: def([0.6, 1.2], 30, 24, [RES, COM], ['dense'], U),
  A8: def([0.4, 0.8], 40, 20, [RES, MIX], ['dense'], U),
  A9: def([0.6, 1.2], 36, 36, [MIX, COM], ['dense', 'packed'], C),
  A10: def([0.7, 1.2], 30, 28, [RES, MIX], ['dense'], U),
  A11: def([0.85, 1.15], 18, 18, [CORP, COM], ['dense', 'packed'], C),
  A12: def([1, 1], 16, 16, [CORP, COM], ['packed'], R),
  A13: def([0.55, 0.75], 24, 16, [CORP], ['packed'], R),
  A14: def([0.85, 1.15], 30, 30, [CORP, COM], ['dense', 'packed'], R),
  A15: def(null, 0, 0, [MIX, COM], ['dense', 'packed'], U, 150),
  A16: def(null, 0, 0, [COM, CORP, MIX], ['packed'], R, 1500),
  A17: def([0.5, 1], 24, 18, [COM, MIX], ['dense', 'packed'], R),
  A18: def([0.4, 2.5], 24, 24, [IND], ['sparse', 'dense'], C),
  A19: def([0.5, 2], 40, 40, [COM, CORP], ['packed'], U),
  A20: def([0.6, 1.6], 18, 18, [RES, MIX, COM], ['dense'], C),
  A21: def([0.45, 0.75], 30, 18, [CORP, COM], ['dense', 'packed'], R),
  A22: def([0.25, 0.45], 50, 18, [CORP], ['packed'], R),
  A23: def([0.6, 0.9], 30, 24, [COM, CORP], ['dense', 'packed'], R),
}

/** R25 */
export const CURVED_OR_SLANTED: ReadonlySet<string> = new Set(['A11', 'A12', 'A13', 'A15', 'A16', 'A17', 'A19', 'A21', 'A22', 'A23']) // A19: its podium may be a D, stadium or rounded template

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))
/** clamp(x, lo, hi) snapped to 2 m (lo and hi are even) */
const par = (x: number, lo: number, hi: number) => clamp(Math.round(clamp(x, lo, hi) / 2) * 2, lo, hi)
const P = (x: number, y: number): Pt => ({ x, y })
const rect = (w: number, d: number): Pt[] => [P(0, 0), P(w, 0), P(w, d), P(0, d)]

/** n + 1 points of the arc around (cx, cy) from deg0 to deg1 */
const arcPts = (cx: number, cy: number, rx: number, ry: number, deg0: number, deg1: number, n: number): Pt[] =>
  Array.from({ length: n + 1 }, (_, i) => { const a = ((deg0 + ((deg1 - deg0) * i) / n) * Math.PI) / 180; return P(cx + rx * Math.cos(a), cy + ry * Math.sin(a)) })

const rounded = (w: number, d: number, r: number): Pt[] => [
  ...arcPts(w - r, r, r, r, -90, 0, 6), ...arcPts(w - r, d - r, r, r, 0, 90, 6),
  ...arcPts(r, d - r, r, r, 90, 180, 6), ...arcPts(r, r, r, r, 180, 270, 6),
]

/** U open to the rear: legs l wide, base b deep */
const uShape = (w: number, d: number, l: number, b: number): Pt[] =>
  [P(0, 0), P(w, 0), P(w, d), P(w - l, d), P(w - l, b), P(l, b), P(l, d), P(0, d)]

/** wall thickness of A9 / A10, hole at least 10 m */
const wallOf = (w: number, d: number): number => Math.min(par(0.25 * Math.min(w, d), 8, 14), (Math.min(w, d) - 10) / 2)

type Built = { footprint: Pt[]; details: Pt[][] }
const plain = (footprint: Pt[]): Built => ({ footprint, details: [] })

function build(id: string, w: number, d: number, rng: Rng): Built {
  switch (id) {
    case 'A1': case 'A2': case 'A3': return plain(rect(w, d))
    case 'A4': { const a = par(0.35 * Math.min(w, d), 8, 16); return plain([P(0, 0), P(w, 0), P(w, a), P(a, a), P(a, d), P(0, d)]) }
    case 'A5': return plain(uShape(w, d, par(0.3 * w, 8, 14), par(0.35 * d, 8, 14)))
    case 'A6': {
      const b = par(0.3 * d, 10, 16), s = par(0.3 * w, 8, 16), x0 = (w - s) / 2
      return plain([P(0, 0), P(w, 0), P(w, b), P(x0 + s, b), P(x0 + s, d), P(x0, d), P(x0, b), P(0, b)])
    }
    case 'A7': {
      const l = par(0.25 * w, 8, 14), br = par(0.3 * d, 8, 14), y0 = (d - br) / 2, y1 = y0 + br
      return plain([P(0, 0), P(l, 0), P(l, y0), P(w - l, y0), P(w - l, 0), P(w, 0), P(w, d), P(w - l, d), P(w - l, y1), P(l, y1), P(l, d), P(0, d)])
    }
    case 'A8': {
      const s = par(0.25 * d, 8, 14), k = par(0.18 * w, 8, 12), c0 = (w - k) / 2
      return plain([P(0, 0), P(w, 0), P(w, d), P(w - k, d), P(w - k, s), P(c0 + k, s), P(c0 + k, d), P(c0, d), P(c0, s), P(k, s), P(k, d), P(0, d)])
    }
    case 'A9': { const t = wallOf(w, d); return { footprint: rect(w, d), details: [[P(t, t), P(w - t, t), P(w - t, d - t), P(t, d - t)]] } }
    case 'A10': { const t = wallOf(w, d); return plain(uShape(w, d, t, t)) }
    case 'A11': {
      const c = par(0.2 * Math.min(w, d), 4, 6)
      return plain([P(c, 0), P(w - c, 0), P(w, c), P(w, d - c), P(w - c, d), P(c, d), P(0, d - c), P(0, c)])
    }
    case 'A12': { const r = Math.min(w, d) / 2; return plain(arcPts(w / 2, d / 2, r, r, 0, 360, 24).slice(0, 24)) }
    case 'A13': { // points at equal normal-angle steps, so the turning stays near 15 degrees at the tight ends
      const a = w / 2, b = d / 2
      return plain(Array.from({ length: 24 }, (_, i) => {
        const c = Math.cos((i * Math.PI) / 12), n = Math.sin((i * Math.PI) / 12), q = Math.hypot(a * c, b * n)
        return P(a + (a * a * c) / q, b + (b * b * n) / q)
      }))
    }
    case 'A14': {
      const a = par(0.33 * Math.min(w, d), 10, 16), x0 = (w - a) / 2, x1 = x0 + a, y0 = (d - a) / 2, y1 = y0 + a
      return plain([P(x0, 0), P(x1, 0), P(x1, y0), P(w, y0), P(w, y1), P(x1, y1), P(x1, d), P(x0, d), P(x0, y1), P(0, y1), P(0, y0), P(x0, y0)])
    }
    case 'A17': return plain(rounded(w, d, Math.min(6, 0.2 * Math.min(w, d))))
    case 'A23': return plain(rounded(w, d, clamp(0.25 * Math.min(w, d), 6, 10)))
    case 'A18': {
      const teeth: Pt[][] = []
      if (w < d) for (let y = 8; y < d - 1e-9; y += 8) teeth.push([P(0, y), P(w, y)])
      else for (let x = 8; x < w - 1e-9; x += 8) teeth.push([P(x, 0), P(x, d)])
      return { footprint: rect(w, d), details: teeth }
    }
    case 'A19': { // user review: a template podium (podiumBase), 1-3 towers 20-30 m drawn anywhere inside it on the 2 m grid, 4 m in, 6 m apart
      const base = podiumBase(w, d, rng), closed = [...base.footprint, base.footprint[0]]
      const n = rng.int(1, 3), towers: Pt[][] = [], boxes: number[][] = []
      for (let i = 0; i < n; i++) for (let t = 0; t < 40; t++) {
        const kind = (['A11', 'A12', 'A13'] as const)[rng.int(0, 2)], tw = rng.int(20, 30), td = kind === 'A13' ? Math.round(0.65 * tw) : tw
        if (tw > w - 8 || td > d - 8) continue
        const x = 4 + 2 * rng.int(0, Math.floor((w - 8 - tw) / 2)), y = 4 + 2 * rng.int(0, Math.floor((d - 8 - td) / 2))
        if (boxes.some(([bx, by, bw, bd]) => Math.max(bx - x - tw, x - bx - bw, by - y - td, y - by - bd) < 6)) continue
        const ring = build(kind, tw, td, rng).footprint.map((p) => P(p.x + x, p.y + y))
        if (!ring.every((p) => pointInRings(p, [base.footprint]) && distToPolyline(p, closed) >= 4)) continue
        towers.push(ring); boxes.push([x, y, tw, td])
        break
      }
      return { footprint: base.footprint, details: towers }
    }
    case 'A20': { const n = par(0.25 * Math.min(w, d), 6, 10); return plain([P(0, 0), P(w, 0), P(w, d - n), P(w - n, d - n), P(w - n, d), P(0, d)]) }
    case 'A21': { const r = d / 2; return plain([P(0, 0), ...arcPts(w - r, r, r, r, -90, 90, 12), P(0, d)]) }
    case 'A22': { const r = d / 2; return plain([...arcPts(w - r, r, r, r, -90, 90, 12), ...arcPts(r, r, r, r, 90, 270, 12)]) }
  }
  throw new Error(`no template for ${id} (A15 and A16 come from cornerShape)`)
}

/** podium footprints (user review, D9): big-shape templates by weight */
export const PODIUM_BASES: ReadonlyArray<readonly [string, number]> = [['A3', 25], ['A4', 15], ['A5', 10], ['A21', 15], ['A22', 15], ['A23', 10], ['A1', 10]]
/** the podium's footprint in its w x d box: a drawn template, turned 90 degrees half the time (the D, stadium and slab always run along the longer side) */
export function podiumBase(w: number, d: number, rng: Rng): { id: string; footprint: Pt[] } {
  const id = rng.weighted(PODIUM_BASES)
  const long = ['A3', 'A21', 'A22'].includes(id), turn = long ? d > w : rng.chance(0.5)
  const f = build(id, turn ? d : w, turn ? w : d, rng).footprint
  return { id, footprint: turn ? f.map((p) => P(p.y, p.x)).reverse() : f }
}

/** drops repeated and collinear vertices */
export function cleanRing(ring: Pt[]): Pt[] {
  let r = ring.filter((p, i) => { const q = ring[(i + ring.length - 1) % ring.length]; return Math.hypot(p.x - q.x, p.y - q.y) > 1e-9 })
  for (let again = true; again;) {
    again = false
    r = r.filter((p, i) => {
      const a = r[(i + r.length - 1) % r.length], b = r[(i + 1) % r.length]
      const cross = (p.x - a.x) * (b.y - p.y) - (p.y - a.y) * (b.x - p.x)
      const dot = (p.x - a.x) * (b.x - p.x) + (p.y - a.y) * (b.y - p.y)
      const drop = Math.abs(cross) < 1e-9 && dot > 0
      if (drop) again = true
      return !drop
    })
    if (again) continue
  }
  return r
}

export function fitShape(id: string, box: FitBox, rng: Rng): { footprint: Pt[]; details: Pt[][] } {
  const mirror = rng.chance(0.5)
  const b = build(id, box.w, box.d, rng)
  const u = { x: Math.cos(box.angle), y: Math.sin(box.angle) }
  const to = (p: Pt): Pt => {
    const x = mirror ? box.w - p.x : p.x
    return P(box.origin.x + u.x * x - u.y * p.y, box.origin.y + u.y * x + u.x * p.y)
  }
  const ring = (r: Pt[]) => (mirror ? [...r].reverse() : r).map(to)
  return { footprint: cleanRing(ring(b.footprint)), details: b.details.map((r) => (mirror && r.length > 2 ? ring(r) : r.map(to))) }
}

/** R23 */
export function chooseShape(allowed: string[], zone: SheetZone, density: DensityClass, fit: FitBox, rng: Rng): string | null {
  const cand = allowed.filter((id) => { const s = SHAPES[id]; return s && s.aspect && fit.w >= s.minW && fit.d >= s.minD })
  const wt = cand.map((id) => {
    const s = SHAPES[id]
    return s.rarity * (s.zones === 'any' || s.zones.includes(zone) ? 1 : 0.15) * (s.density === 'any' || s.density.includes(density) ? 1 : 0.3)
  })
  const total = wt.reduce((a, b) => a + b, 0)
  if (!total) return null
  let roll = rng.next() * total
  for (let i = 0; i < cand.length; i++) { roll -= wt[i]; if (roll < 0) return cand[i] }
  return cand[cand.length - 1]
}

/** R24 */
export function sizeShape(id: string, fit: FitBox, mode: 'continuous' | 'detached' | 'villas' | 'gapped', rng: Rng): FitBox | null {
  const s = SHAPES[id]
  if (!s || !s.aspect) return null
  const at = (x: number, y: number, w: number, d: number): FitBox => {
    const ux = Math.cos(fit.angle), uy = Math.sin(fit.angle)
    return { origin: P(fit.origin.x + ux * x - uy * y, fit.origin.y + uy * x + ux * y), angle: fit.angle, w, d }
  }
  if (mode === 'continuous') {
    const d = clamp(Math.round(fit.d * (0.9 + 0.1 * rng.next())), Math.min(s.minD, fit.d), fit.d)
    return fit.w >= s.minW && d >= s.minD ? at(0, 0, fit.w, d) : null
  }
  const [lo, hi] = s.aspect
  for (let t = 0; t < 3; t++) {
    const w = Math.round(mode === 'detached' ? rng.int(10, 16) : mode === 'villas' ? rng.int(14, 22)
      : clamp(Math.max(s.minW, 0.5 * fit.w) + rng.next() * (Math.max(s.minW, 0.85 * fit.w) - Math.max(s.minW, 0.5 * fit.w)), 0, fit.w))
    const wc = Math.max(w, s.minW)
    if (wc > fit.w) continue
    const d = Math.min(Math.round(wc * (lo + rng.next() * (hi - lo))), Math.floor(fit.d)) // whole metres, never past the fit box
    if (d < s.minD) continue
    if (d / wc < lo - 1e-6 || d / wc > hi + 1e-6) continue
    if (mode === 'gapped') return at(0, 0, wc, d)
    return at(Math.floor(rng.next() * (fit.w - wc)), rng.int(0, Math.floor(Math.min(6, fit.d - d))), wc, d)
  }
  return null
}

/** R26; `quad` = (corner, projection, inner point, projection). `fit: true` = fit normally, no id and no fit = plaza filler */
export function cornerShape(quad: Pt[], thetaDeg: number, fabric: BlockStyle, continuous: boolean, area: number): { id: 'A4' | 'A15' | 'A16' | null; footprint?: Pt[]; fit?: true } {
  if (thetaDeg >= 155) return { id: null, fit: true } // not a corner lot (R7)
  if (area < 150) return { id: null }
  if (thetaDeg >= 80 && thetaDeg <= 100) return fabric === 'perimeter' ? { id: 'A4' } : { id: null, fit: true }
  if (thetaDeg < 50) {
    if (area < 1500) return { id: null }
    const v = quad[0], a = quad[1], b = quad[3], la = Math.hypot(a.x - v.x, a.y - v.y), lb = Math.hypot(b.x - v.x, b.y - v.y)
    const k = 4 / Math.cos((thetaDeg * Math.PI) / 360) // blunt: leg length where the bisector projection is 4 m
    const at = (p: Pt, l: number, t: number) => P(v.x + ((p.x - v.x) / l) * t, v.y + ((p.y - v.y) / l) * t)
    const L = Math.min(70, la, lb)
    const f = [at(a, la, k), at(a, la, L), at(b, lb, L), at(b, lb, k)]
    return { id: 'A16', footprint: ringArea(f) < 0 ? f.reverse() : f }
  }
  if (!continuous) return { id: null, fit: true }
  return { id: 'A15', footprint: ringArea(quad) < 0 ? [...quad].reverse() : quad }
}
