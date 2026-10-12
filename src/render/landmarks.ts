import type { Pt } from '../gen/geometry'
import { designShape, openingOf } from '../gen/landmarks/designs'
import { insetOrLargest } from '../gen/streets/lots'
import type { SectorModel } from '../gen/types'
import type { Theme } from './theme'

const n = (v: number) => String(Math.round(v * 100) / 100)
const pts = (p: Pt[]) => p.map((q) => `${n(q.x)},${n(q.y)}`).join(' ')

/** ids of the buildings that are megablock hive cells (drawn by renderLandmarks, not the generic building draw) */
export function hiveBuildingIds(model: SectorModel): Set<string> {
  const hive = new Set(model.blocks.filter((b) => b.flags.megablock).map((b) => b.id))
  return new Set(model.buildings.filter((b) => hive.has(b.blockId)).map((b) => b.id))
}

/** ids of the buildings in strip blocks (narrow lots along the highway frontage; drawn by renderLandmarks) */
export function stripBuildingIds(model: SectorModel): Set<string> {
  const strip = new Set(model.blocks.filter((b) => b.style === 'strip').map((b) => b.id))
  return new Set(model.buildings.filter((b) => strip.has(b.blockId)).map((b) => b.id))
}

/** landmark pass (megablock hives are drawn here): after buildings, before roads; landmarks are few so elements are individual in both modes */
export function renderLandmarks(model: SectorModel, theme: Theme, out: string[], interactive: boolean): void {
  for (const a of model.arcologies) {
    // ponytail: plaza uses arcology.fill at low opacity rather than a lightened districtFill.corp
    out.push(`<polygon points="${pts(a.plaza)}" fill="${theme.arcology.fill}" fill-opacity="0.35"/>`)
    const { fill, stroke, ring } = theme.arcology
    const s = designShape(a.design, a.center, a.radius, a.angle, a.detail, openingOf(a.angle, a.side, a.detail.twist))
    const poly = (p: Pt[], f: string, st: string, w: number) => out.push(`<polygon points="${pts(p)}" fill="${f}" stroke="${st}" stroke-width="${w}"/>`)
    const line = ([p, q]: [Pt, Pt]) => out.push(`<line x1="${n(p.x)}" y1="${n(p.y)}" x2="${n(q.x)}" y2="${n(q.y)}" stroke="${ring}" stroke-width="1"/>`)
    const rings = a.design === 'rings'
    // the hull outline is the footprint for hit-testing; only rings fills it, the other designs let their structures carry the fill
    out.push(`<polygon data-arcology="${a.id}" data-design="${a.design}" data-access="${a.access}" points="${pts(a.footprint)}" fill="${rings ? fill : 'none'}" stroke="${rings ? stroke : ring}" stroke-width="${rings ? 2 : 1}"/>`)
    if (rings) s.polys.forEach((p) => poly(p, 'none', ring, 1))
    else if (a.design === 'ziggurat') { poly(s.outline, fill, stroke, 2); s.polys.forEach((p) => poly(p, 'none', ring, 1)); s.lines.forEach(line) }
    else if (a.design === 'crescent') { poly(s.polys[0], fill, stroke, 2); poly(s.polys[1], 'none', ring, 1) }
    else { s.lines.forEach(line); s.polys.forEach((p) => poly(p, fill, stroke, 2)) }
  }
  // one path for every strip lot, in both modes
  const strip = stripBuildingIds(model)
  if (strip.size) {
    const d = model.buildings.filter((b) => strip.has(b.id)).map((b) => `M${b.footprint.map((p) => `${n(p.x)},${n(p.y)}`).join('L')}Z`).join(' ')
    out.push(`<path data-frontage="1" data-count="${strip.size}" d="${d}" fill="${theme.frontage.fill}" stroke="${theme.frontage.stroke}" stroke-width="0.5"/>`)
  }
  for (const m of model.megablocks) {
    const blockIds = new Set(model.blocks.filter((b) => b.flags.megablock === m.id).map((b) => b.id))
    for (const b of model.buildings)
      if (blockIds.has(b.blockId))
        out.push(`<polygon${interactive ? '' : ` data-id="${b.id}"`} points="${pts(b.footprint)}" fill="${theme.megablock.fill}" stroke="${theme.megablock.alley}" stroke-width="0.5"/>`)
    const d = model.blocks.filter((b) => b.flags.megablock === m.id).flatMap((b) => b.alleys.map(([p, q]) => `M${n(p.x)},${n(p.y)}L${n(q.x)},${n(q.y)}`)).join(' ')
    if (d) out.push(`<path d="${d}" fill="none" stroke="${theme.megablock.alley}" stroke-width="1.5"/>`)
    if (m.footprint.length)
      out.push(`<polygon data-megablock="${m.id}" points="${pts(m.footprint)}" fill="none" stroke="${theme.megablock.alley}" stroke-width="2"/>`)
  }
}

