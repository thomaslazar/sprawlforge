import type { Pt } from '../gen/geometry'
import { pointAtT, polylineLength, slicePolyline } from '../gen/geometry'
import { nearestOnPolyline } from '../gen/terrain/rivers'
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

/** perpendicular segments at fractions ts spanning offsets [from, to] from the centreline (both sides when mirror) */
function ticks(line: Pt[], ts: number[], from: number, to: number, mirror = false): string[] {
  return ts.flatMap((t) => {
    const c = pointAtT(line, t)
    const [a, b] = [pointAtT(line, t - 0.001), pointAtT(line, t + 0.001)]
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1
    const nx = -(b.y - a.y) / l
    const ny = (b.x - a.x) / l
    const seg = (k: number) =>
      `M${n(c.x + nx * from * k)},${n(c.y + ny * from * k)}L${n(c.x + nx * to * k)},${n(c.y + ny * to * k)}`
    return mirror ? [seg(1), seg(-1)] : [seg(1)]
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
export function renderHighway(model: SectorModel, theme: Theme, out: string[], glowAttr = '', halo = false): void {
  const hw = fullHighway(model.roads)
  const segs = hw?.first.segments
  if (!hw || !segs?.length) return
  const { line } = hw
  const W = HIGHWAY_WIDTH
  const poly = (p: Pt[], stroke: string, w: number | string, extra = '') =>
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

  // one translucent path for every segment: overlapping caps/joints composite once
  if (halo)
    out.push(
      `<path data-halo="highway" d="${segs.map((s) => `M${pts(slice(s)).replace(/ /g, 'L')}`).join(' ')}" fill="none" stroke="${theme.road.highway}" stroke-width="${n(W * 2.2)}" stroke-opacity="0.35" stroke-linecap="round" stroke-linejoin="round"/>`,
    )
  const total = polylineLength(line) || 1
  for (const s of segs) {
    const p = slice(s)
    out.push(`<g data-level="${s.level}">`)
    if (s.level === 'ground')
      for (const d of [W / 2 + 3, -(W / 2 + 3)]) out.push(poly(offset(p, d), theme.highway.trench, 1))
    if (s.level === 'elevated') {
      const ts: number[] = []
      for (let m = 0; m < (s.to - s.from) * total; m += 40) ts.push(s.from + m / total)
      out.push(`<path d="${ticks(line, ts, W / 2, W / 2 + 8, true).join('')}" fill="none" stroke="${theme.highway.column}" stroke-width="2"/>`)
    }
    out.push(poly(p, theme.road.highway, W, glowAttr), '</g>')
  }

  for (const c of hw.first.crossings ?? []) {
    const hp = pointAtT(line, c.at)
    const road = model.roads
      .filter((r) => r.id === c.roadId || r.id.startsWith(c.roadId + '-'))
      .map((r) => ({ r, ...nearestOnPolyline(hp, r.points) }))
      .sort((x, y) => x.dist - y.dist)[0]
    if (!road) continue
    const rp = road.r.points
    const rl = polylineLength(rp) || 1
    // t01 is vertex-index based; convert to the arc-length fraction slicePolyline expects
    const k = Math.min(rp.length - 2, Math.floor(road.t01 * (rp.length - 1)))
    const f = road.t01 * (rp.length - 1) - k
    const at = (polylineLength(rp.slice(0, k + 1)) + f * Math.hypot(rp[k + 1].x - rp[k].x, rp[k + 1].y - rp[k].y)) / rl
    const half = (W / 2 + 6) / rl
    const sl = slicePolyline(rp, Math.max(0, at - half), Math.min(1, at + half))
    out.push(
      c.kind === 'over'
        ? poly(sl, theme.bridge.deck, road.r.width)
        : poly(sl, theme.road[road.r.class], road.r.width, ' stroke-dasharray="4 4"'),
    )
  }

  for (const s of segs) {
    if (!s.transition) continue
    const ts: number[] = []
    for (let m = 0; m < 150; m += 8) ts.push(s.from + m / total)
    out.push(
      `<path d="${ticks(line, ts, -W / 2, W / 2).join('')}" fill="none" stroke="${theme.highway.hatch}" stroke-width="4" opacity="0.6"/>`,
    )
  }
}

/** invisible crossroad markers for uicheck */
export function renderJunctionMarkers(model: SectorModel, out: string[]): void {
  const g = buildPlanarGraph(model.roads.filter((r) => r.class !== 'ramp'), [], 5)
  out.push(`<g data-junctions="" data-count="${degree4Vertices(g).length}"/>`)
}
