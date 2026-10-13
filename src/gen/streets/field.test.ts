import { describe, expect, it } from 'vitest'
import type { Pt } from '../geometry'
import { sampleTerrain } from '../terrain'
import { effectiveIrregularity } from '../sector/zoning'
import type { SectorParams } from '../types'
import { PLAN_CELL, buildPatches, buildRoadField, radialBasis, shoreTangent } from './field'

const params = (over: Partial<SectorParams> = {}): SectorParams => ({
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5, irregularity: 0.5,
  landform: 'coastal', river: true, lakes: false, islands: false, piers: false, arcology: false, megablock: false, pack: 'generic', theme: 'neon', ...over,
})
const lineAngleDiff = (a: number, b: number) => {
  const d = Math.abs(a - b) % Math.PI
  return Math.min(d, Math.PI - d)
}

describe('streets/field', () => {
  it('is deterministic', () => {
    const p = params()
    const sizeM = p.size * 1000
    const terrain = sampleTerrain(p, sizeM)
    const f1 = buildRoadField(p, terrain, sizeM)
    const f2 = buildRoadField(p, terrain, sizeM)
    expect(f2.patches).toEqual(f1.patches)
    for (let y = 0; y <= sizeM; y += 200) {
      for (let x = 0; x <= sizeM; x += 200) {
        const s1 = f1.sample({ x, y })
        const s2 = f2.sample({ x, y })
        expect(s2.major.x).toBeCloseTo(s1.major.x, 6)
        expect(s2.major.y).toBeCloseTo(s1.major.y, 6)
      }
    }
  })

  it('planned patches in one plan cell share an angle; organic patches do not', () => {
    const byCell = (p: SectorParams) => {
      const cells = new Map<string, Array<{ angle: number; irr: number }>>()
      const irr = effectiveIrregularity(p)
      for (const c of buildPatches(p, sampleTerrain(p, p.size * 1000), p.size * 1000)) {
        const k = `${Math.floor(c.center.x / PLAN_CELL)},${Math.floor(c.center.y / PLAN_CELL)}`
        cells.set(k, [...(cells.get(k) ?? []), { angle: c.angle, irr: irr(c.center) }])
      }
      return [...cells.values()]
    }
    const planned = byCell(params({ landform: 'inland', river: false, irregularity: 0.15 }))
    expect(planned.length).toBeGreaterThanOrEqual(2)
    expect(planned.some((cell) => cell.filter((c) => c.irr < 0.4).length >= 2)).toBe(true)
    for (const cell of planned) {
      const a = cell.filter((c) => c.irr < 0.4)
      for (const c of a) expect(c.angle).toBeCloseTo(a[0].angle, 6)
    }
    const organic = byCell(params({ landform: 'inland', river: false, irregularity: 0.85 }))
    expect(organic.some((cell) => cell.some((c) => Math.abs(c.angle - cell[0].angle) > 1e-6))).toBe(true)
  })

  it('patch size follows irregularity', () => {
    const lo = params({ irregularity: 0.15 })
    const hi = params({ irregularity: 0.85 })
    const sizeM = lo.size * 1000
    const loPatches = buildPatches(lo, sampleTerrain(lo, sizeM), sizeM)
    const hiPatches = buildPatches(hi, sampleTerrain(hi, sizeM), sizeM)
    for (const patch of [...loPatches, ...hiPatches]) {
      expect(patch.size).toBeGreaterThanOrEqual(400)
      expect(patch.size).toBeLessThanOrEqual(900)
    }
    const mean = (ps: typeof loPatches) => ps.reduce((s, patch) => s + patch.size, 0) / ps.length
    expect(mean(loPatches) - mean(hiPatches)).toBeGreaterThanOrEqual(200)
  })

  it('shore patches take the shore tangent', () => {
    const p = params()
    const sizeM = p.size * 1000
    const terrain = sampleTerrain(p, sizeM)
    const patches = buildPatches(p, terrain, sizeM)
    const shorePatches = patches.filter((patch) => patch.shore)
    expect(shorePatches.length).toBeGreaterThan(0)
    for (const patch of shorePatches) {
      const tangent = shoreTangent(terrain, patch.center)
      expect(tangent).not.toBeNull()
      expect(lineAngleDiff(patch.angle, tangent!.angle)).toBeLessThan((5 * Math.PI) / 180)
    }
  })

  it('inland sector has no NaN angles', () => {
    const p = params({ landform: 'inland', river: false })
    const sizeM = p.size * 1000
    const terrain = sampleTerrain(p, sizeM)
    const field = buildRoadField(p, terrain, sizeM)
    for (let y = 0; y <= sizeM; y += 100) {
      for (let x = 0; x <= sizeM; x += 100) {
        const { major } = field.sample({ x, y })
        expect(Number.isFinite(major.x)).toBe(true)
        expect(Number.isFinite(major.y)).toBe(true)
        expect(Math.hypot(major.x, major.y)).toBeCloseTo(1, 5)
      }
    }
  })

  it('seams are continuous away from water', () => {
    const p = params()
    const sizeM = p.size * 1000
    const terrain = sampleTerrain(p, sizeM)
    const field = buildRoadField(p, terrain, sizeM)
    const step = 20
    const cols = sizeM / step + 1
    const angle = new Float64Array(cols * cols)
    const far = new Uint8Array(cols * cols)
    for (let iy = 0; iy < cols; iy++) {
      for (let ix = 0; ix < cols; ix++) {
        const pt: Pt = { x: ix * step, y: iy * step }
        const idx = iy * cols + ix
        angle[idx] = Math.atan2(field.sample(pt).major.y, field.sample(pt).major.x)
        far[idx] = (shoreTangent(terrain, pt)?.dist ?? Infinity) > 250 ? 1 : 0
      }
    }
    let total = 0
    let bad = 0
    for (let iy = 0; iy < cols; iy++) {
      for (let ix = 0; ix < cols; ix++) {
        const idx = iy * cols + ix
        if (!far[idx]) continue
        if (ix + 1 < cols && far[idx + 1]) {
          total++
          if (lineAngleDiff(angle[idx], angle[idx + 1]) > (30 * Math.PI) / 180) bad++
        }
        if (iy + 1 < cols && far[idx + cols]) {
          total++
          if (lineAngleDiff(angle[idx], angle[idx + cols]) > (30 * Math.PI) / 180) bad++
        }
      }
    }
    // A line field over a bounded region generically has singularities
    // (index ±1/2 points, Poincaré-Hopf) wherever two near-orthogonal
    // patches meet at equal distance — a handful of sharp local jumps
    // there is mathematically unavoidable, not a bug. Assert the seam is
    // smooth almost everywhere instead of literally everywhere.
    expect(bad / total).toBeLessThan(0.02)
  }, 20000)

  it('minor is perpendicular to major', () => {
    const p = params()
    const sizeM = p.size * 1000
    const terrain = sampleTerrain(p, sizeM)
    const field = buildRoadField(p, terrain, sizeM)
    for (let y = 0; y <= sizeM; y += 300) {
      for (let x = 0; x <= sizeM; x += 300) {
        const { major, minor } = field.sample({ x, y })
        expect(major.x * minor.x + major.y * minor.y).toBeCloseTo(0, 5)
      }
    }
  })
})

describe('radialBasis', () => {
  it('radial basis points at the centre', () => {
    const c = { x: 1000, y: 1000 }
    const b = radialBasis(c, 100, 500)
    expect(b.name).toBe('radial')
    expect(lineAngleDiff(b.angle({ x: c.x + 300, y: c.y })!, 0)).toBeLessThan(1e-9)
    expect(lineAngleDiff(b.angle({ x: c.x, y: c.y + 300 })!, Math.PI / 2)).toBeLessThan(1e-9)
    expect(b.weight({ x: c.x + 50, y: c.y })).toBe(0)
    expect(b.weight({ x: c.x + 100, y: c.y })).toBeCloseTo(1.5)
    expect(b.weight({ x: c.x + 300, y: c.y })).toBeCloseTo(0.75)
    expect(b.weight({ x: c.x + 600, y: c.y })).toBe(0)
  })
})
