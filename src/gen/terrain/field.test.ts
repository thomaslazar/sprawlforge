import { describe, expect, it } from 'vitest'
import type { Landform } from '../types'
import {
  ISLET_MOAT_OUTER_FACTOR,
  ISLET_RADIUS_MAX,
  METRO_SIZE,
  applyIslands,
  makeFieldBase,
  sectorWindow,
} from './field'

const sizeM = 4000
const DRY = { river: false, lakes: false, islands: false }
const grid = (h: (x: number, y: number) => number, win: ReturnType<typeof sectorWindow>, n = 32) => {
  const vals: number[] = []
  for (let j = 0; j <= n; j++)
    for (let i = 0; i <= n; i++)
      vals.push(h(win.x + (i / n) * win.w, win.y + (j / n) * win.h))
  return vals
}
const waterFrac = (vals: number[]) => vals.filter((v) => v < 0).length / vals.length
// 'inland' never offsets the window (see sectorWindow) — a stand-in for any
// landform whose window is metro-centered, used where a test doesn't care
// about landform-specific placement.
const centered = (seed: number) => sectorWindow(sizeM, 'inland', seed)

describe('makeFieldBase', () => {
  it('is deterministic', () => {
    const a = makeFieldBase(42, 'coastal', DRY)
    const b = makeFieldBase(42, 'coastal', DRY)
    expect(a.heightRaw(15000, 17000)).toBe(b.heightRaw(15000, 17000))
  })
  it('window is centered in the metro for landforms with no waterline to chase', () => {
    for (const landform of ['inland'] as const) {
      const win = sectorWindow(sizeM, landform, 42)
      expect(win.x + win.w / 2).toBe(METRO_SIZE / 2)
    }
  })
  it('coastal clears a water floor at small sizeM, where a centered window would be all-land (C3)', () => {
    for (const landform of ['coastal'] as Landform[]) {
      for (const seed of [1, 42, 999]) {
        const win = sectorWindow(2000, landform, seed)
        const frac = waterFrac(grid(makeFieldBase(seed, landform, DRY).heightRaw, win, 48))
        expect(frac).toBeGreaterThan(0.01)
      }
    }
  })
  it('field is window-independent: same metro point, same height', () => {
    const f = makeFieldBase(42, 'coastal', DRY)
    const g = makeFieldBase(42, 'coastal', DRY)
    expect(f.heightRaw(15500, 16500)).toBe(g.heightRaw(15500, 16500))
  })
  it('inland: window is all land, no sea, no river', () => {
    const f = makeFieldBase(42, 'inland', DRY)
    expect(waterFrac(grid(f.heightRaw, centered(42)))).toBe(0)
    expect(f.hasSea).toBe(false)
    expect(f.hasRiver).toBe(false)
  })
  it('inland + river: dry window before carving, river flagged', () => {
    const f = makeFieldBase(42, 'inland', { river: true, lakes: false })
    expect(waterFrac(grid(f.heightRaw, centered(42)))).toBe(0)
    expect(f.hasRiver).toBe(true)
    expect(f.hasSea).toBe(false)
  })
  it('coastal: window has both land and sea', () => {
    for (const seed of [1, 42, 999]) {
      const f = makeFieldBase(seed, 'coastal', DRY)
      const win = sectorWindow(sizeM, 'coastal', seed)
      const frac = waterFrac(grid(f.heightRaw, win))
      expect(frac).toBeGreaterThan(0.1)
      expect(frac).toBeLessThan(0.6)
      expect(f.hasSea).toBe(true)
    }
  })
  it('bay: water pocket, mostly land', () => {
    for (const seed of [1, 42, 999]) {
      const win = sectorWindow(sizeM, 'bay', seed)
      const frac = waterFrac(grid(makeFieldBase(seed, 'bay', DRY).heightRaw, win))
      expect(frac).toBeGreaterThan(0.05)
      expect(frac).toBeLessThan(0.5)
    }
  })
  it('inland + lakes: some water, far less than coastal, no sea', () => {
    for (const seed of [1, 42, 999]) {
      const f = makeFieldBase(seed, 'inland', { river: false, lakes: true })
      const win = sectorWindow(sizeM, 'inland', seed)
      const frac = waterFrac(grid(f.heightRaw, win, 64))
      expect(frac).toBeGreaterThan(0.01)
      expect(frac).toBeLessThan(0.3)
      expect(f.hasSea).toBe(false)
    }
  })
  it('coastal + river: sea and river both flagged (the estuary case)', () => {
    const f = makeFieldBase(42, 'coastal', { river: true, lakes: false })
    expect(f.hasSea).toBe(true)
    expect(f.hasRiver).toBe(true)
  })
  it('lakes modifier composes with any landform: coastal + lakes still has sea', () => {
    const f = makeFieldBase(42, 'coastal', { river: false, lakes: true })
    expect(f.hasSea).toBe(true)
  })
})

