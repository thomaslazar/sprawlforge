import { describe, expect, it } from 'vitest'
import type { Landform } from '../types'
import { METRO_SIZE, makeFieldBase, sectorWindow } from './field'

const sizeM = 4000
const DRY = { river: false, lakes: false }
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
  it('coastal/island clear a water floor at small sizeM, where a centered window would be all-land (C3)', () => {
    for (const landform of ['coastal', 'island'] as Landform[]) {
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
  it('island: land inside, water at the window corners', () => {
    for (const seed of [1, 42, 999]) {
      const f = makeFieldBase(seed, 'island', DRY)
      const win = sectorWindow(sizeM, 'island', seed)
      expect(f.heightRaw(METRO_SIZE / 2, METRO_SIZE / 2)).toBeGreaterThan(0)
      expect(f.heightRaw(win.x, win.y)).toBeLessThan(0)
      expect(f.heightRaw(win.x + win.w, win.y + win.h)).toBeLessThan(0)
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
  it('lakes modifier composes with any landform: island + lakes still has sea', () => {
    const f = makeFieldBase(42, 'island', { river: false, lakes: true })
    expect(f.hasSea).toBe(true)
  })
})
