import { describe, expect, it } from 'vitest'
import type { Pt } from '../geometry'
import type { Block, BlockStyle, District, Road, SectorParams } from '../types'
import { dryTerrain, rectPoly } from './fixtures'
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
})
