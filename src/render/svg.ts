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

  // Build water and land paths for defs
  const waterD = model.terrain.water
    .map((poly) => poly.map((ring) => `M${ring.map(([x, y]) => `${n(x)},${n(y)}`).join('L')}Z`).join(' '))
    .join(' ')
  const landD = model.terrain.land
    .map((poly) => poly.map((ring) => `M${ring.map(([x, y]) => `${n(x)},${n(y)}`).join('L')}Z`).join(' '))
    .join(' ')

  out.push('<defs>')
  out.push(`<path id="water-shape" d="${waterD}" fill-rule="evenodd"/>`)
  out.push(`<clipPath id="water-clip"><use href="#water-shape"/></clipPath>`)
  out.push(`<clipPath id="land-clip"><path d="${landD}" fill-rule="evenodd"/></clipPath>`)
  // the [0,S]² viewport itself — clips features (river) that would
  // otherwise overrun the frame edge (I3)
  out.push(`<clipPath id="frame-clip"><rect x="0" y="0" width="${n(S)}" height="${n(S)}"/></clipPath>`)
  out.push(`<filter id="shoreblur"><feGaussianBlur stdDeviation="${n(S * 0.004)}"/></filter>`)

  if (theme.glow) {
    out.push(
      '<filter id="glow" x="-50%" y="-50%" width="200%" height="200%">',
      '<feGaussianBlur stdDeviation="8" result="b"/>',
      '<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>',
      '</filter>',
    )
  }
  out.push('</defs>')

  const glowAttr = theme.glow ? ' filter="url(#glow)"' : ''

  out.push(`<rect x="0" y="0" width="${S}" height="${S}" fill="${theme.bg}"/>`)

  // Water fill — reuses the water-shape path already built for the clips
  // above instead of re-serializing the same rings a second time
  out.push(`<use href="#water-shape" fill="${theme.water}" fill-rule="evenodd" data-water=""/>`)

  // Shallow band
  out.push(
    `<use href="#water-shape" fill="none" stroke="${theme.waterShallow}" stroke-width="${n(S * 0.02)}" clip-path="url(#water-clip)"/>`,
  )

  // Shore glow
  out.push(
    `<use href="#water-shape" fill="none" stroke="${theme.shoreGlow}" stroke-width="${n(S * 0.015)}" filter="url(#shoreblur)" clip-path="url(#land-clip)"/>`,
  )

  if (model.terrain.river) {
    const pts = model.terrain.river.course.map((p) => `${n(p.x)},${n(p.y)}`).join(' ')
    out.push(`<g clip-path="url(#frame-clip)">`)
    out.push(
      `<polyline points="${pts}" fill="none" stroke="${theme.water}" stroke-width="${n(model.terrain.river.width)}" stroke-linecap="round"/>`,
    )
    out.push('</g>')
  }

  // district rects are the land bounding box, not the land shape itself
  // (see roads.ts landSlabs) — clip so a rect's corner never paints over
  // water it doesn't actually cover (C2)
  out.push('<g clip-path="url(#land-clip)">')
  for (const d of model.districts) {
    const r = d.bounds
    out.push(
      `<rect data-id="${d.id}" x="${n(r.x)}" y="${n(r.y)}" width="${n(r.w)}" height="${n(r.h)}" fill="${theme.districtFill[d.zone]}"/>`,
    )
  }
  out.push('</g>')

  for (const b of model.buildings) {
    const pts = b.footprint.map((p) => `${n(p.x)},${n(p.y)}`).join(' ')
    out.push(
      `<polygon data-id="${b.id}" points="${pts}" fill="${theme.building.fill}" stroke="${theme.building.stroke}" stroke-width="1"/>`,
    )
  }

  for (const road of model.roads) {
    const pts = road.points.map((p) => `${n(p.x)},${n(p.y)}`).join(' ')
    const glow = road.class === 'street' ? '' : glowAttr
    out.push(
      `<polyline points="${pts}" fill="none" stroke="${theme.road[road.class]}" stroke-width="${road.width}"${glow}/>`,
    )
  }

  // Bridge decks above roads
  for (const road of model.roads) {
    if (!road.bridge) continue
    const pts = road.points.map((p) => `${n(p.x)},${n(p.y)}`).join(' ')
    // Shadow (offset +S*0.002 in y)
    const shadowPts = road.points.map((p) => `${n(p.x)},${n(p.y + S * 0.002)}`).join(' ')
    out.push(
      `<polyline points="${shadowPts}" fill="none" stroke="${theme.bridge.shadow}" stroke-width="${n(road.width * 1.3)}" clip-path="url(#water-clip)"/>`,
    )
    // Deck (square caps)
    out.push(
      `<polyline data-bridge="" points="${pts}" fill="none" stroke="${theme.bridge.deck}" stroke-width="${road.width}" stroke-linecap="square"/>`,
    )
  }

  // Pier decks, above water, below labels
  for (const pier of model.piers) {
    const [a, b] = pier.points
    out.push(
      `<line data-id="${pier.id}" x1="${n(a.x)}" y1="${n(a.y)}" x2="${n(b.x)}" y2="${n(b.y)}" stroke="${theme.bridge.deck}" stroke-width="${n(pier.width)}"/>`,
    )
  }

  const placedLabels: Box[] = []

  for (const d of model.districts) {
    const cx = d.labelAt.x
    const cy = d.labelAt.y
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