/** closed ring -> open polyline: the longer arc between the points nearest a and b (the shorter one is the gate gap) */
function openRing(ring: Pt[], a: Pt, b: Pt): Pt[] {
  const m = ring.length
  const seg: number[] = []
  let total = 0
  for (let i = 0; i < m; i++) { seg.push(total); total += Math.hypot(ring[(i + 1) % m].x - ring[i].x, ring[(i + 1) % m].y - ring[i].y) }
  const at = (p: Pt) => { // perimeter position of the nearest point on the ring, and that point
    let best = { d: Infinity, s: 0, q: ring[0] }
    for (let i = 0; i < m; i++) {
      const u = ring[i], v = ring[(i + 1) % m]
      const dx = v.x - u.x, dy = v.y - u.y, l2 = dx * dx + dy * dy || 1
      const t = Math.max(0, Math.min(1, ((p.x - u.x) * dx + (p.y - u.y) * dy) / l2))
      const q = { x: u.x + t * dx, y: u.y + t * dy }
      const d = Math.hypot(p.x - q.x, p.y - q.y)
      if (d < best.d) best = { d, s: seg[i] + t * Math.sqrt(l2), q }
    }
    return best
  }
  let [s0, s1] = [at(a), at(b)]
  if (s0.s > s1.s) [s0, s1] = [s1, s0]
  // arc A = s0 -> s1 (gap if short); keep the other: s1 -> end -> start -> s0
  const gapIsInner = s1.s - s0.s < total / 2
  const [from, to] = gapIsInner ? [s1, s0] : [s0, s1]
  const wrap = from.s > to.s
  const inside = (s: number) => (wrap ? s > from.s || s < to.s : s > from.s && s < to.s)
  const mid = ring.map((p, i) => ({ p, s: seg[i] })).filter((v) => inside(v.s))
  if (wrap) mid.sort((x, y) => (x.s >= from.s ? x.s - total : x.s) - (y.s >= from.s ? y.s - total : y.s))
  return [from.q, ...mid.map((v) => v.p), to.q]
}

/** compound ground and double fence (spec 3.3); ground goes under the buildings, so svg.ts calls this before the building pass */
export function renderCompounds(model: SectorModel, theme: Theme, out: string[]): void {
  for (const c of model.compounds) {
    out.push(`<polygon data-compound="${c.id}" points="${pts(c.fence)}" fill="${theme.compound.ground}"/>`)
    // ponytail: inner line is the fence inset 1.5 m (5.5 m from the block); skipped when the inset collapses
    const inner = insetOrLargest(c.fence, 1.5)
    for (const ring of inner ? [c.fence, inner] : [c.fence]) {
      out.push(`<polyline data-fence="${c.id}" points="${pts(openRing(ring, c.gate[0], c.gate[1]))}" fill="none" stroke="${theme.compound.fence}" stroke-width="1.2"/>`)
    }
  }
}
