import type { Pt } from '../gen/geometry'
import { pointInRings } from '../gen/geometry'
import type { SectorModel } from '../gen/types'
import type { Theme } from './theme'

const n = (v: number) => String(Math.round(v * 100) / 100)
const pts = (p: Pt[]) => p.map((q) => `${n(q.x)},${n(q.y)}`).join(' ')
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** building id -> megablock id for each core building (the building of a megablock block whose first vertex lies inside the core; surrounding lots are kept out of the core) */
export function megablockCores(model: SectorModel): Map<string, string> {
  const res = new Map<string, string>()
  if (!model.megablocks.length) return res
  const blocks = new Map(model.blocks.map((b) => [b.id, b]))
  for (const b of model.buildings) {
    const id = blocks.get(b.blockId)?.flags.megablock
    const m = id && model.megablocks.find((k) => k.id === id)
    if (m && pointInRings(b.footprint[0], [m.core])) res.set(b.id, m.id)
  }
  return res
}

/** landmark pass (megablock cores are re-drawn over the regular building draw): after buildings, before roads; landmarks are few so elements are individual in both modes */
export function renderLandmarks(model: SectorModel, theme: Theme, out: string[], cores: Map<string, string>): void {
  for (const a of model.arcologies) {
    // ponytail: plaza uses arcology.fill at low opacity rather than a lightened districtFill.corp
    out.push(`<polygon points="${pts(a.plaza)}" fill="${theme.arcology.fill}" fill-opacity="0.35"/>`)
    out.push(`<polygon data-arcology="${a.id}" points="${pts(a.footprint)}" fill="${theme.arcology.fill}" stroke="${theme.arcology.stroke}" stroke-width="2"/>`)
    for (const k of [0.66, 0.33])
      out.push(`<polygon points="${pts(a.footprint.map((p) => ({ x: a.center.x + (p.x - a.center.x) * k, y: a.center.y + (p.y - a.center.y) * k })))}" fill="none" stroke="${theme.arcology.ring}" stroke-width="1"/>`)
  }
  for (const m of model.megablocks) {
    // ponytail: all of the block's alleys (core + surrounding lots' rows alleys) share the megablock colour
    const d = model.blocks.filter((b) => b.flags.megablock === m.id).flatMap((b) => b.alleys.map(([p, q]) => `M${n(p.x)},${n(p.y)}L${n(q.x)},${n(q.y)}`)).join(' ')
    if (d) out.push(`<path d="${d}" fill="none" stroke="${theme.megablock.alley}" stroke-width="2" stroke-opacity="0.6"/>`)
    for (const b of model.buildings)
      if (cores.get(b.id) === m.id)
        out.push(`<polygon data-megablock="${m.id}" points="${pts(b.footprint)}" fill="${theme.megablock.fill}" stroke="${theme.building.stroke}" stroke-width="1"/>`)
  }
}

export function renderLandmarkLabels(model: SectorModel, theme: Theme, out: string[], font: number): void {
  for (const l of [...model.arcologies, ...model.megablocks])
    out.push(`<text data-landmark-label="" x="${n(l.center.x)}" y="${n(l.center.y)}" fill="${theme.districtLabel}" font-size="${n(font * 1.25)}" text-anchor="middle" opacity="0.85">${esc(l.name)}</text>`)
}
