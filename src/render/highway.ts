import type { Pt } from '../gen/geometry'
import { pointAtT, polylineLength, slicePolyline } from '../gen/geometry'
import { buildPlanarGraph, degree4Vertices } from '../gen/streets/graph'
import { HIGHWAY_WIDTH } from '../gen/streets/highway'
import type { Road, SectorModel } from '../gen/types'
import type { Theme } from './theme'

const n = (v: number) => String(Math.round(v * 100) / 100)
const pts = (p: Pt[]) => p.map((q) => `${n(q.x)},${n(q.y)}`).join(' ')

/** unit normal of the polyline at each vertex (averaged over adjacent segments) */
function normals(p: Pt[]): Pt[] {
  return p.map((_, i) => {
    const a = p[Math.max(0, i - 1)]
    const b = p[Math.min(p.length - 1, i + 1)]
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1
    return { x: -(b.y - a.y) / l, y: (b.x - a.x) / l }
  })
}
const offset = (p: Pt[], d: number): Pt[] => {
  const nm = normals(p)
  return p.map((q, i) => ({ x: q.x + nm[i].x * d, y: q.y + nm[i].y * d }))
}

/** stripes of `len` m perpendicular to the polyline at arc-length fractions ts */
function ticks(line: Pt[], ts: number[], len: number): string[] {
  return ts.map((t) => {
    const c = pointAtT(line, t)
    const [a, b] = [pointAtT(line, t - 0.001), pointAtT(line, t + 0.001)]
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1
    const nx = (-(b.y - a.y) / l) * (len / 2)
    const ny = ((b.x - a.x) / l) * (len / 2)
    return `M${n(c.x - nx)},${n(c.y - ny)}L${n(c.x + nx)},${n(c.y + ny)}`
  })
}

const pieceKey = (id: string) => {
  const m = id.match(/-(b?)(\d+)$/)
  return m ? Number(m[2]) + (m[1] ? 0.5 : 0) : 0
}

/** highway pieces (markWetSpans may split it) joined back into one polyline */
function fullHighway(roads: Road[]): { line: Pt[]; first: Road } | null {
  const pieces = roads.filter((r) => r.class === 'highway').sort((a, b) => pieceKey(a.id) - pieceKey(b.id))
  if (!pieces.length) return null
  const line: Pt[] = []
  for (const p of pieces)
    for (const q of p.points) {
      const l = line[line.length - 1]
      if (!l || Math.hypot(l.x - q.x, l.y - q.y) > 1e-6) line.push(q)
    }
  return { line, first: pieces[0] }
}

/** sunken trench, level-styled highway, crossing decks, transitions */
export function renderHighway(model: SectorModel, theme: Theme, out: string[], glowAttr = ''): void {
  const hw = fullHighway(model.roads)
  const segs = hw?.first.segments
  if (!hw || !segs?.length) return
  const { line } = hw
  const W = HIGHWAY_WIDTH
  const poly = (p: Pt[], stroke: string, w: number, extra = '') =>
    `<polyline points="${pts(p)}" fill="none" stroke="${stroke}" stroke-width="${w}"${extra}/>`
  const slice = (s: { from: number; to: number }) => slicePolyline(line, s.from, s.to)

  for (const s of segs) {
    if (s.level !== 'sunken') continue
    const p = slice(s)
    out.push(
      poly(p, theme.bg, W + 8),
      poly(offset(p, W / 2), theme.highway.trench, 1.5),
      poly(offset(p, -W / 2), theme.highway.trench, 1.5),
    )
  }

  const total = polylineLength(line) || 1
  for (const s of segs) {
    const p = slice(s)
    out.push(`<g data-level="${s.level}">`)
    if (s.level === 'ground')
      for (const d of [W / 2 + 3, -(W / 2 + 3)]) out.push(poly(offset(p, d), theme.highway.trench, 1))
    if (s.level === 'elevated') {
      const ts: number[] = []
      for (let m = 0; m < (s.to - s.from) * total; m += 40) ts.push(s.from + m / total)
      out.push(`<path d="${ticks(line, ts, 6).join('')}" fill="none" stroke="${theme.highway.column}" stroke-width="2"/>`)
    }
    out.push(poly(p, theme.road.highway, W, glowAttr), '</g>')
  }

  for (const c of hw.first.crossings ?? []) {
    const road =
      model.roads.find((r) => r.id === c.roadId) ?? model.roads.find((r) => r.id.startsWith(c.roadId + '-'))
    if (!road) continue
    // ponytail: nearest vertex-free projection — locate crossing on the road by nearest point to the highway point
    const hp = pointAtT(line, c.at)
    const rl = polylineLength(road.points) || 1
    let best = Infinity
    let bt = 0
    for (let i = 0; i <= 200; i++) {
      const q = pointAtT(road.points, i / 200)
      const d = Math.hypot(q.x - hp.x, q.y - hp.y)
      if (d < best) { best = d; bt = i / 200 }
    }
    const half = (W / 2 + 6) / rl
    const sl = slicePolyline(road.points, Math.max(0, bt - half), Math.min(1, bt + half))
    out.push(
      c.kind === 'over'
        ? poly(sl, theme.bridge.deck, road.width)
        : poly(sl, theme.road[road.class], road.width, ' stroke-dasharray="4 4"'),
    )
  }

  for (const s of segs) {
    if (!s.transition) continue
    const ts: number[] = []
    for (let m = 0; m < 150; m += 8) ts.push(s.from + m / total)
    out.push(
      `<path d="${ticks(line, ts, W).join('')}" fill="none" stroke="${theme.highway.hatch}" stroke-width="4" opacity="0.6"/>`,
    )
  }
}

/** invisible crossroad markers for uicheck */
export function renderJunctionMarkers(model: SectorModel, out: string[]): void {
  const g = buildPlanarGraph(model.roads.filter((r) => r.class !== 'ramp'), [], 5)
  out.push('<g data-junctions="">')
  for (const p of degree4Vertices(g))
    out.push(`<circle data-junction="4" cx="${n(p.x)}" cy="${n(p.y)}" r="0" fill="none"/>`)
  out.push('</g>')
}
