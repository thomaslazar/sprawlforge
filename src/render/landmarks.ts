import type { Pt } from '../gen/geometry'
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
    out.push(`<polygon data-arcology="${a.id}" points="${pts(a.footprint)}" fill="${theme.arcology.fill}" stroke="${theme.arcology.stroke}" stroke-width="2"/>`)
    for (const k of [0.66, 0.33])
      out.push(`<polygon points="${pts(a.footprint.map((p) => ({ x: a.center.x + (p.x - a.center.x) * k, y: a.center.y + (p.y - a.center.y) * k })))}" fill="none" stroke="${theme.arcology.ring}" stroke-width="1"/>`)
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
