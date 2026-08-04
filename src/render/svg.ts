import type { SectorModel } from '../gen/types'
import type { Theme } from './theme'

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const n = (v: number) => String(Math.round(v * 100) / 100)

interface Box {
  x: number
  y: number
  w: number
  h: number
}

type Anchor = 'start' | 'middle' | 'end'

// ponytail: estimated char-width boxes, no leader lines — good enough per
// spec §5; measure real glyphs if estimates still misplace labels
function textBox(x: number, y: number, text: string, fontSize: number, anchor: Anchor): Box {
  const w = text.length * fontSize * 0.6
  const h = fontSize
  const bx = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x
  return { x: bx, y: y - h, w, h }
}

function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

/** shift needed to keep box fully inside [0,S]² so edge labels don't clip */
function clampShift(box: Box, S: number): { dx: number; dy: number } {
  const dx = box.x < 0 ? -box.x : box.x + box.w > S ? S - box.x - box.w : 0
  const dy = box.y < 0 ? -box.y : box.y + box.h > S ? S - box.y - box.h : 0
  return { dx, dy }
}

// ponytail: fixed type ranks — move to PoiTypeDef weight when packs need control
const POI_RANK: Record<string, number> = {
  corp_hq: 0,
  matrix_hub: 1,
  corp_office: 2,
  clinic: 3,
  market: 4,
  talismonger: 5,
  warehouse: 6,
  club: 7,
  safehouse: 8,
  bar: 9,
}

export interface RenderOpts {
  /** viewport zoom band (1|2|4|8): labels shrink in world units so they stay
   * constant on screen, freeing room — more labels appear as you zoom in */
  labelZoom?: number
}

export function renderSector(model: SectorModel, theme: Theme, opts: RenderOpts = {}): string {
  const S = model.meta.sizeM
  const out: string[] = []
  const labelZoom = Math.min(8, Math.max(1, opts.labelZoom ?? 1))
  const fontD = (S * 0.018) / labelZoom
  const fontP = (S * 0.011) / labelZoom

  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" font-family="system-ui, sans-serif">`,
  )
  if (theme.glow) {
    out.push(
      '<defs><filter id="glow" x="-50%" y="-50%" width="200%" height="200%">',
      '<feGaussianBlur stdDeviation="8" result="b"/>',
      '<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>',
      '</filter></defs>',
    )
  }
  const glowAttr = theme.glow ? ' filter="url(#glow)"' : ''

  out.push(`<rect x="0" y="0" width="${S}" height="${S}" fill="${theme.bg}"/>`)

  for (const poly of model.terrain.water) {
    const d = poly
      .map((ring) => `M${ring.map(([x, y]) => `${n(x)},${n(y)}`).join('L')}Z`)
      .join(' ')
    out.push(`<path d="${d}" fill="${theme.water}" fill-rule="evenodd"/>`)
  }
  if (model.terrain.river) {
    const pts = model.terrain.river.course.map((p) => `${n(p.x)},${n(p.y)}`).join(' ')
    out.push(
      `<polyline points="${pts}" fill="none" stroke="${theme.water}" stroke-width="${n(model.terrain.river.width)}" stroke-linecap="round"/>`,
    )
  }

  for (const d of model.districts) {
    const r = d.bounds
    out.push(
      `<rect data-id="${d.id}" x="${n(r.x)}" y="${n(r.y)}" width="${n(r.w)}" height="${n(r.h)}" fill="${theme.districtFill[d.zone]}"/>`,
    )
  }

  for (const b of model.buildings) {
    const r = b.rect
    out.push(
      `<rect data-id="${b.id}" x="${n(r.x)}" y="${n(r.y)}" width="${n(r.w)}" height="${n(r.h)}" fill="${theme.building.fill}" stroke="${theme.building.stroke}" stroke-width="1"/>`,
    )
  }

  for (const road of model.roads) {
    const pts = road.points.map((p) => `${n(p.x)},${n(p.y)}`).join(' ')
    const glow = road.class === 'street' ? '' : glowAttr
    out.push(
      `<polyline points="${pts}" fill="none" stroke="${theme.road[road.class]}" stroke-width="${road.width}"${glow}/>`,
    )
  }

  const placedLabels: Box[] = []

  for (const d of model.districts) {
    const cx = d.bounds.x + d.bounds.w / 2
    const cy = d.bounds.y + d.bounds.h / 2
    // district labels always render — they anchor the map — but still
    // occupy space so later poi labels avoid them
    const raw = textBox(cx, cy, d.name, fontD, 'middle')
    const { dx, dy } = clampShift(raw, S)
    placedLabels.push({ ...raw, x: raw.x + dx, y: raw.y + dy })
    out.push(
      `<text x="${n(cx + dx)}" y="${n(cy + dy)}" fill="${theme.districtLabel}" font-size="${n(fontD)}" text-anchor="middle" opacity="0.85"${glowAttr}>${esc(d.name)}</text>`,
    )
  }

  // markers first (all pois, model order, hover tooltip carries the name even
  // when the visible label loses the placement contest)
  const markerR = (S * 0.004) / labelZoom
  for (const p of model.pois) {
    out.push(
      `<circle data-id="${p.id}" cx="${n(p.at.x)}" cy="${n(p.at.y)}" r="${n(markerR)}" fill="${theme.poi.marker}"${glowAttr}><title>${esc(p.name)}</title></circle>`,
    )
  }

  // labels by importance: when space runs out, the corp HQ wins over the bar
  const byRank = [...model.pois].sort(
    (a, b) => (POI_RANK[a.type] ?? 5) - (POI_RANK[b.type] ?? 5),
  )
  const off = (S * 0.006) / labelZoom
  for (const p of byRank) {
    const candidates: Array<{ x: number; y: number; anchor: Anchor }> = [
      { x: p.at.x + off, y: p.at.y - markerR, anchor: 'start' },
      { x: p.at.x - off, y: p.at.y - markerR, anchor: 'end' },
      { x: p.at.x, y: p.at.y - off * 1.5, anchor: 'middle' },
      { x: p.at.x, y: p.at.y + off * 1.5 + fontP, anchor: 'middle' },
    ]
    for (const c of candidates) {
      const raw = textBox(c.x, c.y, p.name, fontP, c.anchor)
      const { dx, dy } = clampShift(raw, S)
      const box = { ...raw, x: raw.x + dx, y: raw.y + dy }
      if (placedLabels.some((b) => intersects(box, b))) continue
      placedLabels.push(box)
      const anchorAttr = c.anchor === 'start' ? '' : ` text-anchor="${c.anchor}"`
      out.push(
        `<text x="${n(c.x + dx)}" y="${n(c.y + dy)}" fill="${theme.poi.label}" font-size="${n(fontP)}"${anchorAttr}>${esc(p.name)}</text>`,
      )
      break
    }
  }

  const barM = model.meta.params.size < 5 ? 500 : 1000
  const barLabel = barM === 500 ? '500 m' : '1 km'
  const bx = S * 0.03
  const by = S * 0.97
  out.push(
    `<line x1="${n(bx)}" y1="${n(by)}" x2="${n(bx + barM)}" y2="${n(by)}" stroke="${theme.scaleBar}" stroke-width="${n(S * 0.003)}"/>`,
    `<text x="${n(bx)}" y="${n(by - S * 0.008)}" fill="${theme.scaleBar}" font-size="${n(fontP)}">${barLabel}</text>`,
  )

  out.push('</svg>')
  return out.join('')
}
