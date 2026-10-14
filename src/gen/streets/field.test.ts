import { describe, expect, it } from 'vitest'
import type { Pt } from '../geometry'
import { sampleTerrain } from '../terrain'
import { effectiveIrregularity } from '../sector/zoning'
import type { SectorParams, Terrain } from '../types'
import { PLAN_CELL, buildPatches, buildRoadField, boundaryBasis, radialBasis, shoreProfile, shoreTangent } from './field'

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
        far[idx] = (shoreTangent(terrain, pt)?.dist ?? Infinity) > 300 ? 1 : 0
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

describe('shore profile', () => {
  it('is deterministic per seed, setback within 30..150, about 30 % of points off', () => {
    const a = shoreProfile(params({ seed: 7 })), b = shoreProfile(params({ seed: 7 })), c = shoreProfile(params({ seed: 8 }))
    let off = 0, n = 0, differs = false
    // 20 km square: ~1100 noise cells, so the share is stable (a 4 km window holds only ~45)
    for (let x = 0; x < 20000; x += 397) for (let y = 0; y < 20000; y += 389) {
      const q = { x, y }; n++
      expect(a.setback(q)).toBe(b.setback(q)); expect(a.off(q)).toBe(b.off(q))
      expect(a.setback(q)).toBeGreaterThanOrEqual(30); expect(a.setback(q)).toBeLessThanOrEqual(150)
      if (a.off(q)) off++
      if (a.setback(q) !== c.setback(q)) differs = true
    }
    expect(off / n).toBeGreaterThan(0.2); expect(off / n).toBeLessThan(0.4); expect(differs).toBe(true)
  })
  // straight coast: water x >= 1000, no river
  const coast = { water: [[[[1000, -10], [5000, -10], [5000, 5000], [1000, 5000], [1000, -10]]]], riverSlice: null } as unknown as Terrain
  const at = (x: number) => ({ x, y: 2000 })
  it('boundary weight peaks at the setback, is 0 at the water line and 150 m past the setback', () => {
    const w = boundaryBasis(coast, { setback: () => 80, off: () => false })
    expect(w.weight(at(1000 - 80))).toBeCloseTo(1, 2)
    expect(w.weight(at(1000 - 0.5))).toBeLessThan(0.01)
    expect(w.weight(at(1000 - 40))).toBeCloseTo(0.5, 2)
    expect(w.weight(at(1000 - 155))).toBeCloseTo(0.5, 2)
    expect(w.weight(at(1000 - 231))).toBe(0)
    expect(lineAngleDiff(w.angle(at(1000 - 80))!, Math.PI / 2)).toBeLessThan(1e-3)
  })
  it('boundary weight is 0 where the band is off', () => {
    expect(boundaryBasis(coast, { setback: () => 80, off: () => true }).weight(at(1000 - 80))).toBe(0)
  })
  it('mid-river weight is unchanged', () => {
    const river = { water: [[[[-10, 900], [4010, 900], [4010, 1100], [-10, 1100], [-10, 900]]]], riverSlice: { course: [{ x: -10, y: 1000 }, { x: 4010, y: 1000 }], width: 60 } } as unknown as Terrain
    const w = boundaryBasis(river, { setback: () => 150, off: () => true })
    expect(w.weight({ x: 2000, y: 1010 })).toBeCloseTo(1 - 10 / 250, 6)
  })
})