describe('applyIslands', () => {
  it('no-op when the window has no wet candidates (e.g. inland without lakes)', () => {
    const f = makeFieldBase(42, 'inland', DRY)
    const win = centered(42)
    const withIslands = applyIslands(f.heightRaw, 42, win)
    for (const seed of [1, 42, 999]) {
      const p = { x: win.x + win.w * 0.3, y: win.y + win.h * 0.7 }
      expect(withIslands(p.x + seed, p.y)).toBe(f.heightRaw(p.x + seed, p.y))
    }
  })
  it('breaches 0 at the islet center when the window has wet candidates (coastal)', () => {
    for (const seed of [1, 42, 999]) {
      const win = sectorWindow(sizeM, 'coastal', seed)
      const base = makeFieldBase(seed, 'coastal', DRY)
      const withIslands = applyIslands(base.heightRaw, seed, win)
      // sample the window and confirm at least one point that was wet under
      // the base field now reads dry (>= 0) under the islands modifier —
      // proof a bump actually breached, not just proof the function ran
      const n = 80 // grid spacing ~50m, well under the ~150-300m islet radius
      let breached = false
      for (let i = 0; i <= n && !breached; i++) {
        for (let j = 0; j <= n && !breached; j++) {
          const x = win.x + (i / n) * win.w
          const y = win.y + (j / n) * win.h
          if (base.heightRaw(x, y) < -0.08 && withIslands(x, y) >= 0) breached = true
        }
      }
      expect(breached, `seed ${seed}`).toBe(true)
    }
  })
  it('carves a moat: a full ring around the islet core is guaranteed wet even when the terrain just outside the core is dry (river-channel-like)', () => {
    // synthetic field: a narrow wet "channel" through an otherwise dry
    // window, narrower than the ~150-300m islet radius — the exact geometry
    // that used to let an islet dam a river (a real river is ~60-120m wide)
    const win = { x: 0, y: 0, w: 1200, h: 1200 }
    const channelHalfWidth = 100
    const cx = win.x + win.w / 2
    const height = (x: number) => (Math.abs(x - cx) < channelHalfWidth ? -0.5 : 0.5)

    const withIslands = applyIslands(height, 42, win)

    // find the islet's core: the highest point in the window
    const n = 240 // grid spacing 5m
    let peak = { x: cx, y: win.h / 2 }
    let peakH = -Infinity
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const x = win.x + (i / n) * win.w
        const y = win.y + (j / n) * win.h
        const h = withIslands(x, y)
        if (h > peakH) {
          peakH = h
          peak = { x, y }
        }
      }
    }
    expect(peakH, 'islet core reads as land').toBeGreaterThanOrEqual(0)

    // sweep outward from the peak for the smallest radius at which a full
    // ring of samples all reads wet — the guaranteed moat ring. Bounded by
    // the widest an islet's moat could possibly reach, so a false positive
    // (wandering into an unrelated dry/wet seam) can't pass silently.
    const maxPossibleMoatR = ISLET_RADIUS_MAX * ISLET_MOAT_OUTER_FACTOR
    const angles = 32
    let ringFound = -1
    for (let r = 10; r <= maxPossibleMoatR + 50 && ringFound < 0; r += 5) {
      let allWet = true
      for (let a = 0; a < angles; a++) {
        const theta = (a / angles) * Math.PI * 2
        const x = peak.x + Math.cos(theta) * r
        const y = peak.y + Math.sin(theta) * r
        if (withIslands(x, y) >= 0) {
          allWet = false
          break
        }
      }
      if (allWet) ringFound = r
    }
    expect(ringFound, 'a full wet ring exists around the islet core').toBeGreaterThan(0)
  })

  it('clamps islet radius to local water width: a narrow river-like channel gets a modest bulge, not a 6-10x-wide disc', () => {
    // same synthetic channel shape as the moat test above, but width 80m —
    // squarely in the "real river" 60-120m range the bug report names.
    // Outside the channel the field is plain dry land (no other wet
    // features), so the wet/dry transition found below IS the moat's outer
    // edge — unlike the wide-water case, where "outside the moat" is still
    // wet on its own and the transition can't be observed this way.
    const win = { x: 0, y: 0, w: 1200, h: 1200 }
    const channelHalfWidth = 40
    const channelWidth = channelHalfWidth * 2
    const cx = win.x + win.w / 2
    const height = (x: number) => (Math.abs(x - cx) < channelHalfWidth ? -0.5 : 0.5)

    const withIslands = applyIslands(height, 42, win)

    // find the islet's core (same grid-search as the moat test)
    const n = 240
    let peak = { x: cx, y: win.h / 2 }
    let peakH = -Infinity
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const x = win.x + (i / n) * win.w
        const y = win.y + (j / n) * win.h
        const h = withIslands(x, y)
        if (h > peakH) {
          peakH = h
          peak = { x, y }
        }
      }
    }
    expect(peakH, 'islet still forms in an 80m channel').toBeGreaterThanOrEqual(0)

    // walk outward along x from the peak (perpendicular to the channel,
    // where the ambient field is dry, so any wet sample out here can only
    // be the moat forcing it) and record the farthest offset that's still
    // wet — the moat's outer edge, since past it the field reverts to the
    // dry ambient and (moving straight away from cx) never re-enters water
    let moatOuterX = 0
    for (let dx = 0; dx <= 500; dx += 2) {
      if (withIslands(peak.x + dx, peak.y) < 0) moatOuterX = dx
    }
    const bulgeDiameter = moatOuterX * 2
    expect(bulgeDiameter, 'moat bulge stays within ~2.5x the channel width, not 6-10x it').toBeLessThanOrEqual(
      channelWidth * 2.5,
    )
  })

  it('does not clamp islet radius in wide open water: core lands in the original 150-300m-derived range', () => {
    // synthetic "sea": wet everywhere, comfortably larger than the probe's
    // max walk in every direction, so probeLocalWaterWidth reads it as wide
    // open water and the radius cap never binds — radius should roll
    // exactly as it did before this fix (ISLET_RADIUS_MIN-MAX)
    const win = { x: 0, y: 0, w: 3000, h: 3000 }
    const height = () => -0.5

    const withIslands = applyIslands(height, 42, win)

    // find the islet core
    const n = 200
    let peak = { x: win.w / 2, y: win.h / 2 }
    let peakH = -Infinity
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const x = win.x + (i / n) * win.w
        const y = win.y + (j / n) * win.h
        const h = withIslands(x, y)
        if (h > peakH) {
          peakH = h
          peak = { x, y }
        }
      }
    }
    expect(peakH, 'islet breaches in open water').toBeGreaterThanOrEqual(0)

    // ambient water is already wet (-0.5) everywhere here, so — unlike the
    // narrow-channel test — the moat's forced ring is invisible (min(h,
    // ceiling) never binds when ambient is already wetter than the moat
    // depth). The only observable signal is where the CORE BUMP's smooth
    // falloff crosses back below zero into that wet ambient. That crossing
    // is a fixed fraction of coreR (it solves t²(3-2t) = 0.5/bump for the
    // falloff's shape function, independent of radius) — small for a
    // radius near ISLET_RADIUS_FLOOR (30 → coreR 15 → crossing ~4-5m) and
    // meaningfully bigger for the unclamped range (radius 150-300 → coreR
    // 75-150 → crossing ~13-53m, ±shoreline wobble). [8, 60] cleanly
    // separates "unclamped" from "clamped to the floor" without pinning an
    // exact value that shoreline noise would make flaky.
    let landR = 0
    for (let dx = 0; dx <= 400; dx += 1) {
      if (withIslands(peak.x + dx, peak.y) >= 0) landR = dx
      else break
    }
    expect(landR, 'core radius consistent with unclamped 150-300m islet, not a floor-clamped one').toBeGreaterThan(8)
    expect(landR, 'core radius within the unclamped range, not runaway').toBeLessThan(60)
  })
})
