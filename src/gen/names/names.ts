import type { Rng } from '../rng'
import type { ZoneType } from '../types'

export interface PoiTypeDef {
  type: string
  label: string
  zones: ZoneType[]
  namePatterns: string[]
}

export interface FlavorPack {
  id: string
  label: string
  tables: Record<string, string[]>
  districtPatterns: string[]
  streetPatterns: string[]
  poiTypes: PoiTypeDef[]
}

export function generateName(
  pattern: string,
  tables: Record<string, string[]>,
  rng: Rng,
): string {
  return pattern.replace(/\{(\w+)\}/g, (_, key: string) => {
    const table = tables[key]
    if (!table || table.length === 0) throw new Error(`unknown name table: ${key}`)
    return rng.pick(table)
  })
}
