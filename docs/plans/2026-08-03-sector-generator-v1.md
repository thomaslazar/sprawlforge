# Sector Generator v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the SprawlForge sector generator — a watabou-style, client-only web tool that procedurally generates a cyberpunk city sector (roads, zoned districts, buildings, named POIs) from a seed, rendered as themed SVG with PNG/SVG/PDF export.

**Architecture:** Three hard layers in one Vite app. `src/gen/` is pure TypeScript (no React, no DOM): params + seed in, plain data model out, every step a pure function with its own derived RNG stream. `src/render/` turns the model into an SVG string using a theme object. `src/app/` is React: knob panel, URL-as-state, map viewport, export buttons.

**Tech Stack:** Vite 7, React 19, TypeScript (strict), Vitest 3. Runtime deps: react, react-dom, jspdf + svg2pdf.js (PDF export only). Everything else hand-rolled (~10-line PRNG, no geometry libs).

**Execution environment:** All tasks run **inside the devcontainer** (`npm` must not touch the host Mac). Reopen the repo in the container before starting Task 1.

## Global Constraints

- **Metric only.** All distances in meters, sizes in km. No imperial units in code, UI, docs, or exports. Ever.
- **Determinism.** No `Math.random`, `Date.now`, or `new Date()` anywhere in `src/gen/` or `src/render/`. All randomness flows from `mulberry32(seed)`. Same seed + params ⇒ byte-identical output.
- **Layer purity.** `src/gen/` and `src/render/` never import from React, the DOM, or `src/app/`.
- **UI strings externalized.** Every user-visible UI label comes from `src/app/strings.ts` (i18n-ready, English first). Generated map content (names) comes from flavor packs, not strings.ts.
- **Stable entity ids.** Every model entity gets a deterministic id (`D01`, `B0203`, `BLD020301`, `P04`) — required for hierarchical child seeds and user-override diffs later.
- **Conventional Commits**, subject imperative, lowercase, no period. No attribution trailers.
- **Branch:** all work on `spec/sprawlforge-design` (spec + implementation reviewed as one unit).

## File Structure

```
package.json, tsconfig.json, vite.config.ts, index.html
src/
  gen/
    rng.ts              seeded PRNG + seed-derivation hash + helpers
    geometry.ts         Rect ops + jittered BSP subdivision
    types.ts            data model + params interfaces
    names/
      names.ts          pattern-based name generator
      packs/generic.ts  flavor pack: generic cyberpunk
      packs/shadowrunish.ts
    sector/
      geography.ts      water (none | coast | river)
      roads.ts          highways → arterials → streets; districts + blocks
      zoning.ts         zone assignment per district
      buildings.ts      building footprints per block
      pois.ts           POI selection + typing
      generate.ts       pipeline composition → SectorModel
  render/
    theme.ts            Theme type + neon + print themes
    svg.ts              SectorModel + Theme → SVG string
  app/
    strings.ts          UI strings (en)
    params.ts           SectorParams ⇄ URL query codec
    exports.ts          SVG / PNG / PDF download
    App.tsx             wiring
    KnobPanel.tsx       sliders/toggles/selects + reroll
    MapView.tsx         SVG viewport with pan/zoom
    main.tsx            entry
tests mirror sources: src/gen/rng.test.ts etc. (Vitest co-located)
.github/workflows/deploy.yml   GitHub Pages
```

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.tsx`, `src/app/App.tsx`, `src/vite-env.d.ts`

**Interfaces:**
- Produces: working `npm run dev` / `npm test` / `npm run build`; folder layout all later tasks assume.

- [ ] **Step 1: Write config + entry files**

`package.json`:

```json
{
  "name": "sprawlforge",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "react": "^19.1.0",
    "react-dom": "^19.1.0"
  },
  "devDependencies": {
    "@types/react": "^19.1.0",
    "@types/react-dom": "^19.1.0",
    "@vitejs/plugin-react": "^4.5.0",
    "typescript": "~5.9.0",
    "vite": "^7.0.0",
    "vitest": "^3.2.0"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

`vite.config.ts` (note `base: './'` — output must work on GitHub Pages *and* any self-hosted subpath):

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',
  plugins: [react()],
})
```

`index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>SprawlForge</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`src/main.tsx`:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

`src/app/App.tsx` (placeholder, replaced in Task 12):

```tsx
export function App() {
  return <h1>SprawlForge</h1>
}
```

`src/vite-env.d.ts`:

```ts
/// <reference types="vite/client" />
```

- [ ] **Step 2: Install and verify**

Run: `npm install && npm run build`
Expected: build succeeds, `dist/` created.

Run: `npm test`
Expected: Vitest reports "no test files found" and exits 0 (`vitest run` passes with no tests) — if it exits non-zero, add `"test": "vitest run --passWithNoTests"`.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json tsconfig.json vite.config.ts index.html src/
git commit -m "feat: scaffold vite react typescript app"
```

---

### Task 2: Seeded RNG + seed derivation

**Files:**
- Create: `src/gen/rng.ts`, `src/gen/rng.test.ts`

**Interfaces:**
- Produces:
  - `hashSeed(...parts: Array<string | number>): number` — deterministic uint32 from parts; used for hierarchical child seeds (`hashSeed(parentSeed, 'D07')`) and per-stage streams.
  - `mulberry32(seed: number): Rng`
  - `interface Rng { next(): number; int(min: number, max: number): number; pick<T>(arr: readonly T[]): T; weighted<T>(items: ReadonlyArray<readonly [T, number]>): T; chance(p: number): boolean }`

- [ ] **Step 1: Write the failing test**

`src/gen/rng.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { hashSeed, mulberry32 } from './rng'

describe('hashSeed', () => {
  it('is deterministic and part-sensitive', () => {
    expect(hashSeed(4711, 'D07')).toBe(hashSeed(4711, 'D07'))
    expect(hashSeed(4711, 'D07')).not.toBe(hashSeed(4711, 'D08'))
    expect(hashSeed(4711, 'D07')).not.toBe(hashSeed(4712, 'D07'))
  })
  it('returns a uint32', () => {
    const h = hashSeed('anything', 42)
    expect(Number.isInteger(h)).toBe(true)
    expect(h).toBeGreaterThanOrEqual(0)
    expect(h).toBeLessThanOrEqual(0xffffffff)
  })
})

