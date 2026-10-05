import type { Pt } from '../gen/geometry'
import { designShape, openingOf } from '../gen/landmarks/designs'
import type { SectorModel } from '../gen/types'
import type { Theme } from './theme'

const n = (v: number) => String(Math.round(v * 100) / 100)
const pts = (p: Pt[]) => p.map((q) => `${n(q.x)},${n(q.y)}`).join(' ')

/** ids of the buildings that are megablock hive cells (drawn by renderLandmarks, not the generic building draw) */
export function hiveBuildingIds(model: SectorModel): Set<string> {
  const hive = new Set(model.blocks.filter((b) => b.flags.megablock).map((b) => b.id))
  return new Set(model.buildings.filter((b) => hive.has(b.blockId)).map((b) => b.id))
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
    out.push(`<polygon data-arcology="${a.id}" data-design="${a.design}" points="${pts(a.footprint)}" fill="${rings ? fill : 'none'}" stroke="${rings ? stroke : ring}" stroke-width="${rings ? 2 : 1}"/>`)
    if (rings) s.polys.forEach((p) => poly(p, 'none', ring, 1))
    else if (a.design === 'ziggurat') { poly(s.outline, fill, stroke, 2); s.polys.forEach((p) => poly(p, 'none', ring, 1)); s.lines.forEach(line) }
    else if (a.design === 'crescent') { poly(s.polys[0], fill, stroke, 2); poly(s.polys[1], 'none', ring, 1) }
    else { s.lines.forEach(line); s.polys.forEach((p) => poly(p, fill, stroke, 2)) }
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
