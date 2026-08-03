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

// ponytail: greedy bbox rejection, not true label placement (no nudging/leader
// lines) — good enough per spec §5; upgrade if labels still collide visibly
function textBox(x: number, y: number, text: string, fontSize: number, anchor: 'start' | 'middle'): Box {
  const w = text.length * fontSize * 0.6
  const h = fontSize
  return { x: anchor === 'middle' ? x - w / 2 : x, y: y - h, w, h }
}

function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

export function renderSector(model: SectorModel, theme: Theme): string {
  const S = model.meta.sizeM
  const out: string[] = []
  const fontD = S * 0.018
  const fontP = S * 0.011

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

  if (model.water.kind !== 'none') {
    const pts = model.water.polygon.map((p) => `${n(p.x)},${n(p.y)}`).join(' ')
    out.push(`<polygon points="${pts}" fill="${theme.water}"/>`)
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
    placedLabels.push(textBox(cx, cy, d.name, fontD, 'middle'))
    out.push(
      `<text x="${n(cx)}" y="${n(cy)}" fill="${theme.districtLabel}" font-size="${n(fontD)}" text-anchor="middle" opacity="0.85"${glowAttr}>${esc(d.name)}</text>`,
    )
  }

  for (const p of model.pois) {
    out.push(
      `<circle data-id="${p.id}" cx="${n(p.at.x)}" cy="${n(p.at.y)}" r="${n(S * 0.004)}" fill="${theme.poi.marker}"${glowAttr}/>`,
    )
    const lx = p.at.x + S * 0.006
    const ly = p.at.y - S * 0.004
    const box = textBox(lx, ly, p.name, fontP, 'start')
    if (!placedLabels.some((b) => intersects(box, b))) {
      placedLabels.push(box)
      out.push(
        `<text x="${n(lx)}" y="${n(ly)}" fill="${theme.poi.label}" font-size="${n(fontP)}">${esc(p.name)}</text>`,
      )
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
