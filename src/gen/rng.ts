export interface Rng {
  next(): number
  int(min: number, max: number): number
  pick<T>(arr: readonly T[]): T
  weighted<T>(items: ReadonlyArray<readonly [T, number]>): T
  chance(p: number): boolean
}

/** Deterministic uint32 from arbitrary parts (cyrb53-derived). */
export function hashSeed(...parts: Array<string | number>): number {
  const str = parts.join(':')
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (h1 ^ h2) >>> 0
}

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    weighted: (items) => {
      const total = items.reduce((s, [, w]) => s + w, 0)
      let roll = next() * total
      for (const [value, w] of items) {
        roll -= w
        if (roll < 0 && w > 0) return value
      }
      return items[items.length - 1][0]
    },
    chance: (p) => next() < p,
  }
}
