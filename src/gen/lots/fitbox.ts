import { ringArea, ringCentroid, type Pt } from '../geometry'

export interface FitBox { origin: Pt; angle: number; w: number; d: number }

const EPS = 1e-6
const WIDE = 120

/** R10: largest-area chord-aligned rectangle in the lot (x along the chord, y inward), x0 < x1 on a 1 m grid, front on the innermost frontage point of [x0, x1], as deep as fits; ties -> wider */
export function fitBox(lot: Pt[], chord: [Pt, Pt]): FitBox {
  let [o, e] = chord
  const frame = (): { u: Pt; n: Pt; q: Pt[] } => {
    const l = Math.hypot(e.x - o.x, e.y - o.y) || 1
    const u = { x: (e.x - o.x) / l, y: (e.y - o.y) / l }, n = { x: -u.y, y: u.x }
    return { u, n, q: lot.map((p) => ({ x: (p.x - o.x) * u.x + (p.y - o.y) * u.y, y: (p.x - o.x) * n.x + (p.y - o.y) * n.y })) }
  }
  let f = frame()
  if (ringCentroid(f.q).y < 0) { [o, e] = [e, o]; f = frame() } // the lot lies right of the chord: walk it the other way round
  const { u, n, q } = f
  const angle = Math.atan2(u.y, u.x)
  const minX = Math.min(...q.map((p) => p.x)), maxX = Math.max(...q.map((p) => p.x))

  /** first interval from the front at x, or null */
  const section = (x: number): [number, number] | null => {
    const ys: number[] = []
    for (let i = 0; i < q.length; i++) {
      const a = q[i], b = q[(i + 1) % q.length]
      if (a.x <= x !== b.x <= x) ys.push(a.y + ((x - a.x) / (b.x - a.x)) * (b.y - a.y))
    }
    ys.sort((p, r) => p - r)
    return ys.length >= 2 ? [ys[0], ys[1]] : null
  }
  const clamp = (x: number) => Math.min(maxX - EPS, Math.max(minX + EPS, x))

  /** best box over grid points of `step`, x0 in r0 and x1 in r1 (grid offsets from minX) */
  const search = (step: number, r0: [number, number], r1: [number, number]) => {
    const lo = Math.max(minX, r0[0]), hi = Math.min(maxX, r1[1])
    const samples: { x: number; g: number; s: [number, number] | null }[] = []
    const K = Math.floor((hi - minX) / step + 1e-9)
    for (let k = Math.ceil((lo - minX) / step - 1e-9); k <= K; k++) samples.push({ x: clamp(minX + k * step), g: k, s: null })
    for (const p of q) for (const x of [p.x - EPS, p.x + EPS]) if (x >= lo && x <= hi && x > minX && x < maxX) samples.push({ x, g: -1, s: null })
    samples.sort((a, b) => a.x - b.x)
    for (const s of samples) s.s = section(s.x)
    let best = { area: 0, w: 0, d: 0, x0: 0, front: 0 }
    for (let i = 0; i < samples.length; i++) {
      const a = samples[i]
      const x0 = minX + a.g * step
      if (a.g < 0 || x0 < r0[0] - 1e-9 || x0 > r0[1] + 1e-9 || !a.s) continue
      let front = -Infinity, back = Infinity
      for (let j = i; j < samples.length; j++) {
        const c = samples[j]
        if (!c.s) break
        front = Math.max(front, c.s[0]); back = Math.min(back, c.s[1])
        if (back <= front) break
        const x1 = minX + c.g * step
        if (c.g < 0 || x1 <= x0 || x1 < r1[0] - 1e-9 || x1 > r1[1] + 1e-9) continue
        const w = x1 - x0, d = back - front, area = w * d
        if (area > best.area + 1e-9 || (Math.abs(area - best.area) <= 1e-9 && w > best.w)) best = { area, w, d, x0, front }
      }
    }
    return best
  }

  const all: [number, number] = [minX, maxX]
  let best = search(maxX - minX > WIDE ? 2 : 1, all, all)
  if (maxX - minX > WIDE && best.area > 0) { // coarse 2 m pass, then refine both ends at 1 m
    best = search(1, [best.x0 - 2, best.x0 + 2], [best.x0 + best.w - 2, best.x0 + best.w + 2])
  }
  const org = { x: o.x + u.x * best.x0 + n.x * best.front, y: o.y + u.y * best.x0 + n.y * best.front }
  return { origin: best.area > 0 ? org : { ...o }, angle, w: best.w, d: best.d }
}

export function boxRing(b: FitBox): Pt[] {
  const u = { x: Math.cos(b.angle), y: Math.sin(b.angle) }, n = { x: -u.y, y: u.x }
  return [[0, 0], [b.w, 0], [b.w, b.d], [0, b.d]].map(([a, c]) => ({ x: b.origin.x + u.x * a + n.x * c, y: b.origin.y + u.y * a + n.y * c }))
}

export const holds = (b: FitBox, w: number, d: number): boolean => (b.w >= w && b.d >= d) || (b.w >= d && b.d >= w)

/** T5 probe: from every edge midpoint the inward normal runs >= min before meeting another edge */
export function widthOk(poly: Pt[], min: number): boolean {
  const sign = ringArea(poly) >= 0 ? 1 : -1, N = poly.length
  return poly.every((a, i) => {
    const b = poly[(i + 1) % N]
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1
    const dir = { x: (-sign * (b.y - a.y)) / l, y: (sign * (b.x - a.x)) / l }
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    let t = Infinity
    for (let j = 0; j < N; j++) {
      if (j === i) continue
      const c = poly[j], e = poly[(j + 1) % N]
      const ex = e.x - c.x, ey = e.y - c.y, den = dir.x * ey - dir.y * ex
      if (Math.abs(den) < 1e-12) continue
      const s = ((c.x - m.x) * ey - (c.y - m.y) * ex) / den, r = ((c.x - m.x) * dir.y - (c.y - m.y) * dir.x) / den
      if (s > 1e-9 && r >= -1e-9 && r <= 1 + 1e-9) t = Math.min(t, s)
    }
    return t >= min - 1e-9
  })
}
