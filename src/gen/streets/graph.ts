import polygonClipping, { type MultiPolygon } from 'polygon-clipping'
import { ringArea, type Pt } from '../geometry'
import type { Road, Terrain } from '../types'

export interface PlanarGraph {
  vertices: Pt[]
  edges: Array<{ a: number; b: number; roadId: string | null }>
}

type Edge = PlanarGraph['edges'][number]

const CELL = 200
const EPS = 1e-7

const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y)
const cellOf = (p: Pt): [number, number] => [Math.floor(p.x / CELL), Math.floor(p.y / CELL)]
const cellKey = (cx: number, cy: number): string => `${cx},${cy}`

/** nearest point to p on segment ab, clamped to the segment */
function nearestOnSegment(p: Pt, a: Pt, b: Pt): { pt: Pt; d: number } {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const len2 = abx * abx + aby * aby || 1
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2))
  const pt = { x: a.x + t * abx, y: a.y + t * aby }
  return { pt, d: dist(p, pt) }
}

/** parametric segment-segment intersection; null when parallel/collinear or the hit isn't strictly interior to both */
function segIntersect(a: Pt, b: Pt, c: Pt, d: Pt): { t: number; u: number; pt: Pt } | null {
  const rx = b.x - a.x
  const ry = b.y - a.y
  const sx = d.x - c.x
  const sy = d.y - c.y
  const denom = rx * sy - ry * sx
  if (Math.abs(denom) < 1e-9) return null
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / denom
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / denom
  if (t <= EPS || t >= 1 - EPS || u <= EPS || u >= 1 - EPS) return null
  return { t, u, pt: { x: a.x + t * rx, y: a.y + t * ry } }
}

function bboxCells(a: Pt, b: Pt): Array<[number, number]> {
  const cx0 = Math.floor(Math.min(a.x, b.x) / CELL)
  const cx1 = Math.floor(Math.max(a.x, b.x) / CELL)
  const cy0 = Math.floor(Math.min(a.y, b.y) / CELL)
  const cy1 = Math.floor(Math.max(a.y, b.y) / CELL)
  const cells: Array<[number, number]> = []
  for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) cells.push([cx, cy])
  return cells
}

/**
 * Insert every road + boundary segment, welding endpoints (existing vertex within
 * snapTol reused; endpoint within snapTol of a segment interior splits it), then
 * a second pass splits every pair of segments that cross in the welded result.
 * Both passes bucket segments in a 200 m grid so only nearby pairs are tested.
 */
