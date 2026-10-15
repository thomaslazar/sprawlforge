import type { Pt } from '../geometry'
import { hashSeed, type Rng } from '../rng'
import type { BlockStyle, ZoneType } from '../types'
import type { DensityClass, SheetZone } from './shapes'

/** R20 cell coherence (user review: 0.6 -> 0.4, more variation between neighbouring blocks) */
export const COHERENCE = 0.4

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

/** R19, rows in draw order; user review 2026-10-15 cut podium and perimeter, the freed weight going to rows/terrace/shophouse */
export const FABRIC_WEIGHTS: Record<string, Array<[BlockStyle, number]>> = {
  'residential sparse': [['detached', 50], ['villas', 20], ['rows', 30]],
  'residential dense': [['perimeter', 15], ['terrace', 32], ['rows', 33], ['zeilen', 15], ['tower-park', 5]],
  'residential packed': [['perimeter', 30], ['terrace', 45], ['zeilen', 15], ['tower-park', 10]],
  'mixed sparse': [['rows', 50], ['detached', 30], ['shophouse', 20]],
  'mixed dense': [['perimeter', 15], ['shophouse', 40], ['rows', 30], ['podium', 5], ['blockfill', 10]],
  'mixed packed': [['perimeter', 10], ['shophouse', 40], ['rows', 20], ['podium', 5], ['blockfill', 25]],
  commerce: [['perimeter', 5], ['shophouse', 50], ['podium', 10], ['plaza', 10], ['garage', 5], ['bigbox', 10], ['blockfill', 10]],
  'commerce packed': [['shophouse', 40], ['podium', 10], ['plaza', 10], ['garage', 5], ['bigbox', 10], ['blockfill', 25]], // the row has 15 perimeter only: the other 10 from shophouse
  corp: [['podium', 15], ['tower-park', 20], ['plaza', 10], ['shophouse', 45], ['blockfill', 10]], // user review: the freed 45 to shophouse (no rows/terrace in the row); blockfill 10 from perimeter
  'corp packed': [['podium', 15], ['tower-park', 20], ['plaza', 10], ['shophouse', 30], ['blockfill', 25]], // blockfill 25: perimeter's 10 and 15 from shophouse
  industrial: [['bigbox', 50], ['sheds', 35], ['rows', 15]],
  fringe: [['detached', 40], ['villas', 15], ['sheds', 25], ['rows', 20]],
}

/** R21 minimum fit box [w, d] of whole-block fabrics */
export const MIN_FIT: Partial<Record<BlockStyle, [number, number]>> = {
  zeilen: [40, 24], 'tower-park': [50, 50], podium: [40, 40], bigbox: [50, 40],
  sheds: [40, 30], plaza: [20, 20], garage: [66, 46], blockfill: [30, 30],
}

/** R20: unsmoothed value of the 500 m lattice cell holding p, in [0, 1) */
export function fabricCell(seed: number, p: Pt): number {
  return hashSeed(seed, 'fabric', Math.floor(p.x / 500), Math.floor(p.y / 500)) / 2 ** 32
}

/** R20-R21. Draw order: next() picks cell-vs-fresh (< 0.4 = cell; 0.6 before the user review), a second next() only when fresh. */
/** the R19 row of a sheet zone and density class (blockfill split packed mixed, commerce and corp off their dense rows) */
export function fabricRow(zone: SheetZone, dc: DensityClass): string {
  if (zone === 'residential') return `residential ${dc}`
  if (zone === 'mixed') return `mixed ${dc}`
  return (zone === 'commerce' || zone === 'corp') && dc === 'packed' ? `${zone} packed` : zone
}

export function chooseFabric(zone: SheetZone, dc: DensityClass, cell: number, rng: Rng, fits: (f: BlockStyle) => boolean): BlockStyle {
  const row = FABRIC_WEIGHTS[fabricRow(zone, dc)]
  const u = (rng.next() < COHERENCE ? cell : rng.next()) * 100
  let acc = 0
  let drawn = row.length - 1
  for (let i = 0; i < row.length; i++) { acc += row[i][1]; if (u < acc) { drawn = i; break } }
  const byWeight = [...row].sort((a, b) => b[1] - a[1]) // stable: ties keep row order
  for (let i = byWeight.findIndex(([f]) => f === row[drawn][0]); i < byWeight.length; i++) if (fits(byWeight[i][0])) return byWeight[i][0]
  return 'rows'
}
