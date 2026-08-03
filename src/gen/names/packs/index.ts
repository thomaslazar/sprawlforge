import type { FlavorPack } from '../names'
import { generic } from './generic'
import { shadowrunish } from './shadowrunish'

export const packs: Record<string, FlavorPack> = { generic, shadowrunish }

export function getPack(id: string): FlavorPack {
  return packs[id] ?? generic
}
