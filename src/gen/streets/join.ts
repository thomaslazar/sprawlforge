import type { Pt } from '../geometry'

/** how far along the target road (fraction of separation) a join aims past the foot */
export const JOIN_AHEAD = 0.5
/** end pass: how far (fraction of separation) a dangling end may reach for a road to join */
export const JOIN_REACH = 1.5
/** end pass: widest angle from the end's heading to a join target */
export const JOIN_CONE = Math.PI / 2

/**
 * Quadratic Bezier from p, leaving along dir, ending exactly on target. The first sample is
 * excluded (p is already on the road); null when `reject` is true for any sample.
 */
export function joinCurve(p: Pt, dir: Pt, target: Pt, reject: (q: Pt) => boolean): Pt[] | null {
  const len = Math.hypot(target.x - p.x, target.y - p.y)
  const c = { x: p.x + dir.x * (len / 2), y: p.y + dir.y * (len / 2) }
  const n = Math.max(4, Math.ceil(len / 10))
  const out: Pt[] = []
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t
    const q = i === n ? { x: target.x, y: target.y }
      : { x: u * u * p.x + 2 * u * t * c.x + t * t * target.x, y: u * u * p.y + 2 * u * t * c.y + t * t * target.y }
    if (reject(q)) return null
    out.push(q)
  }
  return out
}
