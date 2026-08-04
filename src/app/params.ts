import type { Tag } from './tags'
import { normalizeTags } from './tags'

export interface AppState {
  seed: number
  tags: Tag[]
  pack: string
  theme: string
}

export const DEFAULT_STATE: Omit<AppState, 'seed'> = {
  tags: [],
  pack: 'generic',
  theme: 'neon',
}

export function stateFromSearch(search: string, fallbackSeed: number): AppState {
  const sp = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const seedRaw = Number(sp.get('seed'))
  const seed = sp.get('seed') !== null && Number.isFinite(seedRaw) ? seedRaw >>> 0 : fallbackSeed
  const tags = normalizeTags((sp.get('tags') ?? '').split(',').filter(Boolean))
  return {
    seed,
    tags,
    pack: sp.get('pack') ?? DEFAULT_STATE.pack,
    theme: sp.get('theme') ?? DEFAULT_STATE.theme,
  }
}

export function stateToSearch(state: AppState): string {
  const sp = new URLSearchParams({ seed: String(state.seed), pack: state.pack, theme: state.theme })
  if (state.tags.length > 0) sp.set('tags', state.tags.join(','))
  return `?${sp.toString()}`
}
