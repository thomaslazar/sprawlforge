import { Clipper, Clipper64, ClipType, FillRule, InternalClipper, Point64, type Path64, type Paths64 } from 'clipper2-js'

// clipper2-js 1.2.4 ports C#'s struct Point64 as a shared object: getIntersectPoint returns an edge END
// (the input vertex's own point) when t <= 0 or >= 1, and addNewIntersectNode then moves that point in
// place, so an input vertex walks onto another's scanline. A ring whose vertices all end up on one y sends
// getCurrYMaximaVertex round it forever (the seed-42 default-params hang). Hand out a copy instead.
const getIntersectPoint = InternalClipper.getIntersectPoint
InternalClipper.getIntersectPoint = (a, b, c, d) => {
  const r = getIntersectPoint(a, b, c, d)
  return r.ip === a || r.ip === b ? { ip: new Point64(r.ip.x, r.ip.y), success: r.success } : r
}

export type Ring = [number, number][]
export type Polygon = Ring[]
export type MultiPolygon = Polygon[]
/** call sites pass either a Polygon or a MultiPolygon */
export type Geom = Polygon | MultiPolygon

// Clipper2 is integer-only: snap to a 1 mm grid (metres * 1e3). 1e4 would also fit in 2^53 but buys
// nothing, since the generator's own geometry is not accurate to 0.1 mm.
const S = 1000

const polys = (g: Geom): Polygon[] => {
  const first = (g as Polygon[]).find((x) => x.length > 0) // skip empty rings / polygons when sniffing the depth
  if (!first) return []
  return typeof (first as unknown as Ring)[0]?.[0] === 'number' ? [g as Polygon] : (g as MultiPolygon)
}

const area = (p: Path64): number => {
  let a = 0
  for (let k = 0; k < p.length; k++) { const q = p[(k + 1) % p.length]; a += p[k].x * q.y - q.x * p[k].y }
  return a
}

/** false if any coordinate is not finite */
function load(c: Clipper64, g: Geom, subject: boolean): boolean {
  const paths: Paths64 = []
  let ok = true
  for (const poly of polys(g)) {
    poly.forEach((ring, i) => {
      const n = ring.length
      if (ring.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) { ok = false; return }
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
  return ok
}

const inside = (pt: { x: number; y: number }, r: Path64): boolean => {
  let ins = false
  for (let i = 0, j = r.length - 1; i < r.length; j = i++)
    if (r[i].y > pt.y !== r[j].y > pt.y && pt.x < ((r[j].x - r[i].x) * (pt.y - r[i].y)) / (r[j].y - r[i].y) + r[i].x) ins = !ins
  return ins
}

function run(op: ClipType, subj: Geom, clips: Geom[]): MultiPolygon {
  const c = new Clipper64()
  let ok = load(c, subj, true)
  for (const g of clips) ok = load(c, g, false) && ok
  if (!ok) return [] // NaN / Infinity in the input
  const sol: Paths64 = []
  if (!c.execute(op, FillRule.NonZero, sol)) return []
  return toMulti(sol)
}

/** rebuild polygons (outer + holes) from raw clipper output */
function toMulti(sol: Paths64): MultiPolygon {
  // clipper2-js 1.2.4 emits consecutive duplicate and collinear vertices: trim both
  const rings = sol
    .map((p) => Clipper.trimCollinear(p.filter((q, i) => { const r = p[(i + p.length - 1) % p.length]; return q.x !== r.x || q.y !== r.y }), false))
    .filter((p) => p.length >= 3)
  // executePolyTree is broken in 1.2.4 (throws inside, returns an empty tree): rebuild holes by
  // containment. Outer = positive area, hole = negative, hole goes to the smallest outer holding it.
  const outers: { r: Path64; a: number; holes: Path64[] }[] = []
  const holes: Path64[] = []
  for (const r of rings) { const a = area(r); if (a > 0) outers.push({ r, a, holes: [] }); else holes.push(r) }
  // a hole vertex may lie ON its outer's edge (ray test is then arbitrary): the outer holding most vertices wins
  for (const h of holes) {
    let best: (typeof outers)[number] | undefined
    let bestN = 0
    for (const o of outers) {
      const n = h.reduce((t, q) => t + (inside(q, o.r) ? 1 : 0), 0)
      if (n > bestN || (n === bestN && n > 0 && best && o.a < best.a)) { best = o; bestN = n }
    }
    best?.holes.push(h)
  }
  // closed rings (first point repeated), as polygon-clipping returned them
  const ring = (p: Path64): Ring => { const r = p.map((q) => [q.x / S, q.y / S] as [number, number]); r.push([...r[0]]); return r }
  return outers.map((o) => [ring(o.r), ...o.holes.map(ring)])
}

export const intersection = (a: Geom, ...b: Geom[]): MultiPolygon => run(ClipType.Intersection, a, b)
/** a minus the union of the subtrahends */
export const difference = (a: Geom, ...b: Geom[]): MultiPolygon => run(ClipType.Difference, a, b)
export const union = (a: Geom, ...b: Geom[]): MultiPolygon => run(ClipType.Union, a, b)

/** positive-fill union of one self-overlapping ring, taken as given (no reorientation): loops of the opposite winding vanish */
export const unionPositive = (ring: Ring): MultiPolygon => {
  if (ring.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) return []
  const c = new Clipper64()
  c.addSubjectPaths([ring.map(([x, y]) => ({ x: Math.round(x * S), y: Math.round(y * S) }))])
  const sol: Paths64 = []
  return c.execute(ClipType.Union, FillRule.Positive, sol) ? toMulti(sol) : []
}
