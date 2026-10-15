import { describe, expect, it } from 'vitest'
import type { Pt } from '../geometry'
import type { Block, BlockStyle, District, Road, SectorParams } from '../types'
import { buildable } from './setback'
import { dryTerrain, pairOverlapMax, rectPoly, circleRing, distToRing } from './fixtures'
import { ringArea, pointInRings } from '../geometry'
import { difference, intersection } from '../clip'
import { fillLots } from './index'

const base: SectorParams = {
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5, irregularity: 0.5,
  landform: 'inland', river: false, lakes: false, islands: false, piers: false, arcology: false, megablock: false, pack: 'generic', theme: 'neon',
}
const resDistrict: District = {
  id: 'D04', zone: 'residential', name: '', bounds: { x: 0, y: 0, w: 400, h: 400 },
  poly: rectPoly(0, 0, 400, 400), shore: false, irregularity: 0.5, labelAt: { x: 200, y: 200 }, flags: {},
}
const bigBlock = (id: string, x = 500, y = 500): Block => ({ id, districtId: 'D04', poly: rectPoly(x, y, 200, 200), footprint: rectPoly(x, y, 200, 200), style: 'rows', alleys: [], flags: {} })
const street = (x0: number, y0: number, x1: number, y1: number): Road => ({ id: `S${x0}`, class: 'street', points: [{ x: x0, y: y0 }, { x: x1, y: y1 }], width: 9, name: null })
const FABRICS: BlockStyle[] = ['perimeter', 'terrace', 'shophouse', 'rows', 'zeilen', 'detached', 'villas', 'tower-park', 'podium', 'bigbox', 'sheds', 'plaza', 'garage']

describe('fillLots', () => {
  it('every building has a lot and every lot its block', () => {
    const out = fillLots([resDistrict], [bigBlock('D04')], base, dryTerrain, [street(0, 500, 900, 500)])
    const ids = new Set(out.lots.map((l) => l.id))
    expect(out.buildings.length).toBeGreaterThan(0)
    for (const b of out.buildings) { expect(ids.has(b.lotId)).toBe(true); expect(out.lots.find((l) => l.id === b.lotId)!.buildingIds).toContain(b.id) }
    for (const l of out.lots) expect(l.blockId).toBe('D04')
    expect(out.lots[0].id).toBe('LOT00001'); expect(out.buildings[0].id).toBe('BLD0001')
    expect(out.buildings.every((b) => b.shape.length > 0)).toBe(true)
  })
  it('forceStyle drives every fabric through the pass', () => {
    for (const f of FABRICS) expect(fillLots([resDistrict], [bigBlock('D04')], base, dryTerrain, [], undefined, undefined, [], [], f).blocks[0].style).toBe(f)
  })
  it('alleys only on megablocks', () => {
    const out = fillLots([resDistrict], [bigBlock('D04'), bigBlock('D05', 900, 500)].map((b, i) => ({ ...b, id: `B${i}` })), base, dryTerrain, [])
    for (const b of out.blocks) expect(b.alleys).toEqual([])
    const mega = { id: 'M01', name: '', center: { x: 600, y: 600 } as Pt, core: [], footprint: [] }
    const m = fillLots([resDistrict], [bigBlock('B0')], base, dryTerrain, [], { arcologies: [], megablocks: [mega] })
    expect(m.blocks[0].style).toBe('megablock')
    expect(m.megablockCores.get('M01')!.length).toBeGreaterThanOrEqual(3)
  })
  it('is deterministic', () => {
    const run = () => fillLots([resDistrict], [bigBlock('D04')], base, dryTerrain, [street(0, 500, 900, 500)])
    expect(run()).toEqual(run())
  })
  it('a non-ring arcology plaza is a hole the lots face', () => {
    const block: Block = { ...bigBlock('B0', 100, 100), poly: rectPoly(100, 100, 300, 300), footprint: rectPoly(100, 100, 300, 300) }
    const plaza = circleRing({ x: 250, y: 250 }, 30, 8)
    const arc = { id: 'A01', name: '', design: 'rings', angle: 0, center: { x: 250, y: 250 }, radius: 20, footprint: [], plaza, ringRoadId: '', access: 'boulevard', detail: { count: 0, twist: 0 } } as never
    const sts = [street(100, 100, 400, 100), street(400, 100, 400, 400), street(400, 400, 100, 400), street(100, 400, 100, 100)]
    const out = fillLots([resDistrict], [block], base, dryTerrain, sts, { arcologies: [arc], megablocks: [] })
    expect(out.buildings.length).toBeGreaterThan(0)
    for (const b of out.buildings) for (const p of b.footprint) expect(distToRing(p, plaza) >= 5.5 || !pointInRings(p, [plaza]) ? 1 : 0).toBe(1)
    for (const b of out.buildings) for (const p of b.footprint) expect(pointInRings(p, [plaza])).toBe(false)
    const polys = out.lots.map((l) => l.poly)
    const over = (r: Pt[]) => intersection([r.map((p) => [p.x, p.y] as [number, number])], [plaza.map((p) => [p.x, p.y] as [number, number])]).reduce((t, pg) => t + Math.abs(ringArea(pg[0].slice(0, -1).map(([x, y]) => ({ x, y })))), 0)
    for (const r of [...polys, ...out.buildings.map((b) => b.footprint)]) expect(over(r)).toBeLessThanOrEqual(0.5)
    expect(out.lots.some((l) => l.poly.some((p) => distToRing(p, plaza) < 7))).toBe(true)
    for (const [x, y] of [[250, 110], [250, 390], [110, 250], [390, 250]]) expect(out.lots.some((l) => pointInRings({ x, y }, [l.poly]) || l.poly.some((p) => Math.hypot(p.x - x, p.y - y) < 40))).toBe(true)
    expect(pairOverlapMax(polys)).toBeLessThanOrEqual(0.5)
    const area = (g: [number, number][][][]) => g.reduce((t, pg) => t + Math.abs(ringArea(pg[0].slice(0, -1).map(([x, y]) => ({ x, y })))), 0)
    const ring = (r: Pt[]) => r.map((p) => [p.x, p.y] as [number, number])
    const free = difference([ring(buildable(block.footprint, [7.5, 7.5, 7.5, 7.5])[0])], [ring(plaza)])
    const covered = intersection(free, ...[]) && area(polys.flatMap((p) => intersection(free, [ring(p)])))
    expect(covered / area(free)).toBeGreaterThanOrEqual(0.9)
  })
})