export function buildPlanarGraph(roads: Road[], boundaries: Pt[][], snapTol = 5): PlanarGraph {
  const vertices: Pt[] = []
  const vGrid = new Map<string, number[]>()
  const edges = new Map<number, Edge>()
  const eGrid = new Map<string, Set<number>>()
  const dedup = new Map<string, number>()
  let nextId = 0

  const vAdd = (p: Pt): number => {
    const idx = vertices.length
    vertices.push(p)
    const [cx, cy] = cellOf(p)
    const k = cellKey(cx, cy)
    let arr = vGrid.get(k)
    if (!arr) { arr = []; vGrid.set(k, arr) }
    arr.push(idx)
    return idx
  }

  const vNear = (p: Pt): number => {
    const [cx, cy] = cellOf(p)
    let best = -1
    let bestD = snapTol
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const arr = vGrid.get(cellKey(cx + dx, cy + dy))
        if (!arr) continue
        for (const i of arr) {
          const d = dist(vertices[i], p)
          if (d <= bestD) { bestD = d; best = i }
        }
      }
    }
    return best
  }

  const eKey = (a: number, b: number): string => (a < b ? `${a},${b}` : `${b},${a}`)

  const eGridAdd = (id: number, e: Edge): void => {
    for (const [cx, cy] of bboxCells(vertices[e.a], vertices[e.b])) {
      const k = cellKey(cx, cy)
      let s = eGrid.get(k)
      if (!s) { s = new Set(); eGrid.set(k, s) }
      s.add(id)
    }
  }

  const eGridRemove = (id: number, e: Edge): void => {
    for (const [cx, cy] of bboxCells(vertices[e.a], vertices[e.b])) eGrid.get(cellKey(cx, cy))?.delete(id)
  }

  const addEdge = (a: number, b: number, roadId: string | null): void => {
    if (a === b) return
    const key = eKey(a, b)
    if (dedup.has(key)) return
    const id = nextId++
    const e = { a, b, roadId }
    edges.set(id, e)
    dedup.set(key, id)
    eGridAdd(id, e)
  }

  const removeEdge = (id: number): Edge | undefined => {
    const e = edges.get(id)
    if (!e) return undefined
    eGridRemove(id, e)
    edges.delete(id)
    dedup.delete(eKey(e.a, e.b))
    return e
  }

  const splitEdge = (id: number, proj: Pt): number => {
    const e = removeEdge(id)!
    const v = vAdd(proj)
    addEdge(e.a, v, e.roadId)
    addEdge(v, e.b, e.roadId)
    return v
  }

  /** vertex for p: reuse a vertex within snapTol, else split a nearby edge interior, else create one */
  const weld = (p: Pt): number => {
    const hitV = vNear(p)
    if (hitV >= 0) return hitV
    const [cx, cy] = cellOf(p)
    let bestId = -1
    let bestD = snapTol
    let bestPt: Pt | null = null
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const ids = eGrid.get(cellKey(cx + dx, cy + dy))
        if (!ids) continue
        for (const id of ids) {
          const e = edges.get(id)
          if (!e) continue
          const { pt, d } = nearestOnSegment(p, vertices[e.a], vertices[e.b])
          if (d <= bestD) { bestD = d; bestId = id; bestPt = pt }
        }
      }
    }
    if (bestId >= 0 && bestPt) return splitEdge(bestId, bestPt)
    return vAdd(p)
  }

  const addPolyline = (points: Pt[], roadId: string | null, closed: boolean): void => {
    const n = points.length
    const steps = closed ? n : n - 1
    for (let i = 0; i < steps; i++) addEdge(weld(points[i]), weld(points[(i + 1) % n]), roadId)
  }

  for (const ring of boundaries) addPolyline(ring, null, true)
  for (const road of [...roads].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)))
    addPolyline(road.points, road.id, false)

  // --- intersection pass over the welded snapshot: gather every crossing, then
  // cut each edge once at all of its crossings (sorted along its length) ---
  const snapshot = [...edges.entries()]
  const grid = new Map<string, number[]>()
  snapshot.forEach(([, e], i) => {
    for (const [cx, cy] of bboxCells(vertices[e.a], vertices[e.b])) {
      const k = cellKey(cx, cy)
      let arr = grid.get(k)
      if (!arr) { arr = []; grid.set(k, arr) }
      arr.push(i)
    }
  })

  const cuts: Array<Array<{ t: number; pt: Pt }>> = snapshot.map(() => [])
  const tested = new Set<string>()
  for (const key of [...grid.keys()].sort()) {
    const ids = grid.get(key)!
    for (let x = 0; x < ids.length; x++) {
      for (let y = x + 1; y < ids.length; y++) {
        const i = ids[x]
        const j = ids[y]
        const pk = i < j ? `${i},${j}` : `${j},${i}`
        if (tested.has(pk)) continue
        tested.add(pk)
        const ei = snapshot[i][1]
        const ej = snapshot[j][1]
        if (ei.a === ej.a || ei.a === ej.b || ei.b === ej.a || ei.b === ej.b) continue
        const hit = segIntersect(vertices[ei.a], vertices[ei.b], vertices[ej.a], vertices[ej.b])
        if (!hit) continue
        cuts[i].push({ t: hit.t, pt: hit.pt })
        cuts[j].push({ t: hit.u, pt: hit.pt })
      }
    }
  }

  const wNear = (p: Pt): number => {
    const hit = vNear(p)
    return hit >= 0 ? hit : vAdd(p)
  }

  for (let i = 0; i < snapshot.length; i++) {
    if (cuts[i].length === 0) continue
    const [id, e] = snapshot[i]
    removeEdge(id)
    const chain = cuts[i].slice().sort((p, q) => p.t - q.t).map((c) => wNear(c.pt))
    const seq = [e.a, ...chain, e.b]
    for (let k = 0; k < seq.length - 1; k++) addEdge(seq[k], seq[k + 1], e.roadId)
  }

  const finalEdges = [...edges.values()].sort((p, q) => p.a - q.a || p.b - q.b)
  return { vertices, edges: finalEdges }
}

