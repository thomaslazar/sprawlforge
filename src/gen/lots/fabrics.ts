import type { Pt } from '../geometry'
import { hashSeed, type Rng } from '../rng'
import type { BlockStyle, ZoneType } from '../types'
import type { DensityClass, SheetZone } from './shapes'

export function densityClass(d: number): DensityClass {
  return d < 0.35 ? 'sparse' : d < 0.65 ? 'dense' : 'packed'
}

/** R18 */
export function sheetZone(zone: ZoneType, dc: DensityClass): SheetZone {
  switch (zone) {
    case 'residential': return 'residential'
    case 'slum': return dc === 'sparse' ? 'fringe' : 'mixed'
    case 'entertainment': return dc === 'sparse' ? 'mixed' : 'commerce'
    case 'corp': return 'corp'
    default: return 'industrial' // industrial, docks
  }
}

/** R19, rows in draw order */
export const FABRIC_WEIGHTS: Record<string, Array<[BlockStyle, number]>> = {
  'residential sparse': [['detached', 50], ['villas', 20], ['rows', 30]],
  'residential dense': [['perimeter', 30], ['terrace', 25], ['rows', 25], ['zeilen', 15], ['tower-park', 5]],
  'residential packed': [['perimeter', 50], ['terrace', 20], ['zeilen', 15], ['tower-park', 10], ['podium', 5]],
  'mixed sparse': [['rows', 50], ['detached', 30], ['shophouse', 20]],
  'mixed dense': [['perimeter', 40], ['shophouse', 25], ['rows', 20], ['podium', 15]],
  commerce: [['perimeter', 30], ['shophouse', 20], ['podium', 25], ['plaza', 10], ['garage', 5], ['bigbox', 10]],
  corp: [['podium', 40], ['tower-park', 30], ['perimeter', 20], ['plaza', 10]],
  industrial: [['bigbox', 50], ['sheds', 35], ['rows', 15]],
  fringe: [['detached', 40], ['villas', 15], ['sheds', 25], ['rows', 20]],
}

/** R21 minimum fit box [w, d] of whole-block fabrics */
export const MIN_FIT: Partial<Record<BlockStyle, [number, number]>> = {
  zeilen: [40, 24], 'tower-park': [50, 50], podium: [40, 40], bigbox: [50, 40],
  sheds: [40, 30], plaza: [20, 20], garage: [66, 46],
}

/** R20: unsmoothed value of the 500 m lattice cell holding p, in [0, 1) */
export function fabricCell(seed: number, p: Pt): number {
  return hashSeed(seed, 'fabric', Math.floor(p.x / 500), Math.floor(p.y / 500)) / 2 ** 32
}

/** R20-R21. Draw order: next() picks cell-vs-fresh (>= 0.4 = cell), a second next() only when fresh. */
export function chooseFabric(zone: SheetZone, dc: DensityClass, cell: number, rng: Rng, fits: (f: BlockStyle) => boolean): BlockStyle {
  const key = zone === 'residential' || zone === 'mixed'
    ? `${zone} ${dc === 'sparse' ? 'sparse' : zone === 'mixed' ? 'dense' : dc}`
    : zone
  const row = FABRIC_WEIGHTS[key]
  const u = (rng.next() >= 0.4 ? cell : rng.next()) * 100
  let acc = 0
  let drawn = row.length - 1
  for (let i = 0; i < row.length; i++) { acc += row[i][1]; if (u < acc) { drawn = i; break } }
  const byWeight = [...row].sort((a, b) => b[1] - a[1]) // stable: ties keep row order
  for (let i = byWeight.findIndex(([f]) => f === row[drawn][0]); i < byWeight.length; i++) if (fits(byWeight[i][0])) return byWeight[i][0]
  return 'rows'
}
