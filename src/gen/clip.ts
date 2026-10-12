import { Clipper, Clipper64, ClipType, FillRule, type Path64, type Paths64 } from 'clipper2-js'

export type Ring = [number, number][]
export type Polygon = Ring[]
export type MultiPolygon = Polygon[]
/** call sites pass either a Polygon or a MultiPolygon */
export type Geom = Polygon | MultiPolygon

// Clipper2 is integer-only: snap to a 1 mm grid (metres * 1e3). 1e4 would also fit in 2^53 but buys
// nothing, since the generator's own geometry is not accurate to 0.1 mm.
const S = 1000

const polys = (g: Geom): Polygon[] =>
  g.length === 0 ? [] : typeof (g as Polygon)[0][0][0] === 'number' ? [g as Polygon] : (g as MultiPolygon)

const area = (p: Path64): number => {
  let a = 0
  for (let k = 0; k < p.length; k++) { const q = p[(k + 1) % p.length]; a += p[k].x * q.y - q.x * p[k].y }
  return a
}

function load(c: Clipper64, g: Geom, subject: boolean): void {
  const paths: Paths64 = []
  for (const poly of polys(g)) {
    poly.forEach((ring, i) => {
      const n = ring.length
      const closed = n > 1 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1]
      const p = ring.slice(0, closed ? n - 1 : n).map(([x, y]) => ({ x: Math.round(x * S), y: Math.round(y * S) }))
      if (p.length < 3) return
      // outer positive, holes negative: NonZero then unions overlapping operands
      if ((area(p) > 0) !== (i === 0)) p.reverse()
      paths.push(p)
    })
  }
  if (subject) c.addSubjectPaths(paths)
  else c.addClipPaths(paths)
}

const inside = (pt: { x: number; y: number }, r: Path64): boolean => {
  let ins = false
  for (let i = 0, j = r.length - 1; i < r.length; j = i++)
    if (r[i].y > pt.y !== r[j].y > pt.y && pt.x < ((r[j].x - r[i].x) * (pt.y - r[i].y)) / (r[j].y - r[i].y) + r[i].x) ins = !ins
  return ins
}

function run(op: ClipType, subj: Geom, clips: Geom[]): MultiPolygon {
  const c = new Clipper64()
  load(c, subj, true)
  for (const g of clips) load(c, g, false)
  const sol: Paths64 = []
  c.execute(op, FillRule.NonZero, sol)
  // clipper2-js 1.2.4 emits consecutive duplicate and collinear vertices: trim both
  const rings = sol
    .map((p) => Clipper.trimCollinear(p.filter((q, i) => { const r = p[(i + p.length - 1) % p.length]; return q.x !== r.x || q.y !== r.y }), false))
    .filter((p) => p.length >= 3)
  // executePolyTree is broken in 1.2.4 (throws inside, returns an empty tree): rebuild holes by
  // containment. Outer = positive area, hole = negative, hole goes to the smallest outer holding it.
  const outers: { r: Path64; a: number; holes: Path64[] }[] = []
  const holes: Path64[] = []
  for (const r of rings) { const a = area(r); if (a > 0) outers.push({ r, a, holes: [] }); else holes.push(r) }
  for (const h of holes) {
    let best: (typeof outers)[number] | undefined
    for (const o of outers) if (inside(h[0], o.r) && (!best || o.a < best.a)) best = o
    best?.holes.push(h)
  }
  // closed rings (first point repeated), as polygon-clipping returned them
  const ring = (p: Path64): Ring => { const r = p.map((q) => [q.x / S, q.y / S] as [number, number]); r.push(r[0]); return r }
  return outers.map((o) => [ring(o.r), ...o.holes.map(ring)])
}

export const intersection = (a: Geom, ...b: Geom[]): MultiPolygon => run(ClipType.Intersection, a, b)
/** a minus the union of the subtrahends */
export const difference = (a: Geom, ...b: Geom[]): MultiPolygon => run(ClipType.Difference, a, b)
export const union = (a: Geom, ...b: Geom[]): MultiPolygon => run(ClipType.Union, a, b)