/** iteratively drops degree-1 vertices (cul-de-sacs do not split faces) */
export function pruneDanglers(g: PlanarGraph): PlanarGraph {
  const n = g.vertices.length
  const incident: number[][] = Array.from({ length: n }, () => [])
  g.edges.forEach((e, i) => { incident[e.a].push(i); incident[e.b].push(i) })
  const degree = incident.map((l) => l.length)
  const removed = new Array(g.edges.length).fill(false)
  const queue: number[] = []
  for (let v = 0; v < n; v++) if (degree[v] === 1) queue.push(v)
  while (queue.length > 0) {
    const v = queue.pop()!
    if (degree[v] !== 1) continue
    const ei = incident[v].find((i) => !removed[i])
    if (ei === undefined) continue
    removed[ei] = true
    const e = g.edges[ei]
    const other = e.a === v ? e.b : e.a
    degree[v] -= 1
    degree[other] -= 1
    if (degree[other] === 1) queue.push(other)
  }
  return { vertices: g.vertices, edges: g.edges.filter((_, i) => !removed[i]) }
}

/**
 * Half-edge walk: at each vertex, outgoing edges are sorted by angle and a
 * directed edge (u,v) continues into the next edge clockwise around v. This
 * partitions every directed edge into exactly one ring per face, including the
 * unbounded outer face. The outer face — recognizable as the ring with the
 * largest absolute area, oriented opposite the inner faces — is dropped; every
 * other ring is returned counter-clockwise (ringArea > 0).
 */
export function facesOf(g: PlanarGraph): Pt[][] {
  const n = g.vertices.length
  const neighborSet: Array<Set<number>> = Array.from({ length: n }, () => new Set())
  for (const e of g.edges) {
    if (e.a === e.b) continue
    neighborSet[e.a].add(e.b)
    neighborSet[e.b].add(e.a)
  }
  const sortedAdj: number[][] = neighborSet.map((set, v) => {
    const p = g.vertices[v]
    return [...set].sort((i, j) => {
      const ai = Math.atan2(g.vertices[i].y - p.y, g.vertices[i].x - p.x)
      const aj = Math.atan2(g.vertices[j].y - p.y, g.vertices[j].x - p.x)
      return ai - aj
    })
  })
  const indexIn: Array<Map<number, number>> = sortedAdj.map((list) => new Map(list.map((w, i) => [w, i])))

  const visited = new Set<string>()
  const rings: Pt[][] = []
  for (const e of g.edges) {
    if (e.a === e.b) continue
    for (const [u0, v0] of [[e.a, e.b], [e.b, e.a]] as const) {
      if (visited.has(`${u0},${v0}`)) continue
      const ringIdx: number[] = []
      let u = u0
      let v = v0
      let guard = g.edges.length * 2 + 4
      while (guard-- > 0) {
        visited.add(`${u},${v}`)
        ringIdx.push(u)
        const list = sortedAdj[v]
        const idx = indexIn[v].get(u)!
        const w = list[(idx - 1 + list.length) % list.length]
        u = v
        v = w
        if (u === u0 && v === v0) break
      }
      rings.push(ringIdx.map((i) => g.vertices[i]))
    }
  }
  if (rings.length === 0) return []

  let outerIdx = 0
  let outerArea = Math.abs(ringArea(rings[0]))
  for (let i = 1; i < rings.length; i++) {
    const a = Math.abs(ringArea(rings[i]))
    if (a > outerArea) { outerArea = a; outerIdx = i }
  }

  const out: Pt[][] = []
  for (let i = 0; i < rings.length; i++) {
    if (i === outerIdx) continue
    const ring = rings[i]
    out.push(ringArea(ring) > 0 ? ring : ring.slice().reverse())
  }
  return out
}

/** vertices with exactly four incident edges, all belonging to roads (not boundary pseudo-edges) */
export function degree4Vertices(g: PlanarGraph): Pt[] {
  const n = g.vertices.length
  const incident: Edge[][] = Array.from({ length: n }, () => [])
  for (const e of g.edges) {
    if (e.a === e.b) continue
    incident[e.a].push(e)
    incident[e.b].push(e)
  }
  const out: Pt[] = []
  for (let v = 0; v < n; v++) {
    const es = incident[v]
    if (es.length === 4 && es.every((e) => e.roadId !== null)) out.push(g.vertices[v])
  }
  return out
}

