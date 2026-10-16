import { hashSeed, mulberry32 } from '../rng'
import type { Block, BlockStyle, Building, District, ZoneType } from '../types'

type Z = ZoneType
/** names per fabric; a zone entry wins over `_` (the fallback for every other zone) */
export const USES: Record<BlockStyle, Partial<Record<Z | '_', string[]>>> = {
  bigbox: { _: ['superstore', 'wholesale market'], industrial: ['factory hall', 'warehouse', 'logistics depot'], docks: ['factory hall', 'warehouse', 'logistics depot'], entertainment: ['mall', 'multiplex', 'arena hall'], corp: ['data centre', 'superstore'] },
  sheds: { _: ['workshop', 'storage', 'repair shop'], docks: ['boat shed', 'cold store', 'storage'] },
  rows: { _: ['apartment row', 'terraced houses'], slum: ['tenements'], corp: ['back-street offices', 'row shops'], entertainment: ['back-street offices', 'row shops'], industrial: ["workers' housing"], docks: ["workers' housing"] },
  terrace: { _: ['apartment row', 'terraced houses'], slum: ['tenements'], corp: ['back-street offices', 'row shops'], entertainment: ['back-street offices', 'row shops'], industrial: ["workers' housing"], docks: ["workers' housing"] },
  perimeter: { _: ['apartment block'], corp: ['office block'], entertainment: ['hotel'], slum: ['tenement block'], industrial: ['company housing'], docks: ['company housing'] },
  zeilen: { _: ['apartment slabs'] },
  villas: { _: ['villa', 'townhouse'] },
  detached: { _: ['house'] },
  shophouse: { _: ['shophouses'] },
  strip: { _: ['roadside store', 'motel', 'drive-in', 'filling station'] },
  'tower-park': { _: ['residential tower'], corp: ['office tower'], entertainment: ['hotel tower'] },
  podium: { _: ['corporate headquarters', 'hotel tower'] },
  blockfill: { _: ['courtyard block'], industrial: ['factory block'] },
  garage: { _: ['parking garage'] },
  plaza: { _: ['pavilion', 'kiosk'] },
  megablock: { _: ['hive cell'] },
  compound: { _: ['compound building', 'barracks', 'depot'] },
}

/** plain-language use of a building, deterministic from its id (lowercase; capitalise for display) */
export function useName(b: Building, block: Block, district: District): string {
  const shape: string[] | undefined = b.shape === 'A19' ? ['corporate headquarters', 'hotel tower'] : b.shape === 'F14' ? ['parking garage'] : b.shape === 'hive' ? ['hive cell'] : undefined
  const t = USES[block.style]
  const list = shape ?? t[district.zone] ?? t._!
  return mulberry32(hashSeed(0, 'use', b.id)).pick(list)
}