describe('mulberry32', () => {
  it('same seed gives same sequence', () => {
    const a = mulberry32(123)
    const b = mulberry32(123)
    expect([a.next(), a.next(), a.next()]).toEqual([b.next(), b.next(), b.next()])
  })
  it('next() is in [0,1)', () => {
    const r = mulberry32(1)
    for (let i = 0; i < 1000; i++) {
      const v = r.next()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
  it('int(min,max) is inclusive and in range', () => {
    const r = mulberry32(7)
    const seen = new Set<number>()
    for (let i = 0; i < 500; i++) {
      const v = r.int(2, 5)
      expect(v).toBeGreaterThanOrEqual(2)
      expect(v).toBeLessThanOrEqual(5)
      seen.add(v)
    }
    expect(seen.size).toBe(4)
  })
  it('weighted respects zero weights', () => {
    const r = mulberry32(9)
    for (let i = 0; i < 200; i++) {
      expect(r.weighted([['a', 0], ['b', 1]] as const)).toBe('b')
    }
  })
  it('pick returns an element', () => {
    const r = mulberry32(5)
    expect(['x', 'y', 'z']).toContain(r.pick(['x', 'y', 'z']))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/gen/rng.test.ts`
Expected: FAIL — cannot resolve `./rng`.

- [ ] **Step 3: Write implementation**

`src/gen/rng.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/gen/rng.test.ts`
Expected: PASS (all 6).

- [ ] **Step 5: Commit**

```bash
git add src/gen/rng.ts src/gen/rng.test.ts
git commit -m "feat: add seeded prng and seed derivation hash"
```

---

### Task 3: Geometry — rects and jittered BSP subdivision

**Files:**
- Create: `src/gen/geometry.ts`, `src/gen/geometry.test.ts`

**Interfaces:**
- Consumes: `Rng` from `./rng`.
- Produces:
  - `interface Rect { x: number; y: number; w: number; h: number }`
  - `interface Pt { x: number; y: number }`
  - `insetRect(r: Rect, d: number): Rect | null` — null when result would be ≤ 0 sized.
  - `interface Cut { axis: 'x' | 'y'; strip: Rect }` — the road strip a split leaves between children.
  - `bspSplit(rect: Rect, opts: { minCell: number; gap: number; jitter: number; rng: Rng }): { cells: Rect[]; cuts: Cut[] }` — recursive split; a rect splits while its longer side ≥ `2 * minCell + gap`; split position uniform in `0.5 ± jitter` of the side; `gap`-wide strip between children recorded as a Cut.

- [ ] **Step 1: Write the failing test**

`src/gen/geometry.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { bspSplit, insetRect, type Rect } from './geometry'
import { mulberry32 } from './rng'

const within = (inner: Rect, outer: Rect) =>
  inner.x >= outer.x - 1e-9 &&
  inner.y >= outer.y - 1e-9 &&
  inner.x + inner.w <= outer.x + outer.w + 1e-9 &&
  inner.y + inner.h <= outer.y + outer.h + 1e-9

describe('insetRect', () => {
  it('shrinks on all sides', () => {
    expect(insetRect({ x: 0, y: 0, w: 100, h: 60 }, 10)).toEqual({ x: 10, y: 10, w: 80, h: 40 })
  })
  it('returns null when too small', () => {
    expect(insetRect({ x: 0, y: 0, w: 15, h: 60 }, 10)).toBeNull()
  })
})

describe('bspSplit', () => {
  const rect: Rect = { x: 0, y: 0, w: 1000, h: 800 }
  const opts = { minCell: 100, gap: 10, jitter: 0.15 }

  it('is deterministic for the same seed', () => {
    const a = bspSplit(rect, { ...opts, rng: mulberry32(42) })
    const b = bspSplit(rect, { ...opts, rng: mulberry32(42) })
    expect(a).toEqual(b)
  })
  it('produces multiple cells all inside the input rect', () => {
    const { cells } = bspSplit(rect, { ...opts, rng: mulberry32(42) })
    expect(cells.length).toBeGreaterThan(3)
    for (const c of cells) expect(within(c, rect)).toBe(true)
  })
  it('respects minCell: no cell side smaller than minCell * (0.5 - jitter)', () => {
    const { cells } = bspSplit(rect, { ...opts, rng: mulberry32(42) })
    const floor = opts.minCell * (0.5 - opts.jitter)
    for (const c of cells) {
      expect(c.w).toBeGreaterThanOrEqual(floor)
      expect(c.h).toBeGreaterThanOrEqual(floor)
    }
  })
  it('cells do not overlap', () => {
    const { cells } = bspSplit(rect, { ...opts, rng: mulberry32(42) })
    for (let i = 0; i < cells.length; i++)
      for (let j = i + 1; j < cells.length; j++) {
        const a = cells[i], b = cells[j]
        const overlap =
          a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
        expect(overlap).toBe(false)
      }
  })
  it('records one cut per split (cells - 1)', () => {
    const { cells, cuts } = bspSplit(rect, { ...opts, rng: mulberry32(42) })
    expect(cuts.length).toBe(cells.length - 1)
  })
  it('leaves an unsplittable rect whole', () => {
    const { cells, cuts } = bspSplit({ x: 0, y: 0, w: 150, h: 150 }, { ...opts, rng: mulberry32(1) })
    expect(cells).toEqual([{ x: 0, y: 0, w: 150, h: 150 }])
    expect(cuts).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/gen/geometry.test.ts`
Expected: FAIL — cannot resolve `./geometry`.

- [ ] **Step 3: Write implementation**

`src/gen/geometry.ts`:

```ts
import type { Rng } from './rng'

export interface Rect { x: number; y: number; w: number; h: number }
export interface Pt { x: number; y: number }

export function insetRect(r: Rect, d: number): Rect | null {
  const w = r.w - 2 * d
  const h = r.h - 2 * d
  if (w <= 0 || h <= 0) return null
  return { x: r.x + d, y: r.y + d, w, h }
}

export interface Cut { axis: 'x' | 'y'; strip: Rect }

export interface BspOpts { minCell: number; gap: number; jitter: number; rng: Rng }

export function bspSplit(rect: Rect, opts: BspOpts): { cells: Rect[]; cuts: Cut[] } {
  const cells: Rect[] = []
  const cuts: Cut[] = []
  const recurse = (r: Rect): void => {
    const longer = Math.max(r.w, r.h)
    if (longer < 2 * opts.minCell + opts.gap) {
      cells.push(r)
      return
    }
    // split across the longer side; 'x' axis means a vertical cut line
    const axis: 'x' | 'y' = r.w >= r.h ? 'x' : 'y'
    const side = axis === 'x' ? r.w : r.h
    const frac = 0.5 + (opts.rng.next() * 2 - 1) * opts.jitter
    const at = side * frac
    if (axis === 'x') {
      cuts.push({ axis, strip: { x: r.x + at - opts.gap / 2, y: r.y, w: opts.gap, h: r.h } })
      recurse({ x: r.x, y: r.y, w: at - opts.gap / 2, h: r.h })
      recurse({ x: r.x + at + opts.gap / 2, y: r.y, w: r.w - at - opts.gap / 2, h: r.h })
    } else {
      cuts.push({ axis, strip: { x: r.x, y: r.y + at - opts.gap / 2, w: r.w, h: opts.gap } })
      recurse({ x: r.x, y: r.y, w: r.w, h: at - opts.gap / 2 })
      recurse({ x: r.x, y: r.y + at + opts.gap / 2, w: r.w, h: r.h - at - opts.gap / 2 })
    }
  }
  recurse(rect)
  return { cells, cuts }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/gen/geometry.test.ts`
Expected: PASS. If the minCell-floor test fails, the split guard is wrong: a rect only splits when `longer >= 2*minCell + gap`, and the worst-case child is `(0.5 - jitter) * side - gap/2` — verify the recursion matches the code above exactly.

- [ ] **Step 5: Commit**

```bash
git add src/gen/geometry.ts src/gen/geometry.test.ts
git commit -m "feat: add rect helpers and jittered bsp subdivision"
```

---

### Task 4: Data model + params types

**Files:**
- Create: `src/gen/types.ts`

**Interfaces:**
- Consumes: `Rect`, `Pt` from `./geometry`.
- Produces (used by every later gen/render task):

- [ ] **Step 1: Write the types (no test — declarations only, exercised by every later test)**

`src/gen/types.ts`:

```ts
import type { Pt, Rect } from './geometry'

export const GENERATOR_VERSION = 1

export type ZoneType =
  | 'corp'
  | 'residential'
  | 'slum'
  | 'industrial'
  | 'entertainment'
  | 'docks'

export const ZONE_TYPES: readonly ZoneType[] = [
  'corp', 'residential', 'slum', 'industrial', 'entertainment', 'docks',
]

export type RoadClass = 'highway' | 'arterial' | 'street'

export interface SectorParams {
  seed: number
  /** sector edge length in km (map is size × size km) */
  size: number
  /** 0..1 — building coverage / block tightness */
  density: number
  /** 0..1 — how corp-dominated the sector is */
  corpDominance: number
  /** 0..1 — POI frequency */
  poiDensity: number
  coast: boolean
  river: boolean
  /** flavor pack id */
  pack: string
  /** theme id (render-side concern, carried in params for URL round-trip) */
  theme: string
}

export interface Water {
  kind: 'none' | 'coast' | 'river'
  /** closed polygon in meters; empty when kind === 'none' */
  polygon: Pt[]
  /** axis-aligned bounding rect used to keep land layout out of water; null when none */
  bounds: Rect | null
}

export interface Road {
  id: string
  class: RoadClass
  /** centerline, meters */
  points: Pt[]
  /** total paved width, meters */
  width: number
  name: string | null
}

export interface District {
  id: string
  zone: ZoneType
  name: string
  bounds: Rect
}

export interface Block {
  id: string
  districtId: string
  rect: Rect
}

export interface Building {
  id: string
  blockId: string
  districtId: string
  rect: Rect
}

export interface Poi {
  id: string
  buildingId: string
  districtId: string
  /** poi type id from the flavor pack, e.g. 'corp_hq' */
  type: string
  name: string
  /** marker position (building center), meters */
  at: Pt
}

export interface SectorModel {
  meta: {
    seed: number
    generatorVersion: number
    params: SectorParams
    /** sector edge length in meters */
    sizeM: number
  }
  water: Water
  roads: Road[]
  districts: District[]
  blocks: Block[]
  buildings: Building[]
  pois: Poi[]
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/gen/types.ts
git commit -m "feat: add sector data model and params types"
```

---

### Task 5: Name generator + flavor packs

**Files:**
- Create: `src/gen/names/names.ts`, `src/gen/names/names.test.ts`, `src/gen/names/packs/generic.ts`, `src/gen/names/packs/shadowrunish.ts`, `src/gen/names/packs/index.ts`

**Interfaces:**
- Consumes: `Rng` from `../rng`; `ZoneType` from `../types`.
- Produces:
  - `interface PoiTypeDef { type: string; label: string; zones: ZoneType[]; namePatterns: string[] }`
  - `interface FlavorPack { id: string; label: string; tables: Record<string, string[]>; districtPatterns: string[]; streetPatterns: string[]; poiTypes: PoiTypeDef[] }`
  - `generateName(pattern: string, tables: Record<string, string[]>, rng: Rng): string` — replaces each `{key}` with `rng.pick(tables[key])`; unknown key throws.
  - `packs: Record<string, FlavorPack>` and `getPack(id: string): FlavorPack` (falls back to `generic`).

- [ ] **Step 1: Write the failing test**

`src/gen/names/names.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { mulberry32 } from '../rng'
import { generateName } from './names'
import { getPack, packs } from './packs'

describe('generateName', () => {
  const tables = { adj: ['Neon', 'Iron'], noun: ['Heights', 'Row'] }
  it('fills placeholders deterministically', () => {
    expect(generateName('{adj} {noun}', tables, mulberry32(1)))
      .toBe(generateName('{adj} {noun}', tables, mulberry32(1)))
  })
  it('output contains only table words', () => {
    const n = generateName('{adj} {noun}', tables, mulberry32(2))
    const [a, b] = n.split(' ')
    expect(tables.adj).toContain(a)
    expect(tables.noun).toContain(b)
  })
  it('throws on unknown key', () => {
    expect(() => generateName('{nope}', tables, mulberry32(1))).toThrow()
  })
})

describe('flavor packs', () => {
  it('ships generic and shadowrunish', () => {
    expect(Object.keys(packs).sort()).toEqual(['generic', 'shadowrunish'])
  })
  it('getPack falls back to generic', () => {
    expect(getPack('unknown').id).toBe('generic')
  })
  for (const pack of Object.values(packs)) {
    it(`${pack.id}: every pattern placeholder resolves against its tables`, () => {
      const rng = mulberry32(3)
      const allPatterns = [
        ...pack.districtPatterns,
        ...pack.streetPatterns,
        ...pack.poiTypes.flatMap((p) => p.namePatterns),
      ]
      for (const pattern of allPatterns) {
        expect(() => generateName(pattern, pack.tables, rng)).not.toThrow()
      }
    })
    it(`${pack.id}: every zone type has at least one poi type`, () => {
      const zones = new Set(pack.poiTypes.flatMap((p) => p.zones))
      for (const z of ['corp', 'residential', 'slum', 'industrial', 'entertainment', 'docks'])
        expect(zones.has(z as never)).toBe(true)
    })
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/gen/names/names.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write implementation**

`src/gen/names/names.ts`:

```ts
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
```

`src/gen/names/packs/generic.ts` (generic cyberpunk — no trademarked strings):

```ts
import type { FlavorPack } from '../names'

export const generic: FlavorPack = {
  id: 'generic',
  label: 'Generic Cyberpunk',
  tables: {
    adj: ['Neon', 'Iron', 'Chrome', 'Black', 'Lower', 'Upper', 'Old', 'New', 'East', 'West'],
    place: ['Heights', 'Row', 'Docks', 'Yards', 'Junction', 'Terrace', 'Flats', 'Strip', 'Quarter', 'Gardens'],
    corpA: ['Apex', 'Helix', 'Omni', 'Zenith', 'Vertex', 'Nova', 'Kessler', 'Draco', 'Meridian', 'Halcyon'],
    corpB: ['Dynamics', 'Biotech', 'Systems', 'Industries', 'Securities', 'Robotics', 'Logistics', 'Media', 'Energy', 'Holdings'],
    street: ['Wire', 'Circuit', 'Solder', 'Carbon', 'Cobalt', 'Mercury', 'Static', 'Vapor', 'Signal', 'Relay'],
    streetType: ['Street', 'Avenue', 'Boulevard', 'Expressway', 'Route'],
    venue: ['Afterlife', 'Voltage', 'Chrome Cat', 'Zero Zero', 'Blackout', 'The Socket', 'Neon Lotus', 'Glitch'],
  },
  districtPatterns: ['{adj} {place}', '{street} {place}'],
  streetPatterns: ['{street} {streetType}', '{adj} {streetType}'],
  poiTypes: [
    { type: 'corp_hq', label: 'Corporate HQ', zones: ['corp'], namePatterns: ['{corpA} {corpB} HQ'] },
    { type: 'corp_office', label: 'Corporate office', zones: ['corp', 'entertainment'], namePatterns: ['{corpA} {corpB}'] },
    { type: 'club', label: 'Nightclub', zones: ['entertainment', 'slum', 'residential'], namePatterns: ['Club {venue}', '{venue}'] },
    { type: 'clinic', label: 'Clinic', zones: ['residential', 'slum', 'corp'], namePatterns: ['{adj} {place} Clinic', '{corpA} Medcenter'] },
    { type: 'market', label: 'Market', zones: ['slum', 'residential', 'docks'], namePatterns: ['{street} Market', '{adj} Bazaar'] },
    { type: 'safehouse', label: 'Safehouse', zones: ['slum', 'residential', 'industrial', 'docks'], namePatterns: ['{street} Den', '{adj} Hole'] },
    { type: 'warehouse', label: 'Warehouse', zones: ['industrial', 'docks'], namePatterns: ['{corpA} Storage {streetType}', 'Depot {street}'] },
    { type: 'bar', label: 'Bar', zones: ['slum', 'entertainment', 'docks', 'industrial', 'residential', 'corp'], namePatterns: ['The {street}', '{venue} Bar'] },
  ],
}
```

`src/gen/names/packs/shadowrunish.ts` (Shadowrun-*flavored*, original strings only):

```ts
import type { FlavorPack } from '../names'
import { generic } from './generic'

export const shadowrunish: FlavorPack = {
  ...generic,
  id: 'shadowrunish',
  label: 'Sprawl (Shadowrun-ish)',
  tables: {
    ...generic.tables,
    adj: ['Redmond', 'Puyallup', 'Downtown', 'Tacoma', 'Everett', 'Auburn', 'Lower', 'Old', 'North', 'South'],
    corpA: ['Shirasagi', 'Tanaka-Doyle', 'Federated Kord', 'Zeta-Prime', 'Aztek', 'Renraki', 'Evo-Dyne', 'Wuxing-Pac', 'Saeder', 'Mitsuhama-West'],
    venue: ['The Daze', 'Matchsticks', 'Banshee', 'The Big Rhino', 'Underworld', 'Penumbra', 'Dante’s', 'The Skeleton'],
  },
  poiTypes: [
    ...generic.poiTypes,
    { type: 'talismonger', label: 'Talismonger', zones: ['slum', 'residential', 'entertainment'], namePatterns: ['{adj} Talismans', '{street} Charms'] },
    { type: 'matrix_hub', label: 'Matrix hub', zones: ['corp', 'entertainment', 'residential'], namePatterns: ['{corpA} Grid Node', '{street} Hub'] },
  ],
}
```

`src/gen/names/packs/index.ts`:

```ts
import type { FlavorPack } from '../names'
import { generic } from './generic'
import { shadowrunish } from './shadowrunish'

export const packs: Record<string, FlavorPack> = { generic, shadowrunish }

export function getPack(id: string): FlavorPack {
  return packs[id] ?? generic
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/gen/names/names.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gen/names/
git commit -m "feat: add pattern name generator with two flavor packs"
```

---

### Task 6: Geography (water)

**Files:**
- Create: `src/gen/sector/geography.ts`, `src/gen/sector/geography.test.ts`

**Interfaces:**
- Consumes: `SectorParams`, `Water` from `../types`; `mulberry32`, `hashSeed` from `../rng`.
- Produces: `genGeography(params: SectorParams, sizeM: number): Water` — coast wins over river when both toggled; derives its own rng via `mulberry32(hashSeed(params.seed, 'geo'))`.
  - Coast: water strip along the east edge, land/water boundary a jittered vertical polyline around `x = sizeM * 0.78`, jitter amplitude `sizeM * 0.04`, one point every `sizeM / 12`.
  - River: horizontal band, centerline jittered around `y = sizeM * (0.35..0.65)`, width `sizeM * 0.05`.
  - `bounds` = axis-aligned bbox of the water polygon.

- [ ] **Step 1: Write the failing test**

`src/gen/sector/geography.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { SectorParams } from '../types'
import { genGeography } from './geography'

const base: SectorParams = {
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5,
  coast: false, river: false, pack: 'generic', theme: 'neon',
}
const sizeM = 4000

describe('genGeography', () => {
  it('none when nothing toggled', () => {
    const w = genGeography(base, sizeM)
    expect(w.kind).toBe('none')
    expect(w.polygon).toEqual([])
    expect(w.bounds).toBeNull()
  })
  it('coast produces an east-side polygon within the sector', () => {
    const w = genGeography({ ...base, coast: true }, sizeM)
    expect(w.kind).toBe('coast')
    expect(w.polygon.length).toBeGreaterThan(4)
    for (const p of w.polygon) {
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.x).toBeLessThanOrEqual(sizeM)
      expect(p.y).toBeGreaterThanOrEqual(0)
      expect(p.y).toBeLessThanOrEqual(sizeM)
    }
    expect(w.bounds!.x).toBeGreaterThan(sizeM * 0.6)
  })
  it('river produces a horizontal band', () => {
    const w = genGeography({ ...base, river: true }, sizeM)
    expect(w.kind).toBe('river')
    expect(w.bounds!.w).toBe(sizeM)
    expect(w.bounds!.h).toBeLessThan(sizeM * 0.3)
  })
  it('coast wins over river', () => {
    expect(genGeography({ ...base, coast: true, river: true }, sizeM).kind).toBe('coast')
  })
  it('is deterministic', () => {
    expect(genGeography({ ...base, coast: true }, sizeM))
      .toEqual(genGeography({ ...base, coast: true }, sizeM))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/gen/sector/geography.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

`src/gen/sector/geography.ts`:

```ts
import type { Pt } from '../geometry'
import { hashSeed, mulberry32 } from '../rng'
import type { SectorParams, Water } from '../types'

function bbox(points: Pt[]): { x: number; y: number; w: number; h: number } {
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

export function genGeography(params: SectorParams, sizeM: number): Water {
  if (!params.coast && !params.river) return { kind: 'none', polygon: [], bounds: null }
  const rng = mulberry32(hashSeed(params.seed, 'geo'))
  const steps = 12
  const step = sizeM / steps

  if (params.coast) {
    const baseX = sizeM * 0.78
    const amp = sizeM * 0.04
    const edge: Pt[] = []
    for (let i = 0; i <= steps; i++) {
      edge.push({ x: baseX + (rng.next() * 2 - 1) * amp, y: i * step })
    }
    const polygon: Pt[] = [
      ...edge,
      { x: sizeM, y: sizeM },
      { x: sizeM, y: 0 },
    ]
    return { kind: 'coast', polygon, bounds: bbox(polygon) }
  }

  const centerY = sizeM * (0.35 + rng.next() * 0.3)
  const half = (sizeM * 0.05) / 2
  const amp = sizeM * 0.02
  const top: Pt[] = []
  const bottom: Pt[] = []
  for (let i = 0; i <= steps; i++) {
    const jitter = (rng.next() * 2 - 1) * amp
    top.push({ x: i * step, y: centerY + jitter - half })
    bottom.push({ x: i * step, y: centerY + jitter + half })
  }
  const polygon = [...top, ...bottom.reverse()]
  return { kind: 'river', polygon, bounds: bbox(polygon) }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/gen/sector/geography.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gen/sector/geography.ts src/gen/sector/geography.test.ts
git commit -m "feat: add water geography generation"
```

---

### Task 7: Roads, districts, blocks

**Files:**
- Create: `src/gen/sector/roads.ts`, `src/gen/sector/roads.test.ts`

**Interfaces:**
- Consumes: `bspSplit`, `insetRect`, `Rect` from `../geometry`; `mulberry32`, `hashSeed` from `../rng`; types from `../types`.
- Produces: `layoutRoads(params: SectorParams, water: Water, sizeM: number): { roads: Road[]; districtRects: Rect[]; blocksByDistrict: Rect[][] }`
  - Land = sector rect, minus east strip when coast (`w` reduced to `water.bounds.x`), split into two slabs when river (above/below `water.bounds`).
  - Highways: width 32 m. When `size >= 3`, one vertical highway at jittered x in the middle third of the land — splits slabs further.
  - Arterials: `bspSplit(slab, { minCell: 500, gap: 18, jitter: 0.18 })` — cells become **district rects**, cuts become arterial roads (width 18).
  - Streets: per district, `bspSplit(district, { minCell: streetCell, gap: 9, jitter: 0.2 })` where `streetCell = 160 - params.density * 70` — cells become **block rects**, cuts become street roads (width 9).
  - Road ids: `H1…`, `A01…`, `S001…` in generation order. Names are null here (Task 10 assigns from pack).
  - Cut strips convert to centerline roads: vertical strip → points top-center/bottom-center; horizontal → left-center/right-center.

- [ ] **Step 1: Write the failing test**

`src/gen/sector/roads.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Rect } from '../geometry'
import type { SectorParams } from '../types'
import { genGeography } from './geography'
import { layoutRoads } from './roads'

const base: SectorParams = {
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5,
  coast: false, river: false, pack: 'generic', theme: 'neon',
}
const sizeM = 4000
const noWater = genGeography(base, sizeM)

describe('layoutRoads', () => {
  it('is deterministic', () => {
    expect(layoutRoads(base, noWater, sizeM)).toEqual(layoutRoads(base, noWater, sizeM))
  })
  it('produces districts, blocks and all three road classes', () => {
    const r = layoutRoads(base, noWater, sizeM)
    expect(r.districtRects.length).toBeGreaterThanOrEqual(4)
    expect(r.blocksByDistrict.length).toBe(r.districtRects.length)
    expect(r.blocksByDistrict.flat().length).toBeGreaterThan(r.districtRects.length)
    const classes = new Set(r.roads.map((x) => x.class))
    expect(classes).toEqual(new Set(['highway', 'arterial', 'street']))
  })
  it('higher density gives more blocks', () => {
    const lo = layoutRoads({ ...base, density: 0.1 }, noWater, sizeM).blocksByDistrict.flat().length
    const hi = layoutRoads({ ...base, density: 0.9 }, noWater, sizeM).blocksByDistrict.flat().length
    expect(hi).toBeGreaterThan(lo)
  })
  it('coast keeps all districts on land', () => {
    const water = genGeography({ ...base, coast: true }, sizeM)
    const r = layoutRoads({ ...base, coast: true }, water, sizeM)
    for (const d of r.districtRects) {
      expect(d.x + d.w).toBeLessThanOrEqual(water.bounds!.x + 1e-9)
    }
  })
  it('river splits land into slabs above and below', () => {
    const water = genGeography({ ...base, river: true }, sizeM)
    const r = layoutRoads({ ...base, river: true }, water, sizeM)
    const above = r.districtRects.some((d: Rect) => d.y + d.h <= water.bounds!.y + 1e-9)
    const below = r.districtRects.some((d: Rect) => d.y >= water.bounds!.y + water.bounds!.h - 1e-9)
    expect(above && below).toBe(true)
  })
  it('road ids are stable and prefixed by class', () => {
    const r = layoutRoads(base, noWater, sizeM)
    for (const road of r.roads) {
      if (road.class === 'highway') expect(road.id).toMatch(/^H\d+$/)
      if (road.class === 'arterial') expect(road.id).toMatch(/^A\d\d$/)
      if (road.class === 'street') expect(road.id).toMatch(/^S\d\d\d$/)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/gen/sector/roads.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

`src/gen/sector/roads.ts`:

```ts
import { bspSplit, type Cut, type Rect } from '../geometry'
import { hashSeed, mulberry32, type Rng } from '../rng'
import type { Road, SectorParams, Water } from '../types'

const HIGHWAY_W = 32
const ARTERIAL_W = 18
const STREET_W = 9

function cutToRoad(cut: Cut, id: string, cls: Road['class'], width: number): Road {
  const s = cut.strip
  const points =
    cut.axis === 'x'
      ? [{ x: s.x + s.w / 2, y: s.y }, { x: s.x + s.w / 2, y: s.y + s.h }]
      : [{ x: s.x, y: s.y + s.h / 2 }, { x: s.x + s.w, y: s.y + s.h / 2 }]
  return { id, class: cls, points, width, name: null }
}

function landSlabs(water: Water, sizeM: number): Rect[] {
  const sector: Rect = { x: 0, y: 0, w: sizeM, h: sizeM }
  if (water.kind === 'coast') return [{ ...sector, w: water.bounds!.x }]
  if (water.kind === 'river') {
    const b = water.bounds!
    return [
      { x: 0, y: 0, w: sizeM, h: b.y },
      { x: 0, y: b.y + b.h, w: sizeM, h: sizeM - b.y - b.h },
    ].filter((r) => r.h > 300)
  }
  return [sector]
}

function splitByHighway(slabs: Rect[], params: SectorParams, rng: Rng, roads: Road[]): Rect[] {
  if (params.size < 3) return slabs
  const out: Rect[] = []
  const landW = Math.max(...slabs.map((s) => s.x + s.w))
  const hx = landW * (1 / 3 + rng.next() / 3)
  let n = 0
  for (const slab of slabs) {
    if (hx > slab.x + 200 && hx < slab.x + slab.w - 200) {
      n += 1
      roads.push({
        id: `H${n}`,
        class: 'highway',
        points: [{ x: hx, y: slab.y }, { x: hx, y: slab.y + slab.h }],
        width: HIGHWAY_W,
        name: null,
      })
      out.push({ ...slab, w: hx - HIGHWAY_W / 2 - slab.x })
      out.push({ ...slab, x: hx + HIGHWAY_W / 2, w: slab.x + slab.w - hx - HIGHWAY_W / 2 })
    } else {
      out.push(slab)
    }
  }
  return out
}

export function layoutRoads(
  params: SectorParams,
  water: Water,
  sizeM: number,
): { roads: Road[]; districtRects: Rect[]; blocksByDistrict: Rect[][] } {
  const rng = mulberry32(hashSeed(params.seed, 'roads'))
  const roads: Road[] = []

  const slabs = splitByHighway(landSlabs(water, sizeM), params, rng, roads)

  const districtRects: Rect[] = []
  let a = 0
  for (const slab of slabs) {
    const { cells, cuts } = bspSplit(slab, { minCell: 500, gap: ARTERIAL_W, jitter: 0.18, rng })
    for (const cut of cuts) {
      a += 1
      roads.push(cutToRoad(cut, `A${String(a).padStart(2, '0')}`, 'arterial', ARTERIAL_W))
    }
    districtRects.push(...cells)
  }

  const streetCell = 160 - params.density * 70
  const blocksByDistrict: Rect[][] = []
  let s = 0
  for (const district of districtRects) {
    const { cells, cuts } = bspSplit(district, { minCell: streetCell, gap: STREET_W, jitter: 0.2, rng })
    for (const cut of cuts) {
      s += 1
      roads.push(cutToRoad(cut, `S${String(s).padStart(3, '0')}`, 'street', STREET_W))
    }
    blocksByDistrict.push(cells)
  }

  return { roads, districtRects, blocksByDistrict }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/gen/sector/roads.test.ts`
Expected: PASS. If the district count is below 4 for seed 42, do not change the test — bump `jitter` down or check the slab math; a 4 km sector with 500 m minCell must yield well over 4 districts.

- [ ] **Step 5: Commit**

```bash
git add src/gen/sector/roads.ts src/gen/sector/roads.test.ts
git commit -m "feat: add road hierarchy with district and block layout"
```

---

### Task 8: Zoning

**Files:**
- Create: `src/gen/sector/zoning.ts`, `src/gen/sector/zoning.test.ts`

**Interfaces:**
- Consumes: `Rect` from `../geometry`; rng; `ZoneType`, `SectorParams`, `District` from `../types`.
- Produces: `assignZones(districtRects: Rect[], params: SectorParams): District[]`
  - Districts sorted by `(y, x)` before id assignment → ids `D01`, `D02`, … are geometrically stable.
  - Zone picked per district via `rng.weighted(zoneWeights(params))`; own rng stream `hashSeed(seed, 'zones')`.
  - `zoneWeights(params)`: `corp: 0.5 + 3 * corpDominance`, `residential: 3 - 1.5 * corpDominance`, `slum: 2.5 - 2 * corpDominance`, `industrial: 1.5`, `entertainment: 1`, `docks: coast ? 1.5 : 0`.
  - `name` left `''` here (Task 10 fills it from the pack — keeps this module name-free).

- [ ] **Step 1: Write the failing test**

`src/gen/sector/zoning.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Rect } from '../geometry'
import { ZONE_TYPES, type SectorParams } from '../types'
import { assignZones, zoneWeights } from './zoning'

const base: SectorParams = {
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5,
  coast: false, river: false, pack: 'generic', theme: 'neon',
}
const rects: Rect[] = Array.from({ length: 12 }, (_, i) => ({
  x: (i % 4) * 1000, y: Math.floor(i / 4) * 1000, w: 900, h: 900,
}))

describe('assignZones', () => {
  it('is deterministic and assigns valid zones', () => {
    const a = assignZones(rects, base)
    expect(a).toEqual(assignZones(rects, base))
    for (const d of a) expect(ZONE_TYPES).toContain(d.zone)
  })
  it('ids follow geometric (y,x) order', () => {
    const shuffled = [...rects].reverse()
    const districts = assignZones(shuffled, base)
    expect(districts.map((d) => d.id)).toEqual(
      Array.from({ length: 12 }, (_, i) => `D${String(i + 1).padStart(2, '0')}`),
    )
    expect(districts[0].bounds).toEqual(rects[0])
  })
  it('no docks without coast', () => {
    for (const d of assignZones(rects, { ...base, corpDominance: 0 })) {
      expect(d.zone).not.toBe('docks')
    }
  })
  it('corp dominance shifts weights', () => {
    expect(zoneWeights({ ...base, corpDominance: 1 }).corp)
      .toBeGreaterThan(zoneWeights({ ...base, corpDominance: 0 }).corp)
    expect(zoneWeights({ ...base, corpDominance: 1 }).slum)
      .toBeLessThan(zoneWeights({ ...base, corpDominance: 0 }).slum)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/gen/sector/zoning.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

`src/gen/sector/zoning.ts`:

```ts
import type { Rect } from '../geometry'
import { hashSeed, mulberry32 } from '../rng'
import type { District, SectorParams, ZoneType } from '../types'

export function zoneWeights(params: SectorParams): Record<ZoneType, number> {
  const c = params.corpDominance
  return {
    corp: 0.5 + 3 * c,
    residential: 3 - 1.5 * c,
    slum: 2.5 - 2 * c,
    industrial: 1.5,
    entertainment: 1,
    docks: params.coast ? 1.5 : 0,
  }
}

export function assignZones(districtRects: Rect[], params: SectorParams): District[] {
  const rng = mulberry32(hashSeed(params.seed, 'zones'))
  const weights = Object.entries(zoneWeights(params)) as Array<[ZoneType, number]>
  const sorted = [...districtRects].sort((a, b) => a.y - b.y || a.x - b.x)
  return sorted.map((bounds, i) => ({
    id: `D${String(i + 1).padStart(2, '0')}`,
    zone: rng.weighted(weights),
    name: '',
    bounds,
  }))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/gen/sector/zoning.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gen/sector/zoning.ts src/gen/sector/zoning.test.ts
git commit -m "feat: add weighted zone assignment for districts"
```

---

### Task 9: Buildings

**Files:**
- Create: `src/gen/sector/buildings.ts`, `src/gen/sector/buildings.test.ts`

**Interfaces:**
- Consumes: geometry, rng, types.
- Produces: `fillBuildings(districts: District[], blocksByDistrict: Rect[][], params: SectorParams): { blocks: Block[]; buildings: Building[] }`
  - `blocksByDistrict[i]` belongs to the district at index `i` **after** re-sorting rects to match district order — caller (Task 10) passes them aligned; this function zips by index.
  - Block ids `B<dd><nn>` (`B0203` = district 2, block 3); building ids `BLD<dd><nn><nn>`.
  - Per block: inset by 6 m sidewalk, mini-BSP with zone profile, then keep each cell with probability `fill`:
    `ZONE_BUILD: corp {minCell 60, fill 0.7}, residential {30, 0.85}, slum {18, 0.95}, industrial {80, 0.8}, entertainment {35, 0.85}, docks {70, 0.75}` — `fill` multiplied by `0.6 + 0.4 * params.density`.
  - Own rng stream `hashSeed(seed, 'buildings')`.

- [ ] **Step 1: Write the failing test**

`src/gen/sector/buildings.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Rect } from '../geometry'
import type { District, SectorParams } from '../types'
import { fillBuildings } from './buildings'

const base: SectorParams = {
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5,
  coast: false, river: false, pack: 'generic', theme: 'neon',
}
const districts: District[] = [
  { id: 'D01', zone: 'corp', name: '', bounds: { x: 0, y: 0, w: 600, h: 600 } },
  { id: 'D02', zone: 'slum', name: '', bounds: { x: 700, y: 0, w: 600, h: 600 } },
]
const blocksByDistrict: Rect[][] = [
  [{ x: 10, y: 10, w: 280, h: 280 }, { x: 310, y: 10, w: 280, h: 280 }],
  [{ x: 710, y: 10, w: 280, h: 280 }, { x: 1010, y: 10, w: 280, h: 280 }],
]

describe('fillBuildings', () => {
  it('is deterministic', () => {
    expect(fillBuildings(districts, blocksByDistrict, base))
      .toEqual(fillBuildings(districts, blocksByDistrict, base))
  })
  it('every building sits inside its block', () => {
    const { blocks, buildings } = fillBuildings(districts, blocksByDistrict, base)
    const byId = new Map(blocks.map((b) => [b.id, b.rect]))
    expect(buildings.length).toBeGreaterThan(0)
    for (const b of buildings) {
      const r = byId.get(b.blockId)!
      expect(b.rect.x).toBeGreaterThanOrEqual(r.x)
      expect(b.rect.y).toBeGreaterThanOrEqual(r.y)
      expect(b.rect.x + b.rect.w).toBeLessThanOrEqual(r.x + r.w + 1e-9)
      expect(b.rect.y + b.rect.h).toBeLessThanOrEqual(r.y + r.h + 1e-9)
    }
  })
  it('slum blocks are denser than corp blocks', () => {
    const { buildings } = fillBuildings(districts, blocksByDistrict, base)
    const corp = buildings.filter((b) => b.districtId === 'D01').length
    const slum = buildings.filter((b) => b.districtId === 'D02').length
    expect(slum).toBeGreaterThan(corp)
  })
  it('block and building ids encode district and block ordinals', () => {
    const { blocks, buildings } = fillBuildings(districts, blocksByDistrict, base)
    expect(blocks[0].id).toBe('B0101')
    expect(blocks.every((b) => /^B\d{4}$/.test(b.id))).toBe(true)
    expect(buildings.every((b) => /^BLD\d{6}$/.test(b.id))).toBe(true)
  })
  it('density knob raises building count', () => {
    const lo = fillBuildings(districts, blocksByDistrict, { ...base, density: 0 }).buildings.length
    const hi = fillBuildings(districts, blocksByDistrict, { ...base, density: 1 }).buildings.length
    expect(hi).toBeGreaterThanOrEqual(lo)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/gen/sector/buildings.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

`src/gen/sector/buildings.ts`:

```ts
import { bspSplit, insetRect, type Rect } from '../geometry'
import { hashSeed, mulberry32 } from '../rng'
import type { Block, Building, District, SectorParams, ZoneType } from '../types'

const ZONE_BUILD: Record<ZoneType, { minCell: number; fill: number }> = {
  corp: { minCell: 60, fill: 0.7 },
  residential: { minCell: 30, fill: 0.85 },
  slum: { minCell: 18, fill: 0.95 },
  industrial: { minCell: 80, fill: 0.8 },
  entertainment: { minCell: 35, fill: 0.85 },
  docks: { minCell: 70, fill: 0.75 },
}

const SIDEWALK = 6

export function fillBuildings(
  districts: District[],
  blocksByDistrict: Rect[][],
  params: SectorParams,
): { blocks: Block[]; buildings: Building[] } {
  const rng = mulberry32(hashSeed(params.seed, 'buildings'))
  const blocks: Block[] = []
  const buildings: Building[] = []

  districts.forEach((district, di) => {
    const profile = ZONE_BUILD[district.zone]
    const fill = profile.fill * (0.6 + 0.4 * params.density)
    const dd = String(di + 1).padStart(2, '0')

    ;(blocksByDistrict[di] ?? []).forEach((blockRect, bi) => {
      const blockId = `B${dd}${String(bi + 1).padStart(2, '0')}`
      blocks.push({ id: blockId, districtId: district.id, rect: blockRect })

      const lot = insetRect(blockRect, SIDEWALK)
      if (!lot) return
      const { cells } = bspSplit(lot, { minCell: profile.minCell, gap: 3, jitter: 0.25, rng })
      let n = 0
      for (const cell of cells) {
        if (!rng.chance(fill)) continue
        n += 1
        buildings.push({
          id: `BLD${dd}${String(bi + 1).padStart(2, '0')}${String(n).padStart(2, '0')}`,
          blockId,
          districtId: district.id,
          rect: cell,
        })
      }
    })
  })

  return { blocks, buildings }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/gen/sector/buildings.test.ts`
Expected: PASS. If "slum denser than corp" flakes for seed 42, the zone profiles are wrong — slum minCell 18 vs corp 60 must yield far more cells; do not weaken the test.

- [ ] **Step 5: Commit**

```bash
git add src/gen/sector/buildings.ts src/gen/sector/buildings.test.ts
git commit -m "feat: add zone-profiled building footprints"
```

---

### Task 10: POIs, naming, pipeline composition

**Files:**
- Create: `src/gen/sector/pois.ts`, `src/gen/sector/pois.test.ts`, `src/gen/sector/generate.ts`, `src/gen/sector/generate.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `placePois(districts: District[], buildings: Building[], pack: FlavorPack, params: SectorParams): Poi[]` — per district: `count = min(buildingCount, max(zoneHasTypes ? 1 : 0, round(buildingCount * 0.06 * params.poiDensity * 2)))`; buildings picked without replacement; POI type must list the district's zone; ids `P01…` in district order; own stream `hashSeed(seed, 'pois')`.
  - `generateSector(params: SectorParams): SectorModel` — the only public entry point of the sector generator. Composes: geography → roads → zones → district names → road names (highways+arterials) → buildings → POIs. Naming stream `hashSeed(seed, 'names')`.

- [ ] **Step 1: Write the failing tests**

`src/gen/sector/pois.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { getPack } from '../names/packs'
import type { Building, District, SectorParams } from '../types'
import { placePois } from './pois'

const base: SectorParams = {
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5,
  coast: false, river: false, pack: 'generic', theme: 'neon',
}
const districts: District[] = [
  { id: 'D01', zone: 'corp', name: 'Test Heights', bounds: { x: 0, y: 0, w: 600, h: 600 } },
]
const buildings: Building[] = Array.from({ length: 30 }, (_, i) => ({
  id: `BLD0101${String(i + 1).padStart(2, '0')}`,
  blockId: 'B0101',
  districtId: 'D01',
  rect: { x: i * 20, y: 0, w: 15, h: 15 },
}))

describe('placePois', () => {
  const pack = getPack('generic')
  it('is deterministic', () => {
    expect(placePois(districts, buildings, pack, base))
      .toEqual(placePois(districts, buildings, pack, base))
  })
  it('poi types match district zone and names are non-empty', () => {
    const pois = placePois(districts, buildings, pack, base)
    expect(pois.length).toBeGreaterThan(0)
    const validTypes = pack.poiTypes.filter((t) => t.zones.includes('corp')).map((t) => t.type)
    for (const p of pois) {
      expect(validTypes).toContain(p.type)
      expect(p.name.length).toBeGreaterThan(0)
      expect(p.at).toEqual({
        x: expect.any(Number),
        y: expect.any(Number),
      })
    }
  })
  it('poiDensity raises count; buildings never reused', () => {
    const lo = placePois(districts, buildings, pack, { ...base, poiDensity: 0.1 })
    const hi = placePois(districts, buildings, pack, { ...base, poiDensity: 1 })
    expect(hi.length).toBeGreaterThan(lo.length)
    expect(new Set(hi.map((p) => p.buildingId)).size).toBe(hi.length)
  })
})
```

`src/gen/sector/generate.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { GENERATOR_VERSION, type SectorParams } from '../types'
import { generateSector } from './generate'

const base: SectorParams = {
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5,
  coast: false, river: false, pack: 'generic', theme: 'neon',
}

describe('generateSector', () => {
  it('same params give deep-equal models', () => {
    expect(generateSector(base)).toEqual(generateSector(base))
  })
  it('different seeds give different models', () => {
    const a = generateSector(base)
    const b = generateSector({ ...base, seed: 43 })
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b))
  })
  it('meta carries seed, version and size in meters', () => {
    const m = generateSector(base)
    expect(m.meta).toMatchObject({ seed: 42, generatorVersion: GENERATOR_VERSION, sizeM: 4000 })
    expect(m.meta.params).toEqual(base)
  })
  it('every district has a name; highways and arterials are named', () => {
    const m = generateSector(base)
    for (const d of m.districts) expect(d.name.length).toBeGreaterThan(0)
    for (const r of m.roads) {
      if (r.class === 'street') expect(r.name).toBeNull()
      else expect((r.name ?? '').length).toBeGreaterThan(0)
    }
  })
  it('cross-references resolve', () => {
    const m = generateSector(base)
    const districtIds = new Set(m.districts.map((d) => d.id))
    const blockIds = new Set(m.blocks.map((b) => b.id))
    const buildingIds = new Set(m.buildings.map((b) => b.id))
    for (const b of m.blocks) expect(districtIds.has(b.districtId)).toBe(true)
    for (const b of m.buildings) expect(blockIds.has(b.blockId)).toBe(true)
    for (const p of m.pois) expect(buildingIds.has(p.buildingId)).toBe(true)
  })
  it('shadowrunish pack changes names but not geometry', () => {
    const a = generateSector(base)
    const b = generateSector({ ...base, pack: 'shadowrunish' })
    expect(a.blocks).toEqual(b.blocks)
    expect(a.buildings).toEqual(b.buildings)
    expect(a.districts.map((d) => d.bounds)).toEqual(b.districts.map((d) => d.bounds))
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/gen/sector/pois.test.ts src/gen/sector/generate.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write implementations**

`src/gen/sector/pois.ts`:

```ts
import type { FlavorPack } from '../names/names'
import { generateName } from '../names/names'
import { hashSeed, mulberry32 } from '../rng'
import type { Building, District, Poi, SectorParams } from '../types'

export function placePois(
  districts: District[],
  buildings: Building[],
  pack: FlavorPack,
  params: SectorParams,
): Poi[] {
  const rng = mulberry32(hashSeed(params.seed, 'pois'))
  const pois: Poi[] = []
  let n = 0

  for (const district of districts) {
    const candidates = buildings.filter((b) => b.districtId === district.id)
    const types = pack.poiTypes.filter((t) => t.zones.includes(district.zone))
    if (types.length === 0 || candidates.length === 0) continue
    const count = Math.min(
      candidates.length,
      Math.max(1, Math.round(candidates.length * 0.06 * params.poiDensity * 2)),
    )
    // draw without replacement
    const pool = [...candidates]
    for (let i = 0; i < count; i++) {
      const idx = rng.int(0, pool.length - 1)
      const building = pool.splice(idx, 1)[0]
      const typeDef = rng.pick(types)
      n += 1
      pois.push({
        id: `P${String(n).padStart(2, '0')}`,
        buildingId: building.id,
        districtId: district.id,
        type: typeDef.type,
        name: generateName(rng.pick(typeDef.namePatterns), pack.tables, rng),
        at: {
          x: building.rect.x + building.rect.w / 2,
          y: building.rect.y + building.rect.h / 2,
        },
      })
    }
  }
  return pois
}
```

`src/gen/sector/generate.ts`:

```ts
import { generateName } from '../names/names'
import { getPack } from '../names/packs'
import { hashSeed, mulberry32 } from '../rng'
import { GENERATOR_VERSION, type SectorModel, type SectorParams } from '../types'
import { fillBuildings } from './buildings'
import { genGeography } from './geography'
import { placePois } from './pois'
import { layoutRoads } from './roads'
import { assignZones } from './zoning'

export function generateSector(params: SectorParams): SectorModel {
  const sizeM = params.size * 1000
  const pack = getPack(params.pack)

  const water = genGeography(params, sizeM)
  const { roads, districtRects, blocksByDistrict } = layoutRoads(params, water, sizeM)
  const districts = assignZones(districtRects, params)

  // re-align blocksByDistrict to the sorted district order
  const rectKey = (r: { x: number; y: number }) => `${r.x}:${r.y}`
  const blockIndex = new Map(districtRects.map((r, i) => [rectKey(r), i]))
  const alignedBlocks = districts.map((d) => blocksByDistrict[blockIndex.get(rectKey(d.bounds))!])

  const nameRng = mulberry32(hashSeed(params.seed, 'names'))
  const namedDistricts = districts.map((d) => ({
    ...d,
    name: generateName(nameRng.pick(pack.districtPatterns), pack.tables, nameRng),
  }))
  const namedRoads = roads.map((r) =>
    r.class === 'street'
      ? r
      : { ...r, name: generateName(nameRng.pick(pack.streetPatterns), pack.tables, nameRng) },
  )

  const { blocks, buildings } = fillBuildings(namedDistricts, alignedBlocks, params)
  const pois = placePois(namedDistricts, buildings, pack, params)

  return {
    meta: { seed: params.seed, generatorVersion: GENERATOR_VERSION, params, sizeM },
    water,
    roads: namedRoads,
    districts: namedDistricts,
    blocks,
    buildings,
    pois,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: ALL tests pass (whole suite — this is the integration point).
Note: `shadowrunish pack changes names but not geometry` passes because naming uses its own rng stream — if it fails, a geometry stage is consuming from the name stream (or vice versa).

- [ ] **Step 5: Commit**

```bash
git add src/gen/sector/pois.ts src/gen/sector/pois.test.ts src/gen/sector/generate.ts src/gen/sector/generate.test.ts
git commit -m "feat: add poi placement and sector generation pipeline"
```

---

### Task 11: Themes + SVG renderer

**Files:**
- Create: `src/render/theme.ts`, `src/render/svg.ts`, `src/render/svg.test.ts`

**Interfaces:**
- Consumes: `SectorModel`, `ZoneType`, `RoadClass` from `../gen/types`.
- Produces:
  - `interface Theme { id: string; label: string; bg: string; water: string; districtFill: Record<ZoneType, string>; districtLabel: string; road: Record<RoadClass, string>; building: { fill: string; stroke: string }; poi: { marker: string; label: string }; scaleBar: string; glow: boolean }`
  - `themes: Record<string, Theme>` with `neon` and `print`; `getTheme(id: string): Theme` (falls back to neon).
  - `renderSector(model: SectorModel, theme: Theme): string` — complete standalone SVG document string (has `xmlns`, `viewBox="0 0 sizeM sizeM"`). Layer order: bg → water → district fills → buildings → roads → district labels → POI markers+labels → scale bar. Every building/district/poi element carries `data-id`. All text XML-escaped. Scale bar: 500 m for size < 5 km, else 1 km, labeled `500 m` / `1 km`.

- [ ] **Step 1: Write the failing test**

`src/render/svg.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { generateSector } from '../gen/sector/generate'
import type { SectorParams } from '../gen/types'
import { renderSector } from './svg'
import { getTheme, themes } from './theme'

const base: SectorParams = {
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5,
  coast: true, river: false, pack: 'generic', theme: 'neon',
}
const model = generateSector(base)

describe('renderSector', () => {
  it('is deterministic', () => {
    expect(renderSector(model, getTheme('neon'))).toBe(renderSector(model, getTheme('neon')))
  })
  it('is a standalone svg with metric viewBox', () => {
    const svg = renderSector(model, getTheme('neon'))
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(svg).toContain(`viewBox="0 0 ${model.meta.sizeM} ${model.meta.sizeM}"`)
  })
  it('renders every district, building and poi with data-id', () => {
    const svg = renderSector(model, getTheme('neon'))
    for (const d of model.districts) expect(svg).toContain(`data-id="${d.id}"`)
    for (const p of model.pois) expect(svg).toContain(`data-id="${p.id}"`)
    expect(svg.match(/data-id="BLD/g)!.length).toBe(model.buildings.length)
  })
  it('has a metric scale bar', () => {
    expect(renderSector(model, getTheme('neon'))).toContain('500 m')
    const big = generateSector({ ...base, size: 6 })
    expect(renderSector(big, getTheme('neon'))).toContain('1 km')
  })
  it('themes change output', () => {
    expect(renderSector(model, getTheme('neon'))).not.toBe(renderSector(model, getTheme('print')))
  })
  it('escapes xml in names', () => {
    const hacked = {
      ...model,
      districts: [{ ...model.districts[0], name: 'A & B <X>' }, ...model.districts.slice(1)],
    }
    const svg = renderSector(hacked, getTheme('neon'))
    expect(svg).toContain('A &amp; B &lt;X&gt;')
  })
  it('ships neon and print themes; getTheme falls back to neon', () => {
    expect(Object.keys(themes).sort()).toEqual(['neon', 'print'])
    expect(getTheme('nope').id).toBe('neon')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/render/svg.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write implementations**

`src/render/theme.ts`:

```ts
import type { RoadClass, ZoneType } from '../gen/types'

export interface Theme {
  id: string
  label: string
  bg: string
  water: string
  districtFill: Record<ZoneType, string>
  districtLabel: string
  road: Record<RoadClass, string>
  building: { fill: string; stroke: string }
  poi: { marker: string; label: string }
  scaleBar: string
  glow: boolean
}

const neon: Theme = {
  id: 'neon',
  label: 'Neon',
  bg: '#0a0a12',
  water: '#0d1b2e',
  districtFill: {
    corp: '#14203a',
    residential: '#1a1a2e',
    slum: '#241a1a',
    industrial: '#1f2418',
    entertainment: '#2a142e',
    docks: '#12262c',
  },
  districtLabel: '#7fdbff',
  road: { highway: '#ff2975', arterial: '#00e5ff', street: '#2a3550' },
  building: { fill: '#151d30', stroke: '#3a4a6b' },
  poi: { marker: '#ffe066', label: '#ffe066' },
  scaleBar: '#7fdbff',
  glow: true,
}

const print: Theme = {
  id: 'print',
  label: 'Print',
  bg: '#ffffff',
  water: '#dce8f0',
  districtFill: {
    corp: '#eef1f6',
    residential: '#f4f4f0',
    slum: '#f6efe9',
    industrial: '#eff3ea',
    entertainment: '#f5edf6',
    docks: '#e9f2f4',
  },
  districtLabel: '#333333',
  road: { highway: '#222222', arterial: '#555555', street: '#bbbbbb' },
  building: { fill: '#e2e2dc', stroke: '#88888a' },
  poi: { marker: '#b03030', label: '#222222' },
  scaleBar: '#222222',
  glow: false,
}

export const themes: Record<string, Theme> = { neon, print }

export function getTheme(id: string): Theme {
  return themes[id] ?? neon
}
```

`src/render/svg.ts`:

```ts
import type { SectorModel } from '../gen/types'
import type { Theme } from './theme'

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const n = (v: number) => String(Math.round(v * 100) / 100)

export function renderSector(model: SectorModel, theme: Theme): string {
  const S = model.meta.sizeM
  const out: string[] = []
  const fontD = S * 0.018
  const fontP = S * 0.011

  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" font-family="system-ui, sans-serif">`,
  )
  if (theme.glow) {
    out.push(
      '<defs><filter id="glow" x="-50%" y="-50%" width="200%" height="200%">',
      '<feGaussianBlur stdDeviation="8" result="b"/>',
      '<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>',
      '</filter></defs>',
    )
  }
  const glowAttr = theme.glow ? ' filter="url(#glow)"' : ''

  out.push(`<rect x="0" y="0" width="${S}" height="${S}" fill="${theme.bg}"/>`)

  if (model.water.kind !== 'none') {
    const pts = model.water.polygon.map((p) => `${n(p.x)},${n(p.y)}`).join(' ')
    out.push(`<polygon points="${pts}" fill="${theme.water}"/>`)
  }

  for (const d of model.districts) {
    const r = d.bounds
    out.push(
      `<rect data-id="${d.id}" x="${n(r.x)}" y="${n(r.y)}" width="${n(r.w)}" height="${n(r.h)}" fill="${theme.districtFill[d.zone]}"/>`,
    )
  }

  for (const b of model.buildings) {
    const r = b.rect
    out.push(
      `<rect data-id="${b.id}" x="${n(r.x)}" y="${n(r.y)}" width="${n(r.w)}" height="${n(r.h)}" fill="${theme.building.fill}" stroke="${theme.building.stroke}" stroke-width="1"/>`,
    )
  }

  for (const road of model.roads) {
    const pts = road.points.map((p) => `${n(p.x)},${n(p.y)}`).join(' ')
    const glow = road.class === 'street' ? '' : glowAttr
    out.push(
      `<polyline points="${pts}" fill="none" stroke="${theme.road[road.class]}" stroke-width="${road.width}"${glow}/>`,
    )
  }

  for (const d of model.districts) {
    const cx = d.bounds.x + d.bounds.w / 2
    const cy = d.bounds.y + d.bounds.h / 2
    out.push(
      `<text x="${n(cx)}" y="${n(cy)}" fill="${theme.districtLabel}" font-size="${n(fontD)}" text-anchor="middle" opacity="0.85"${glowAttr}>${esc(d.name)}</text>`,
    )
  }

  for (const p of model.pois) {
    out.push(
      `<circle data-id="${p.id}" cx="${n(p.at.x)}" cy="${n(p.at.y)}" r="${n(S * 0.004)}" fill="${theme.poi.marker}"${glowAttr}/>`,
      `<text x="${n(p.at.x + S * 0.006)}" y="${n(p.at.y - S * 0.004)}" fill="${theme.poi.label}" font-size="${n(fontP)}">${esc(p.name)}</text>`,
    )
  }

  const barM = model.meta.params.size < 5 ? 500 : 1000
  const barLabel = barM === 500 ? '500 m' : '1 km'
  const bx = S * 0.03
  const by = S * 0.97
  out.push(
    `<line x1="${n(bx)}" y1="${n(by)}" x2="${n(bx + barM)}" y2="${n(by)}" stroke="${theme.scaleBar}" stroke-width="${n(S * 0.003)}"/>`,
    `<text x="${n(bx)}" y="${n(by - S * 0.008)}" fill="${theme.scaleBar}" font-size="${n(fontP)}">${barLabel}</text>`,
  )

  out.push('</svg>')
  return out.join('')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/render/svg.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/
git commit -m "feat: add neon and print themes with svg renderer"
```

---

### Task 12: App UI — URL params, knobs, map view

**Files:**
- Create: `src/app/strings.ts`, `src/app/params.ts`, `src/app/params.test.ts`, `src/app/KnobPanel.tsx`, `src/app/MapView.tsx`
- Modify: `src/app/App.tsx`

**Interfaces:**
- Consumes: `generateSector`, `SectorParams`, `renderSector`, `getTheme`, `themes`, `packs`.
- Produces:
  - `paramsFromSearch(search: string, fallbackSeed: number): SectorParams` — missing/invalid values fall back to defaults; a missing seed takes `fallbackSeed` (caller generates one random seed on first visit).
  - `paramsToSearch(p: SectorParams): string`, `DEFAULTS: Omit<SectorParams, 'seed'>`.
  - `strings.en` — all UI labels.

- [ ] **Step 1: Write the failing codec test**

`src/app/params.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { DEFAULTS, paramsFromSearch, paramsToSearch } from './params'

describe('params codec', () => {
  it('round-trips', () => {
    const p = { ...DEFAULTS, seed: 4711, size: 6, coast: true, pack: 'shadowrunish' }
    expect(paramsFromSearch(paramsToSearch(p), 0)).toEqual(p)
  })
  it('empty search uses defaults and fallback seed', () => {
    expect(paramsFromSearch('', 123)).toEqual({ ...DEFAULTS, seed: 123 })
  })
  it('clamps and sanitizes garbage', () => {
    const p = paramsFromSearch('?size=999&density=7&seed=abc&corp=-3', 55)
    expect(p.seed).toBe(55)
    expect(p.size).toBeLessThanOrEqual(8)
    expect(p.density).toBeLessThanOrEqual(1)
    expect(p.corpDominance).toBeGreaterThanOrEqual(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/app/params.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write params codec + strings**

`src/app/params.ts`:

```ts
import type { SectorParams } from '../gen/types'

export const DEFAULTS: Omit<SectorParams, 'seed'> = {
  size: 4,
  density: 0.5,
  corpDominance: 0.5,
  poiDensity: 0.5,
  coast: false,
  river: false,
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
    coast: sp.get('coast') === '1',
    river: sp.get('river') === '1',
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
    coast: p.coast ? '1' : '0',
    river: p.river ? '1' : '0',
    pack: p.pack,
    theme: p.theme,
  })
  return `?${sp.toString()}`
}
```

`src/app/strings.ts`:

```ts
export const strings = {
  en: {
    appTitle: 'SprawlForge',
    toolTitle: 'Sector Generator',
    knobs: {
      seed: 'Seed',
      size: 'Sector size (km)',
      density: 'Density',
      corpDominance: 'Corp dominance',
      poiDensity: 'POI density',
      coast: 'Coast',
      river: 'River',
      pack: 'Flavor pack',
      theme: 'Theme',
      reroll: 'Reroll',
    },
    exports: {
      svg: 'Export SVG',
      png: 'Export PNG',
      pdf: 'Export PDF',
    },
  },
}

export const t = strings.en
```

- [ ] **Step 4: Run codec test to verify it passes**

Run: `npm test -- src/app/params.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the UI components (no unit tests — verified by browser pass below)**

`src/app/MapView.tsx`:

```tsx
import { useRef, useState } from 'react'

export function MapView({ svg }: { svg: string }) {
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 })
  const drag = useRef<{ x: number; y: number } | null>(null)

  return (
    <div
      style={{ flex: 1, overflow: 'hidden', cursor: drag.current ? 'grabbing' : 'grab' }}
      onWheel={(e) => {
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
        setView((v) => ({ ...v, zoom: Math.min(20, Math.max(0.2, v.zoom * factor)) }))
      }}
      onPointerDown={(e) => {
        drag.current = { x: e.clientX - view.x, y: e.clientY - view.y }
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        if (!drag.current) return
        setView((v) => ({ ...v, x: e.clientX - drag.current!.x, y: e.clientY - drag.current!.y }))
      }}
      onPointerUp={() => (drag.current = null)}
    >
      <div
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
          transformOrigin: '0 0',
          width: '100%',
          height: '100%',
        }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  )
}
```

`src/app/KnobPanel.tsx`:

```tsx
import type { SectorParams } from '../gen/types'
import { packs } from '../gen/names/packs'
import { themes } from '../render/theme'
import { t } from './strings'

interface Props {
  params: SectorParams
  onChange: (p: SectorParams) => void
  onReroll: () => void
}

function Slider(props: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
}) {
  return (
    <label style={{ display: 'block', marginBottom: 12 }}>
      {props.label}: {props.value}
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        style={{ width: '100%' }}
      />
    </label>
  )
}

export function KnobPanel({ params, onChange, onReroll }: Props) {
  const set = <K extends keyof SectorParams>(key: K, value: SectorParams[K]) =>
    onChange({ ...params, [key]: value })

  return (
    <div style={{ width: 260, padding: 16, overflowY: 'auto' }}>
      <h1 style={{ fontSize: 18 }}>{t.appTitle}</h1>
      <h2 style={{ fontSize: 14, opacity: 0.7 }}>{t.toolTitle}</h2>
      <button onClick={onReroll} style={{ width: '100%', padding: 8, margin: '12px 0' }}>
        {t.knobs.reroll}
      </button>
      <label style={{ display: 'block', marginBottom: 12 }}>
        {t.knobs.seed}
        <input
          type="number"
          value={params.seed}
          onChange={(e) => set('seed', Number(e.target.value) >>> 0)}
          style={{ width: '100%' }}
        />
      </label>
      <Slider label={t.knobs.size} value={params.size} min={2} max={8} step={1} onChange={(v) => set('size', v)} />
      <Slider label={t.knobs.density} value={params.density} min={0} max={1} step={0.1} onChange={(v) => set('density', v)} />
      <Slider label={t.knobs.corpDominance} value={params.corpDominance} min={0} max={1} step={0.1} onChange={(v) => set('corpDominance', v)} />
      <Slider label={t.knobs.poiDensity} value={params.poiDensity} min={0} max={1} step={0.1} onChange={(v) => set('poiDensity', v)} />
      <label style={{ display: 'block', marginBottom: 8 }}>
        <input type="checkbox" checked={params.coast} onChange={(e) => set('coast', e.target.checked)} /> {t.knobs.coast}
      </label>
      <label style={{ display: 'block', marginBottom: 12 }}>
        <input type="checkbox" checked={params.river} onChange={(e) => set('river', e.target.checked)} /> {t.knobs.river}
      </label>
      <label style={{ display: 'block', marginBottom: 12 }}>
        {t.knobs.pack}
        <select value={params.pack} onChange={(e) => set('pack', e.target.value)} style={{ width: '100%' }}>
          {Object.values(packs).map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </label>
      <label style={{ display: 'block', marginBottom: 12 }}>
        {t.knobs.theme}
        <select value={params.theme} onChange={(e) => set('theme', e.target.value)} style={{ width: '100%' }}>
          {Object.values(themes).map((th) => (
            <option key={th.id} value={th.id}>{th.label}</option>
          ))}
        </select>
      </label>
    </div>
  )
}
```

`src/app/App.tsx` (replace placeholder):

```tsx
import { useMemo, useState } from 'react'
import { generateSector } from '../gen/sector/generate'
import { hashSeed } from '../gen/rng'
import type { SectorParams } from '../gen/types'
import { renderSector } from '../render/svg'
import { getTheme } from '../render/theme'
import { KnobPanel } from './KnobPanel'
import { MapView } from './MapView'
import { paramsFromSearch, paramsToSearch } from './params'

// ponytail: crypto.getRandomValues is the one non-seeded random — first-visit seed only
function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]
}

export function App() {
  const [params, setParams] = useState<SectorParams>(() =>
    paramsFromSearch(window.location.search, randomSeed()),
  )

  const update = (p: SectorParams) => {
    setParams(p)
    window.history.replaceState(null, '', paramsToSearch(p))
  }

  const svg = useMemo(() => {
    const model = generateSector(params)
    return renderSector(model, getTheme(params.theme))
  }, [params])

  return (
    <div style={{ display: 'flex', height: '100vh', margin: 0 }}>
      <KnobPanel
        params={params}
        onChange={update}
        onReroll={() => update({ ...params, seed: hashSeed(params.seed, 'reroll') })}
      />
      <MapView svg={svg} />
    </div>
  )
}
```

- [ ] **Step 6: Verify in browser**

Run: `npm run dev` (in container; port 5173 is forwarded)
Check, in order:
1. Map renders on load, URL fills with `?seed=…&size=4…`.
2. Moving any slider re-renders the map and updates the URL.
3. Reroll changes the map; browser-back-then-forward is not required to work (replaceState).
4. Copying the URL into a new tab reproduces the identical map.
5. Theme select flips neon ↔ print. Pack select changes names only.
6. Wheel zooms, drag pans.

Expected: all six pass. Also run `npm test` — full suite green.

- [ ] **Step 7: Commit**

```bash
git add src/app/ index.html
git commit -m "feat: add sector tool ui with url state and pan-zoom viewport"
```

---

### Task 13: Exports — SVG, PNG, PDF

**Files:**
- Create: `src/app/exports.ts`
- Modify: `src/app/KnobPanel.tsx` (add export buttons), `src/app/App.tsx` (pass svg + size down), `package.json` (add deps)

**Interfaces:**
- Consumes: rendered SVG string; `t` strings.
- Produces:
  - `downloadSvg(svg: string, name: string): void`
  - `downloadPng(svg: string, scale: number, name: string): Promise<void>` — rasterizes at `2048 × scale` px (scale 1 | 2 | 4).
  - `downloadPdf(svg: string, name: string): Promise<void>` — A4 landscape, map fitted.

- [ ] **Step 1: Add dependencies**

Run: `npm install jspdf svg2pdf.js`
Expected: both added to `package.json` dependencies.

- [ ] **Step 2: Write implementation (browser-API module — no unit test; verified in browser)**

`src/app/exports.ts`:

```ts
import { jsPDF } from 'jspdf'
import 'svg2pdf.js'

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function downloadSvg(svg: string, name: string): void {
  download(new Blob([svg], { type: 'image/svg+xml' }), `${name}.svg`)
}

export async function downloadPng(svg: string, scale: number, name: string): Promise<void> {
  const px = 2048 * scale
  const img = new Image()
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    img.src = url
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = px
    canvas.height = px
    canvas.getContext('2d')!.drawImage(img, 0, 0, px, px)
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('png encode failed'))), 'image/png'),
    )
    download(blob, `${name}.png`)
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function downloadPdf(svg: string, name: string): Promise<void> {
  const el = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement
  // A4 landscape in mm: 297 x 210; fit square map into page height with margins
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
  const side = 190
  await doc.svg(el, { x: (297 - side) / 2, y: 10, width: side, height: side })
  doc.save(`${name}.pdf`)
}
```

- [ ] **Step 3: Wire buttons into the panel**

In `src/app/KnobPanel.tsx`, extend `Props` and render buttons after the theme select:

```tsx
interface Props {
  params: SectorParams
  onChange: (p: SectorParams) => void
  onReroll: () => void
  onExport: (kind: 'svg' | 'png' | 'pdf') => void
}
```

```tsx
      <div style={{ display: 'grid', gap: 8, marginTop: 16 }}>
        <button onClick={() => onExport('svg')}>{t.exports.svg}</button>
        <button onClick={() => onExport('png')}>{t.exports.png}</button>
        <button onClick={() => onExport('pdf')}>{t.exports.pdf}</button>
      </div>
```

In `src/app/App.tsx`, add the handler and pass it:

```tsx
import { downloadPdf, downloadPng, downloadSvg } from './exports'
```

```tsx
  const exportName = `sprawlforge-sector-${params.seed}`
  const onExport = (kind: 'svg' | 'png' | 'pdf') => {
    if (kind === 'svg') downloadSvg(svg, exportName)
    if (kind === 'png') void downloadPng(svg, 2, exportName)
    if (kind === 'pdf') void downloadPdf(svg, exportName)
  }
```

```tsx
      <KnobPanel
        params={params}
        onChange={update}
        onReroll={() => update({ ...params, seed: hashSeed(params.seed, 'reroll') })}
        onExport={onExport}
      />
```

- [ ] **Step 4: Verify in browser**

Run: `npm run dev`
Check: each button downloads a file; the SVG opens standalone in a browser tab; the PNG is 4096×4096; the PDF shows the map centered on A4 landscape. Also run `npm test` and `npm run build` — both green.

- [ ] **Step 5: Commit**

```bash
git add src/app/ package.json package-lock.json
git commit -m "feat: add svg png and pdf export"
```

---

### Task 14: Headless browser check (uicheck)

**Files:**
- Create: `tools/uicheck/run.sh`, `tools/uicheck/check.mjs`
- Modify: `package.json` (add `playwright` devDependency), `.gitignore` (ignore shots)

**Interfaces:**
- Consumes: the built app (`npm run build` + `vite preview`); UI selectors from Task 12/13 (`data-id="BLD…"` rects, `Reroll` button, labeled knobs).
- Produces: `tools/uicheck/run.sh` — one command that builds, serves, drives the app headless, asserts core behavior, writes screenshots to `tools/uicheck/shots/`. Exit code 0 = pass. Extend it whenever a feature adds or changes UI behavior.

- [ ] **Step 1: Add Playwright**

Run: `npm install -D playwright`
Expected: added to devDependencies. (Chromium itself downloads on first `run.sh` — not into the image.)

- [ ] **Step 2: Write the check script**

`tools/uicheck/check.mjs`:

```js
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4173'
const OUT = process.env.OUT_DIR ?? new URL('./shots', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const fail = (msg) => {
  console.error(`FAIL: ${msg}`)
  process.exitCode = 1
}

// fixed seed → reproducible assertions
await page.goto(
  `${BASE}/?seed=42&size=4&density=0.5&corp=0.5&poi=0.5&coast=1&river=0&pack=generic&theme=neon`,
)
await page.waitForSelector('svg')

const buildings = await page.locator('svg rect[data-id^="BLD"]').count()
if (buildings < 50) fail(`expected a dense map, got ${buildings} buildings`)

const pois = await page.locator('svg circle[data-id^="P"]').count()
if (pois < 1) fail('no POIs rendered')

// knob → URL round trip
await page.getByLabel(/Corp dominance/).fill('1')
if (!page.url().includes('corp=1')) fail('slider did not update url')

// reroll changes the map
const before = await page.locator('svg').innerHTML()
await page.getByRole('button', { name: 'Reroll' }).click()
const after = await page.locator('svg').innerHTML()
if (before === after) fail('reroll did not change map')

// theme switch, screenshot both
await page.getByLabel(/Theme/).selectOption('print')
await page.screenshot({ path: `${OUT}/print.png`, fullPage: true })
await page.getByLabel(/Theme/).selectOption('neon')
await page.screenshot({ path: `${OUT}/neon.png`, fullPage: true })

await browser.close()
console.log(process.exitCode ? 'uicheck FAILED' : 'uicheck passed')
```

`tools/uicheck/run.sh`:

```bash
#!/bin/bash
# Headless-browser UI pass: build, preview, drive with Playwright.
# Usage: tools/uicheck/run.sh   (from anywhere inside the repo)
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)
PORT=${PORT:-4173}
cd "$REPO"

# One-time per container: download the headless browser.
if [ ! -d "$HOME/.cache/ms-playwright" ]; then
  echo "Installing Chromium (one-time)…"
  npx playwright install --with-deps chromium
fi

npm run build
npx vite preview --port "$PORT" --strictPort >"$SCRIPT_DIR/app.log" 2>&1 &
APP=$!
trap 'kill $APP 2>/dev/null' EXIT
curl --retry-connrefused --retry 30 --retry-delay 1 -sf "http://127.0.0.1:$PORT/" >/dev/null \
  || { echo "preview never came up:"; tail -20 "$SCRIPT_DIR/app.log"; exit 2; }

BASE_URL="http://127.0.0.1:$PORT" OUT_DIR="$SCRIPT_DIR/shots" node "$SCRIPT_DIR/check.mjs"
```

Run: `chmod +x tools/uicheck/run.sh`

Append to `.gitignore`:

```
tools/uicheck/shots/
```

- [ ] **Step 3: Run it**

Run: `tools/uicheck/run.sh`
Expected: `uicheck passed`, exit 0, two screenshots in `tools/uicheck/shots/`. **Look at the screenshots** — don't just trust the exit code. If `getByLabel` misses a knob, the label markup in `KnobPanel.tsx` doesn't wrap its input — fix the component, not the selector.

- [ ] **Step 4: Commit**

```bash
git add tools/uicheck/run.sh tools/uicheck/check.mjs package.json package-lock.json .gitignore
git commit -m "test: add headless playwright ui check"
```

---

### Task 15: GitHub Pages deploy + README

**Files:**
- Create: `.github/workflows/deploy.yml`, `README.md`

- [ ] **Step 1: Write the workflow**

`.github/workflows/deploy.yml`:

```yaml
name: deploy

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm test
      - run: npm run build
      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 2: Write the README**

`README.md`:

```markdown
# SprawlForge

Free, open, static web toolkit for cyberpunk TTRPGs — system-agnostic,
Shadowrun-friendly. Procedural map generators with deterministic seeds:
share a URL, get the identical map.

**Live:** https://thomaslazar.github.io/sprawlforge/

## Tools

- **Sector generator** — a few km² of sprawl: roads, zoned districts,
  buildings, named POIs. Metric everywhere.
- Metroplex, battlemap and node-map generators: see `docs/ROADMAP.md`.

## Development

Everything runs in the devcontainer (VS Code → "Reopen in Container"):

    npm install
    npm run dev     # http://localhost:5173
    npm test
    npm run build   # static output in dist/

## Self-hosting

`npm run build`, then serve `dist/` with any static file server. The build
uses relative paths (`base: './'`), so any subpath works.

## Design docs

- `docs/specs/` — product and architecture specs
- `docs/plans/` — implementation plans
- `docs/ROADMAP.md` — deferred features

## License

MIT
```

- [ ] **Step 3: Verify**

Run: `npm run build && npx vite preview`
Expected: production build serves correctly at the preview URL.

- [ ] **Step 4: Commit**

```bash
git add .github/ README.md
git commit -m "ci: add github pages deploy workflow and readme"
```

Note: Pages must be enabled once in repo settings (Settings → Pages → Source: GitHub Actions). The workflow only triggers after the PR merges to `main`.

---

## Final verification (after all tasks)

- [ ] `npm test` — full suite green.
- [ ] `npm run build` — clean.
- [ ] `tools/uicheck/run.sh` — passes; inspect the screenshots.
- [ ] Manual browser pass per Task 12 Step 6 + Task 13 Step 4 (exports need a human eye).
- [ ] `git push` and open PR `spec/sprawlforge-design` → `main` (spec + plan + implementation reviewed as one unit). Present the PR URL as a clickable link.