/** largest-by-area polygon in a clip result, its outer ring only (holes ignored) */
function largestRing(result: MultiPolygon): Pt[] | null {
  let best: Pt[] | null = null
  let bestArea = 0
  for (const poly of result) {
    const outer = poly[0]
    if (!outer) continue
    const pts = outer.map(([x, y]) => ({ x, y }))
    const area = Math.abs(ringArea(pts))
    if (area > bestArea) { bestArea = area; best = pts }
  }
  return best
}

/** face ∩ land; faces with no land dropped, a face split by water keeps only its largest piece */
export function clipFacesToLand(faces: Pt[][], terrain: Terrain): Array<{ poly: Pt[]; footprint: Pt[] }> {
  const out: Array<{ poly: Pt[]; footprint: Pt[] }> = []
  for (const poly of faces) {
    const ring = poly.map((p) => [p.x, p.y] as [number, number])
    let result: MultiPolygon
    try {
      result = polygonClipping.intersection([ring], terrain.land)
    } catch {
      continue
    }
    const footprint = largestRing(result)
    if (footprint) out.push({ poly, footprint })
  }
  return out
}

function ringPerimeter(ring: Pt[]): number {
  let p = 0
  for (let i = 0; i < ring.length; i++) p += dist(ring[i], ring[(i + 1) % ring.length])
  return p
}

function isSliver(ring: Pt[], minArea: number, minWidth: number): boolean {
  const area = Math.abs(ringArea(ring))
  const perim = ringPerimeter(ring)
  const width = perim > 0 ? (2 * area) / perim : 0
  return area < minArea || width < minWidth
}

const samePt = (a: Pt, b: Pt): boolean => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6

/** index of the face sharing the longest edge with faces[idx], or null */
function sharedEdgeNeighbor(faces: Pt[][], idx: number): number | null {
  const ringA = faces[idx]
  let best = -1
  let bestLen = 0
  for (let j = 0; j < faces.length; j++) {
    if (j === idx) continue
    const ringB = faces[j]
    for (let i = 0; i < ringA.length; i++) {
      const a1 = ringA[i]
      const b1 = ringA[(i + 1) % ringA.length]
      for (let k = 0; k < ringB.length; k++) {
        const a2 = ringB[k]
        const b2 = ringB[(k + 1) % ringB.length]
        const shares = (samePt(a1, a2) && samePt(b1, b2)) || (samePt(a1, b2) && samePt(b1, a2))
        if (!shares) continue
        const len = dist(a1, b1)
        if (len > bestLen) { bestLen = len; best = j }
      }
    }
  }
  return best >= 0 ? best : null
}

/**
 * Merges a face below minArea or minWidth (= 2×area/perimeter) into the
 * neighbour sharing its longest edge, repeating until no sliver remains or
 * none has a mergeable neighbour (kept as-is).
 */
export function mergeSlivers(faces: Pt[][], minArea = 2000, minWidth = 20): Pt[][] {
  let list = faces.slice()
  const giveUp = new Set<Pt[]>()
  let guard = list.length * 2 + 10
  while (guard-- > 0) {
    const idx = list.findIndex((f) => !giveUp.has(f) && isSliver(f, minArea, minWidth))
    if (idx < 0) break
    const nbIdx = sharedEdgeNeighbor(list, idx)
    if (nbIdx === null) { giveUp.add(list[idx]); continue }
    const ringA = list[idx].map((p) => [p.x, p.y] as [number, number])
    const ringB = list[nbIdx].map((p) => [p.x, p.y] as [number, number])
    let unionResult: MultiPolygon
    try {
      unionResult = polygonClipping.union([ringA], [ringB])
    } catch {
      giveUp.add(list[idx])
      continue
    }
    const merged = largestRing(unionResult)
    if (!merged) { giveUp.add(list[idx]); continue }
    list = list.filter((_, i) => i !== idx && i !== nbIdx)
    list.push(merged)
  }
  return list
}

export function windowRing(sizeM: number): Pt[] {
  return [{ x: 0, y: 0 }, { x: sizeM, y: 0 }, { x: sizeM, y: sizeM }, { x: 0, y: sizeM }]
}
