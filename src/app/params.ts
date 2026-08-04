import type { SectorParams } from '../gen/types'

export const DEFAULTS: Omit<SectorParams, 'seed'> = {
  size: 4,
  density: 0.5,
  corpDominance: 0.5,
  poiDensity: 0.5,
  terrain: 'auto',
  piers: false,
  pack: 'generic',
  theme: 'neon',
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

function num(sp: URLSearchParams, key: string, fallback: number, min: number, max: number): number {
  const raw = Number(sp.get(key))
  return Number.isFinite(raw) && sp.get(key) !== null ? clamp(raw, min, max) : fallback
}

export function paramsFromSearch(search: string, fallbackSeed: number): SectorParams {
  const sp = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  return {
    seed: num(sp, 'seed', fallbackSeed, 0, 0xffffffff),
    size: num(sp, 'size', DEFAULTS.size, 2, 8),
    density: num(sp, 'density', DEFAULTS.density, 0, 1),
    corpDominance: num(sp, 'corp', DEFAULTS.corpDominance, 0, 1),
    poiDensity: num(sp, 'poi', DEFAULTS.poiDensity, 0, 1),
    terrain: (sp.get('terrain') as SectorParams['terrain']) ?? 'auto',
    piers: sp.get('piers') === '1',
    pack: sp.get('pack') ?? DEFAULTS.pack,
    theme: sp.get('theme') ?? DEFAULTS.theme,
  }
}

export function paramsToSearch(p: SectorParams): string {
  const sp = new URLSearchParams({
    seed: String(p.seed),
    size: String(p.size),
    density: String(p.density),
    corp: String(p.corpDominance),
    poi: String(p.poiDensity),
    terrain: p.terrain,
    piers: p.piers ? '1' : '0',
    pack: p.pack,
    theme: p.theme,
  })
  return `?${sp.toString()}`
}
