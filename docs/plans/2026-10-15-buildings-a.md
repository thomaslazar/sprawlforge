# Buildings Phase A (Lots and Shapes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every block is set back once per side, cut into lots along its streets (or used whole), and every building is a catalogue shape fitted into its lot's fit box, so footprints are parallel to their street, never clipped, never slivers, and open ground is drawn as parking, plaza, yard, green or pool.

**Architecture:** A new `src/gen/lots/` package replaces the lot pass of `src/gen/streets/lots.ts`: `setback.ts` (buildable polygon and sides), `fitbox.ts`, `strips.ts` (strip and corner lots, merge), `shapes.ts` (A1–A23), `composites.ts` (E1–E6), `fabrics.ts` (choice table and coherence), `layout.ts` (per-fabric placement, fillers), `landmarks.ts` (megablock core/hive, compound) and `index.ts` (`fillLots`). Tasks 1–8 add files beside the old pass without touching the model; Task 9 switches `generateSector` over in one step (types, `GENERATOR_VERSION` 10, old code deleted); Tasks 10–13 render, test at sector level, shoot and re-pin.

**Tech Stack:** TypeScript, vitest, clipper2-js via `src/gen/clip.ts`, Playwright uicheck (`PORT=4174 tools/uicheck/run.sh`).

**Spec:** `docs/specs/2026-10-15-buildings-design.md` §3 (R1–R34), §5 (T1–T17, "uicheck A"), §6, §7. Investigation: `temp/buildings/investigation.md`. Phase B (§4, T18–T22) is a separate plan.

## Global Constraints

- Branch `spec/buildings` (off main 5768aab); spec edits and implementation both land here; no PR, no push.
- Metric only. Conventional Commits, no `Co-Authored-By` / "Generated with" lines (check `git log -1 --format=%B`). `npx tsc -b --noEmit` before every commit.
- `GENERATOR_VERSION` 9 → 10 in Task 9 (the first task that changes output). Every seed re-rolls its buildings; pins are re-pinned once, in Task 13, with the comment `// buildings re-roll (v10)` and old → new values.
- Vitest: ONE process at a time, always `npx vitest run --dir src/<path> -t '<name>'` (never a bare file path: `temp/` holds copies). Kill stale `vite-node` by PID, never `pkill -f`. Never `git stash`; comparisons use worktrees under `temp/buildings/`.
- Ratchets only tighten. A pin moved by this work is reported with old/new values, never silently loosened; a test dodge is never a fix.
- No Node-only globals (`process.env`) in `src/`, not even uncommitted. Scratch goes in `temp/buildings/` (gitignored).
- Determinism: new streams are per block, `mulberry32(hashSeed(params.seed, '<name>', block.id))`, names `'fabric'`, `'lots'`, `'shapes'`, `'composites'`; `'megablocks'` and `'compound-lots'` stay (per block too); `'buildings'`, `'notches'` and `'frontage'` retire. The coherence cell value is `hashSeed(params.seed, 'fabric', i, j) / 2 ** 32`.
- Lots run after every road and block pass: no road, block, district or name test may move. If one does, it is a bug in this branch, not a re-roll.
- UI change → extend `tools/uicheck/check.mjs` in the same task, run `PORT=4174 tools/uicheck/run.sh` alone, and the controller opens the shots (the exit code alone never counts).
- Perf: P1 (seed 42 `coastal,medium,dense,fringe,lively,mixed,river`, 4 km) within +15 % of main, median of 3 via `temp/perf/time.mts` (main from `git worktree add temp/buildings/perf-main main`, removed afterwards). `perf.test.ts` (×2) is red on main too; not this round's.
- Math level: distances, angles, chances, weights. The user judges visually.
- Reference seeds (T4–T15, uicheck A), params exactly as in `generate.test.ts`:
  - **S42** `{ ...resolveTags(['coastal','medium','dense','fringe','lively','mixed','river','arcology']), seed: 42, size: 4, pack: 'generic', theme: 'print' }`
  - **S782** `{ ...base, seed: 782008753, size: 6, landform: 'inland', density: 0.6, corpDominance: 0.5, poiDensity: 0.5, irregularity: 0.5, river: true, lakes: true, islands: true, piers: true, pack: 'generic', theme: 'print' }`
  - **S426** `{ ...resolveTags(['inland','small','dense','balanced','quiet','sprawl','river']), seed: 426750495, size: 2, pack: 'generic', theme: 'print' }`
  - **S2268** `{ ...resolveTags(['coastal','medium','packed','balanced','quiet','planned']), seed: 2268324149, size: 4, pack: 'generic', theme: 'print' }`

Measured on main 5768aab (investigation, for the record): non-rectilinear A 35.8 %, B 31.0 %, C 45.1 %, D 26.8 %; < 60 m² 212 / 409 / 45 / 338; 3-vertex 49 / 127 / 37 / 72; megablock cells outside the core B 34.

Decisions this plan pins (the spec leaves them open):
- **Setback lookup:** an edge's class comes from its midpoint: roads within 2 m via a `RoadIndex` (street/frontage 7.5, ramp 7.0, arterial incl. K ring 12.0), the highway by `levelAt(highway.segments, nearestT(mid, highway.points).t)` (sunken 19.0, else 26.0; `nearestT` gets exported from `highway.ts`), water when `inWater` 3 m outward of the midpoint, window when `onWindowEdge(mid, sizeM, 2)`, landmark ground when within 2 m of a ground ring; several → the largest; none → 7.5. `generateSector` passes `hw[0]` (the highway with `segments`) as `highway`.
- **Positive-fill union:** `clip.ts` gains `unionPositive(ring: Ring): MultiPolygon` (FillRule.Positive, ring loaded as given, no reorientation). `buildable` makes the ring counter-clockwise first.
- **Sides of a piece:** each buildable edge takes the setback of the footprint edge whose offset line holds its midpoint (± 0.05 m); the two-point bisector joins take the previous edge's. Chains break at turns ≥ 25° and at setback changes.
- **Strip cutting:** widths drawn along the side's arc length until the rest is < the maximum width; a rest ≥ the minimum width is the last lot, a smaller rest widens the previous lot. A lot on a single edge of an untrimmed strip is computed as a quad; only lots spanning a side vertex or touching a trim go through `clip.intersection` (perf). A strip lot's chord is the part of its side inside it; a corner lot "fitting normally" uses its longer frontage edge.
- **Fit box search:** in the chord frame, the lot's cross-section is sampled at every 1 m grid x and at every vertex x (the first interval from the front); for each x0 the scan over x1 keeps a running max of the front and min of the back, so a lot of G grid columns costs O(G·V + G²). Lots wider than 120 m use a 2 m grid, then refine x0 and x1 at 1 m within ± 2 m of the best.
- **Acceptance gate (safety net for T4–T6):** `index.ts` drops any non-arc building with an edge < 3 m, a T5 width < 6 m or area < 60 m²; its lot becomes its filler kind. Rejections are counted per seed in Task 13's measurement; a template that is rejected at all is a bug in that template.
- **Fabric order:** the cumulative draw walks each R19 row in the order printed; the R21 fallback walks the row sorted by weight descending (stable on row order) from the drawn fabric down, then `rows`.
- **Arcs** (shapes, composite bays, details) are polygonised per R25: 24 per circle, 12 per semicircle, 6 per quarter. An ellipse (A13) uses 24 points.
- **Whole-block lots:** each buildable piece is one lot (kind by R30 with the fabric's filler) holding all its buildings; `bigbox` splits it at the hall's front line into a `parking` lot (front) and a `yard` lot holding the hall. A non-ring arcology's home block that draws `plaza` takes `perimeter` (keeps `non-ring arcology blocks keep lots outside the plaza`); a ring-access plaza block gets one `plaza` lot per piece, no buildings.
- **Strip fabric:** strips only on sides with setback 7.5 (the frontage road); the rest of the piece is one `yard` filler.
- **Megablock ring:** outer strips from the buildable's sides, inner strips outward from the edges of core + 6 m (the `holes` option of `stripLots`); the rest of the ring is one `yard` lot. Hive cells failing the acceptance gate become `plaza` lots. `Megablock.core` and `.footprint` are both the new core.
- **Garage (F14):** building 60 × 40 front-aligned and centred; details a circle Ø 20 and a circle Ø 4 (20 − 2 × 8) at one short end; lot `parking`.
- **Parking stripes:** angle = the lot's longest edge, rounded to 5°; lines perpendicular to it.
- **Alleys:** `Block.alleys` is filled for megablocks only, so the generic alley path in `svg.ts` and its tests go (megablock alleys stay in `renderLandmarks`).
- **Kept from `lots.ts`:** `SIDEWALK`, `insetRing`, `insetByClipping`, `insetOrLargest`, `longestEdgeAngle`, `clipSegmentToRing`, `isStripBlock`, `isLandmarkBlock` (infill, compounds and the compound renderer use them). Everything else in it goes in Task 9.

## Review Focus

1. A concave (L or U) block whose strips meet at a reflex corner must not get overlapping lots: Task 3 test `reflex corner strips do not overlap`.
2. A curved arterial side (many vertices turning < 25° each) must give lots that tile it without gaps, overlaps or slanted buildings: Task 3 test `lots along a curved side`.
3. A shore block with a clockwise, 200-vertex footprint must give a valid buildable, not a spike or an empty result: Task 1 test `clockwise dense shore ring`.
4. A block narrower than its fabric's strip depth (or under 200 m² once set back) yields at most one lot and no crash: Task 3 test `a block narrower than the strip depth`.
5. A megablock in a block too small for its octagon must still get a core inside the block (the fit-box fallback), with every hive cell inside it: Task 8 test `a small megablock block falls back to the fit-box core`.

---

### Task 1: setback per side, buildable polygon, sides

**Files:**
- Create: `src/gen/lots/setback.ts`, `src/gen/lots/setback.test.ts`
- Modify: `src/gen/clip.ts` (`unionPositive`), `src/gen/streets/highway.ts` (export `nearestT`)

**Interfaces:**
- Produces:
  - `export const SETBACK = { street: 7.5, ramp: 7.0, arterial: 12.0, sunken: 19.0, highway: STRIP_HALF, water: 5.0, window: 0, ground: 6.0, other: 7.5 }`
  - `export interface SetbackCtx { index: RoadIndex; highway?: Road; terrain: Terrain; sizeM: number; grounds: Pt[][] }` (the index holds every non-highway road with its class)
  - `export function edgeSetbacks(footprint: Pt[], ctx: SetbackCtx): number[]` (one per edge i → i+1, footprint simplified by the caller)
  - `export function buildable(footprint: Pt[], setbacks: number[]): Pt[][]` (R3; CCW pieces ≥ 200 m²)
  - `export interface Side { pts: Pt[]; chord: [Pt, Pt]; setback: number }`
  - `export function sidesOf(piece: Pt[], edgeSetback?: number[]): Side[]` (R4; absent → one class)
  - `export function pieceSetbacks(piece: Pt[], footprint: Pt[], setbacks: number[]): number[]`

- [ ] **Step 1: Write the failing tests** (`describe('setback per side')`, T1; reuse the `rectPoly`, `dryTerrain` and bay-terrain helpers of `lots.test.ts` by copying them into a `src/gen/lots/fixtures.ts` test helper)

```ts
it('street, arterial, water and window edges', () => {
  const fp = rectPoly(0, 0, 200, 120)                         // S along y 0, A along x 200, water y > 120, window x 0 (sizeM 200)
  expect(edgeSetbacks(fp, ctx)).toEqual([7.5, 12, 5, 0])
  const [b] = buildable(fp, [7.5, 12, 5, 0])
  expectBox(b, { x0: 0, y0: 7.5, x1: 188, y1: 115 }, 0.01)
})
it('a reflex vertex joins on its bisector', () => {
  const L = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 50, y: 50 }, { x: 50, y: 100 }, { x: 0, y: 100 }]
  const [b] = buildable(L, [7.5, 7.5, 12, 12, 7.5, 7.5])
  const onBis = b.filter((p) => Math.abs((p.x - 50) - (p.y - 50)) < 0.01 && p.x > 50)
  expect(onBis).toHaveLength(2)                                // the two lines end on the bisector of (50, 50)
})
it('a 175° vertex makes no spike', () => {
  const fp = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 8.75 }, { x: 200, y: 120 }, { x: 0, y: 120 }]
  for (const p of buildable(fp, [7.5, 26, 7.5, 7.5, 7.5])[0]) expect(distToRing(p, fp)).toBeLessThanOrEqual(2 * 26 + 0.01)
})
it('clockwise dense shore ring', () => {
  const shore = circleRing({ x: 0, y: 0 }, 150, 200).reverse()  // 200 vertices, clockwise
  const out = buildable(shore, shore.map(() => 5))
  expect(out).toHaveLength(1); expect(ringArea(out[0])).toBeGreaterThan(0)
  expect(Math.abs(ringArea(out[0]) - Math.PI * 145 ** 2)).toBeLessThan(0.01 * Math.PI * 145 ** 2)
})
it('sides break at 25° and at a class change', () => {
  const s = sidesOf(rectPoly(0, 0, 100, 60), [7.5, 7.5, 12, 7.5])
  expect(s.map((x) => x.setback)).toEqual([7.5, 7.5, 12, 7.5]); expect(sidesOf(circleRing({ x: 0, y: 0 }, 100, 72))).toHaveLength(1)
})
```
- [ ] **Step 2: Run** `npx vitest run --dir src/gen/lots -t 'setback per side|sides break'`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `setback.ts` per R1–R4 and the pinned lookup; `unionPositive` in `clip.ts`; export `nearestT`.
- [ ] **Step 4: Run** the same command, then `npx vitest run --dir src/gen -t 'clip'`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: per-side setback and buildable polygon for lots`

### Task 2: fit box

**Files:** Create `src/gen/lots/fitbox.ts`, `src/gen/lots/fitbox.test.ts`

**Interfaces:**
- Produces: `export interface FitBox { origin: Pt; angle: number; w: number; d: number }` (origin = front-left corner, x along the chord at `angle`, y inward); `export function fitBox(lot: Pt[], chord: [Pt, Pt]): FitBox`; `export function boxRing(b: FitBox): Pt[]`; `export const holds = (b: FitBox, w: number, d: number): boolean` (either orientation); `export function widthOk(poly: Pt[], min: number): boolean` (T5 probe: from every edge midpoint the inward normal runs ≥ `min` before meeting another edge).

- [ ] **Step 1: Write the failing tests**

```ts
it('fit box', () => {                                           // T2: front arc of 10° bulging into the lot, sagitta 0.437 m
  const lot = [...arc({ x: 0, y: 0 }, { x: 20, y: 0 }, 10, 6, 'inward'), { x: 20, y: 30 }, { x: 0, y: 30 }]
  const b = fitBox(lot, [{ x: 0, y: 0 }, { x: 20, y: 0 }])
  expect(Math.abs(b.w - 20)).toBeLessThanOrEqual(1); expect(Math.abs(b.d - 29.563)).toBeLessThanOrEqual(1)
  for (const p of boxRing(b)) expect(insideOrOn(p, lot, 0.05)).toBe(true)
})
it('fit box of a trapezoid keeps the front on the innermost frontage point', () => {
  const b = fitBox([{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 20 }, { x: 0, y: 30 }], [{ x: 0, y: 0 }, { x: 30, y: 0 }])
  expect(b.w * b.d).toBeGreaterThanOrEqual(30 * 20 - 30)       // 1 m grid
})
it('fit box of a 600 × 400 m lot', () => {
  const t = performance.now(), b = fitBox(rectPoly(0, 0, 600, 400), [{ x: 0, y: 0 }, { x: 600, y: 0 }])
  expect(b.w).toBeGreaterThanOrEqual(599); expect(b.d).toBeGreaterThanOrEqual(399); expect(performance.now() - t).toBeLessThan(200)
})
it('widthOk', () => { expect(widthOk(rectPoly(0, 0, 6, 20), 6)).toBe(true); expect(widthOk(rectPoly(0, 0, 5, 20), 6)).toBe(false) })
```
- [ ] **Step 2: Run** `npx vitest run --dir src/gen/lots -t 'fit box|widthOk'`. Expected: FAIL.
- [ ] **Step 3: Implement** per R10 and the pinned search.
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat: fit box, the largest chord-aligned rectangle in a lot`

### Task 3: strip lots, corner lots, merge

**Files:** Create `src/gen/lots/strips.ts`, `src/gen/lots/strips.test.ts`

**Interfaces:**
- Consumes: `Side`, `sidesOf` (Task 1); `fitBox`, `holds` (Task 2).
- Produces:
  - `export interface StripParams { depth: number; width: [number, number]; gap: [number, number] | null; sides?: (s: Side[]) => number[] }` (`sides` picks which side indices get strips; default all)
  - `export interface StripLot { poly: Pt[]; chord: [Pt, Pt]; side: number; corner?: number; filler?: boolean }` (`corner` = θ in degrees; `filler` = gap, interior or failed merge)
  - `export function stripLots(piece: Pt[], sides: Side[], p: StripParams, rng: Rng, holes?: Pt[][]): StripLot[]` (R5–R7, R9, R12; `holes` edges become outward-facing sides)
  - Task 7 adds `export function frontageLots(piece: Pt[], fabric: BlockStyle, rng: Rng): Pt[][]` here (§3.9, for phase B) = `stripLots(piece, sidesOf(piece), STRIP_PARAMS[fabric](rng), rng).map((l) => l.poly)`

- [ ] **Step 1: Write the failing tests** (fixed params `P = { depth: 16, width: [10, 18], gap: null }`)

```ts
it('strips on a rectangle', () => {
  const lots = stripLots(rectPoly(0, 0, 100, 60), sidesOf(rectPoly(0, 0, 100, 60)), P, mulberry32(1))
  const corners = lots.filter((l) => l.corner !== undefined)
  expect(corners).toHaveLength(4); for (const c of corners) { expect(c.corner).toBeCloseTo(90, 6); expectBox(c.poly, 16, 16, 0.01) }
  expect(pairOverlapMax(lots.map((l) => l.poly))).toBeLessThanOrEqual(0.5)
  expect(Math.abs(lots.filter((l) => l.filler).reduce((a, l) => a + ringArea(l.poly), 0) - 68 * 28)).toBeLessThan(1)
  for (const l of lots.filter((l) => !l.filler && l.corner === undefined)) expect(frontage(l)).toBeGreaterThanOrEqual(10)
})
it('reflex corner strips do not overlap', () => {
  const L = lShape(120, 120, 60)                                  // 120 × 120 with a 60 × 60 bite
  expect(pairOverlapMax(stripLots(L, sidesOf(L), P, mulberry32(2)).map((l) => l.poly))).toBeLessThanOrEqual(0.5)
})
it('lots along a curved side', () => {
  const piece = [...arcSide({ x: 0, y: 0 }, 200, 60, 12), { x: 0, y: 150 }]   // 12 vertices, 5° per turn
  const lots = stripLots(piece, sidesOf(piece), P, mulberry32(3)).filter((l) => !l.filler)
  expect(pairOverlapMax(lots.map((l) => l.poly))).toBeLessThanOrEqual(0.5)
  for (const l of lots) expect(holds(fitBox(l.poly, l.chord), 6, 8)).toBe(true)
})
it('a lot too narrow for 6 × 8 merges into its neighbour', () => {
  const lots = stripLots(rectPoly(0, 0, 37.5, 60), sidesOf(rectPoly(0, 0, 37.5, 60)), { ...P, width: [5.5, 5.5] }, mulberry32(4))
  for (const l of lots.filter((l) => !l.filler)) expect(holds(fitBox(l.poly, l.chord), 6, 8)).toBe(true)
})
it('acute corner lot', () => {
  const tri = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 * Math.tan((40 * Math.PI) / 180) }]
  expect(stripLots(tri, sidesOf(tri), P, mulberry32(5)).some((l) => Math.abs((l.corner ?? 0) - 40) < 0.5)).toBe(true)
})
it('a block narrower than the strip depth', () => {
  expect(stripLots(rectPoly(0, 0, 100, 12), sidesOf(rectPoly(0, 0, 100, 12)), P, mulberry32(6)).filter((l) => !l.filler).length).toBeLessThanOrEqual(1)
})
```
- [ ] **Step 2: Run** `npx vitest run --dir src/gen/lots -t 'strips on|reflex corner|curved side|merges into|acute corner|narrower than'`. Expected: FAIL.
- [ ] **Step 3: Implement** per R5–R9, R12 and the pinned cutting rule.
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat: strip and corner lots along block sides`

### Task 4: shape catalogue A1–A23

**Files:** Create `src/gen/lots/shapes.ts`, `src/gen/lots/shapes.test.ts`; Modify `src/gen/types.ts` (`BlockStyle` gains the §3.9 values; `courtyard` stays until Task 9 so the old pass compiles)

**Interfaces:**
- Consumes: `FitBox`, `boxRing` (Task 2).
- Produces:
  - `export type SheetZone = 'residential' | 'mixed' | 'commerce' | 'corp' | 'industrial' | 'fringe'`; `export type DensityClass = 'sparse' | 'dense' | 'packed'`
  - `export interface ShapeDef { aspect: [number, number] | null; minW: number; minD: number; minArea?: number; zones: SheetZone[] | 'any'; density: DensityClass[] | 'any'; rarity: 1 | 0.35 | 0.08 }`; `export const SHAPES: Record<string, ShapeDef>` (the §3.6 table verbatim)
  - `export const CURVED_OR_SLANTED: ReadonlySet<string>` (R25 set: A11 A12 A13 A15 A16 A17 A21 A22 A23)
  - `export function fitShape(id: string, box: FitBox, rng: Rng): { footprint: Pt[]; details: Pt[][] }` (template filling `box` exactly; rng only for the 0.5 mirror and A19's tower count/kinds)
  - `export function chooseShape(allowed: string[], zone: SheetZone, density: DensityClass, fit: FitBox, rng: Rng): string | null` (R23)
  - `export function sizeShape(id: string, fit: FitBox, mode: 'continuous' | 'detached' | 'villas' | 'gapped', rng: Rng): FitBox | null` (R24, returns the sub-box; null after 3 redraw failures, caller falls back to A1 at 0.85 × fit box)
  - `export function cornerShape(quad: Pt[], thetaDeg: number, fabric: BlockStyle, continuous: boolean, area: number): { id: 'A4' | 'A15' | 'A16' | null; footprint?: Pt[] }` (R26; `null` → plaza filler, A4 and normal fits signal the caller to fit)

- [ ] **Step 1: Write the failing tests**

```ts
it('templates are rectilinear', () => {                          // T3
  const r = mulberry32(7)
  for (const [id, s] of Object.entries(SHAPES)) {
    if (CURVED_OR_SLANTED.has(id) || id === 'A15' || id === 'A16') continue
    for (let k = 0; k < 20; k++) {
      const w = s.minW + r.int(0, 40), d = s.aspect && s.aspect[0] === s.aspect[1] ? w : s.minD + r.int(0, 40)
      const { footprint } = fitShape(id, { origin: { x: 10, y: 5 }, angle: 0.3, w, d }, r)
      for (const a of interiorAngles(footprint)) expect(Math.min(Math.abs(a - 90), Math.abs(a - 270)), `${id} ${w}×${d}`).toBeLessThanOrEqual(1)
      for (const p of footprint) expect(insideOrOn(p, boxRing({ origin: { x: 10, y: 5 }, angle: 0.3, w, d }), 0.05)).toBe(true)
    }
  }
})
it('every template is counter-clockwise, ≥ 3 m per edge and ≥ 6 m wide at its min size', () => {
  for (const [id, s] of Object.entries(SHAPES)) if (id !== 'A15' && id !== 'A16') {
    const f = fitShape(id, { origin: { x: 0, y: 0 }, angle: 0, w: s.minW, d: s.minD }, mulberry32(1)).footprint
    expect(ringArea(f)).toBeGreaterThan(0); expect(minNonArcEdge(f)).toBeGreaterThanOrEqual(3); expect(widthOk(f, 6), id).toBe(true)
  }
})
it('arcs use 24 segments per circle', () => {
  expect(fitShape('A12', { origin: { x: 0, y: 0 }, angle: 0, w: 20, d: 20 }, mulberry32(1)).footprint).toHaveLength(24)
})
it('shape choice respects min size and the fabric list', () => {
  const box = { origin: { x: 0, y: 0 }, angle: 0, w: 12, d: 14 }
  for (let s = 0; s < 200; s++) expect(['A1', 'A2']).toContain(chooseShape(['A1', 'A2', 'A4', 'A9'], 'residential', 'dense', box, mulberry32(s)))
})
it('corner rule', () => {
  expect(cornerShape(q90, 90, 'perimeter', true, 400).id).toBe('A4'); expect(cornerShape(q65, 65, 'perimeter', true, 400).id).toBe('A15')
  expect(cornerShape(q40, 40, 'rows', false, 1600).id).toBe('A16'); expect(cornerShape(q40, 40, 'rows', false, 1400).id).toBeNull()
})
```
- [ ] **Step 2: Run** `npx vitest run --dir src/gen/lots -t 'templates are rectilinear|every template|arcs use|shape choice|corner rule'`. Expected: FAIL.
- [ ] **Step 3: Implement** the table, the 23 templates (local w × d frame, then rotate by `angle` about `origin`; mirror flips x), R23, R24, R26. A9's hole and A18's teeth (every 8 m parallel to the short side) and A19's towers are `details`.
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat: building shape catalogue A1-A23 fitted into fit boxes`

### Task 5: composites E1–E6

**Files:** Create `src/gen/lots/composites.ts`, `src/gen/lots/composites.test.ts`

**Interfaces:**
- Consumes: `fitShape`, `SheetZone`, `DensityClass` (Task 4); `clip.union`.
- Produces: `export const COMPOSITES: Record<'E1' | … | 'E6', { bodies: string[]; zones: SheetZone[]; density: DensityClass[]; rarity: number; inside: boolean }>`; `export function compositeChance(fabric: BlockStyle, zone: SheetZone): number` (R27 order: villas 0.5, detached 0.3, corp/commerce 0.25, industrial 0.3, else 0.1); `export function makeComposite(fit: FitBox, zone: SheetZone, density: DensityClass, continuous: boolean, rng: Rng): { shape: string; footprint: Pt[]; details: Pt[][] } | null`.

- [ ] **Step 1: Write the failing tests**

```ts
it('composite parts stay in the fit box, on a 2 m grid, ≥ 6 m', () => {
  for (let s = 0; s < 300; s++) for (const zone of ['residential', 'corp', 'industrial', 'fringe'] as const) {
    const fit = { origin: { x: 0, y: 0 }, angle: 0, w: 40, d: 36 }, c = makeComposite(fit, zone, zone === 'corp' ? 'packed' : 'sparse', false, mulberry32(s))
    if (!c) continue
    for (const p of [...c.footprint, ...c.details.flat()]) expect(insideOrOn(p, boxRing(fit), 0.05)).toBe(true)
    expect(widthOk(c.footprint, 6)).toBe(true); expect(c.shape).toMatch(/^E[1-6]$/)
  }
})
it('continuous fabrics take only E3 and E5', () => {
  for (let s = 0; s < 300; s++) { const c = makeComposite(box60x40, 'corp', 'packed', true, mulberry32(s)); if (c) expect(['E3', 'E5']).toContain(c.shape) }
})
it('outside parts union rectilinearly; inside parts are details', () => {
  const e6 = firstWith('E6'), e3 = firstWith('E3')                // helpers draw seeds until that id comes up
  expect(interiorAngles(e6.footprint).every((a) => near90or270(a))).toBe(true); expect(e3.details).toHaveLength(2)
})
```
- [ ] **Step 2: Run** `npx vitest run --dir src/gen/lots -t 'composite parts|continuous fabrics take|outside parts'`. Expected: FAIL.
- [ ] **Step 3: Implement** per R27–R28 (body shrunk by the parts' overhang; parts snapped to 2 m; union in the box's local frame).
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat: composite buildings from a fixed part list`

### Task 6: fabric choice

**Files:** Create `src/gen/lots/fabrics.ts`, `src/gen/lots/fabrics.test.ts`

**Interfaces:**
- Produces: `export function densityClass(d: number): DensityClass` (< 0.35 sparse, < 0.65 dense, else packed); `export function sheetZone(zone: ZoneType, dc: DensityClass): SheetZone` (R18); `export const FABRIC_WEIGHTS: Record<string, Array<[BlockStyle, number]>>` keyed `'residential sparse'`, …, `'mixed dense'` (= packed row), `'commerce'`, `'corp'`, `'industrial'`, `'fringe'`; `export const MIN_FIT: Partial<Record<BlockStyle, [number, number]>>` (R21); `export function fabricCell(seed: number, p: Pt): number`; `export function chooseFabric(zone: SheetZone, dc: DensityClass, cell: number, rng: Rng, fits: (f: BlockStyle) => boolean): BlockStyle` (R20–R21).

- [ ] **Step 1: Write the failing tests**

```ts
it('fabric weights sum to 100', () => { for (const [k, row] of Object.entries(FABRIC_WEIGHTS)) expect(row.reduce((a, [, w]) => a + w, 0), k).toBe(100) })
it('fabric shares follow the weights', () => {
  const n = 20000, got = new Map<string, number>()
  for (let i = 0; i < n; i++) { const f = chooseFabric('commerce', 'dense', (i * 0.6180339887) % 1, mulberry32(i), () => true); got.set(f, (got.get(f) ?? 0) + 1) }
  for (const [f, w] of FABRIC_WEIGHTS['commerce']) expect(Math.abs((got.get(f) ?? 0) / n - w / 100), f).toBeLessThan(0.015)
})
it('blocks in one cell agree at least 60 % of the time', () => {
  let same = 0; for (let i = 0; i < 2000; i++) same += +(chooseFabric('corp', 'dense', 0.37, mulberry32(2 * i), () => true) === chooseFabric('corp', 'dense', 0.37, mulberry32(2 * i + 1), () => true))
  expect(same / 2000).toBeGreaterThanOrEqual(0.6)
})
it('fallback walks down the row, finally rows', () => {
  expect(chooseFabric('corp', 'dense', 0.01, mulberry32(1), (f) => f !== 'podium')).toBe('tower-park')
  expect(chooseFabric('corp', 'dense', 0.01, mulberry32(1), (f) => f === 'rows')).toBe('rows')
})
it('sheet zones', () => {
  expect(sheetZone('slum', 'sparse')).toBe('fringe'); expect(sheetZone('slum', 'packed')).toBe('mixed')
  expect(sheetZone('entertainment', 'sparse')).toBe('mixed'); expect(sheetZone('entertainment', 'dense')).toBe('commerce')
  expect(sheetZone('docks', 'dense')).toBe('industrial'); expect(densityClass(0.35)).toBe('dense'); expect(densityClass(0.65)).toBe('packed')
})
```
- [ ] **Step 2: Run** `npx vitest run --dir src/gen/lots -t 'fabric weights|fabric shares|one cell agree|fallback walks|sheet zones'`. Expected: FAIL.
- [ ] **Step 3: Implement** per R18–R21 and the pinned order.
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat: fabric choice by sheet zone, density and 500 m coherence`

### Task 7: per-fabric layout and fillers

**Files:** Create `src/gen/lots/layout.ts`, `src/gen/lots/layout.test.ts`; Modify `src/gen/lots/strips.ts` (add `frontageLots`); Modify `src/gen/types.ts` (add `LotKind`, `Lot` per §3.9; not yet on `SectorModel`)

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces:
  - `export interface LotOut { poly: Pt[]; kind: LotKind; buildings: Array<{ shape: string; footprint: Pt[]; details: Pt[][] }> }`
  - `export interface BlockCtx { zone: SheetZone; density: DensityClass; rng: { lots: Rng; shapes: Rng; composites: Rng } }`
  - `export const STRIP_PARAMS: Partial<Record<BlockStyle, (rng: Rng) => StripParams>>` (§3.4 D, frontage, gap; terrace's `sides` per R13; strip's per the pinned rule)
  - `export function layoutPiece(piece: Pt[], sides: Side[], fabric: BlockStyle, ctx: BlockCtx): LotOut[]` (every §3.4 fabric except `megablock` and `compound`; R13–R15, R23–R30; `pool` lots per R29)
  - `export function lotKind(lot: Pt[], buildings: Pt[][], filler: LotKind): LotKind` (R30)
  - `export function fillerOf(fabric: BlockStyle, zone: SheetZone, where: 'interior' | 'gap' | 'corner' | 'margin' | 'apron'): LotKind` (R29)

- [ ] **Step 1: Write the failing tests** (block `rectPoly(0, 0, 160, 120)`, sides all 7.5; one test per claim)

```ts
const FABRICS = ['perimeter', 'terrace', 'shophouse', 'rows', 'zeilen', 'detached', 'villas', 'tower-park', 'podium', 'bigbox', 'sheds', 'plaza', 'garage', 'strip'] as const
it('every fabric keeps buildings inside their lots and lots inside the piece', () => {
  for (const f of FABRICS) for (let s = 0; s < 10; s++) {
    const out = layoutPiece(piece, sides, f, ctx(s, f === 'bigbox' || f === 'sheds' ? 'industrial' : 'residential'))
    for (const l of out) { expect(insideRing(l.poly, piece, 0.05), f).toBe(true); for (const b of l.buildings) expect(insideRing(b.footprint, l.poly, 0.05), `${f} ${b.shape}`).toBe(true) }
    expect(pairOverlapMax(out.filter((l) => l.kind !== 'pool').map((l) => l.poly)), f).toBeLessThanOrEqual(0.5)
  }
})
it('continuous fronts touch', () => { /* perimeter: consecutive strip buildings on one side share an edge within 0.05 m */ })
it('terrace builds on two antiparallel sides and leaves green', () => { /* buildings only within 12 m of y 0 and y 120; ≥ 1 green lot */ })
it('zeilen slabs are 12 m deep, 40-80 m long, 25-35 m apart', () => { /* fitBox of each A3 slab: d 12, w in [40, 80]; centreline gaps in [25, 35] */ })
it('bigbox has a parking front and a yard rear', () => { /* exactly one parking and one yard lot; the hall lies in the yard lot */ })
it('tower-park towers stand 20 m apart', () => { /* pairwise centroid distance ≥ 20 + half sizes; 1-3 towers */ })
it('villas pools sit inside green lots, 3 m clear', () => { /* every pool lot is inside a green lot and ≥ 3 m from its edge and from the house */ })
it('lot kind by open ground', () => { expect(lotKind(rectPoly(0, 0, 10, 10), [rectPoly(0, 0, 10, 9)], 'yard')).toBe('building'); expect(lotKind(rectPoly(0, 0, 10, 10), [rectPoly(0, 0, 10, 8)], 'yard')).toBe('yard') })
```
(The commented bodies are the assertions to write, with the values shown.)
- [ ] **Step 2: Run** `npx vitest run --dir src/gen/lots -t 'every fabric keeps|continuous fronts|terrace builds|zeilen slabs|bigbox has|tower-park towers|villas pools|lot kind'`. Expected: FAIL.
- [ ] **Step 3: Implement** `layout.ts` and `frontageLots`.
- [ ] **Step 4: Run** the same, then `npx vitest run --dir src/gen/lots`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: per-fabric lot layout with fillers`

### Task 8: megablock core and hive, compound lots

**Files:** Create `src/gen/lots/landmarks.ts`, `src/gen/lots/landmarks.test.ts`

**Interfaces:**
- Consumes: `stripLots` with `holes` (Task 3), `layoutPiece`'s building fit for `perimeter` lots (Task 7), `fitBox`, `widthOk`, `bspSplit`, `insetOrLargest` (kept in `streets/lots.ts`).
- Produces:
  - `export function megablockLots(piece: Pt[], sides: Side[], radius: number, ctx: BlockCtx, rng: Rng): { core: Pt[]; lots: LotOut[]; alleys: Array<[Pt, Pt]> }` (R16; hive buildings `shape: 'hive'`)
  - `export function compoundLots(footprint: Pt[], gateToward: Pt, ctx: BlockCtx, rng: Rng): { fence: Pt[]; gate: [Pt, Pt]; lots: LotOut[] } | null` (R17; fence and gate code moved unchanged from `streets/lots.ts`)
  - `generate.ts` must pass the megablock radius: `Megablock` gains nothing; `megablockLots` takes the radius as the max distance from `m.center` to its `m.core` vertices.

- [ ] **Step 1: Write the failing tests**

```ts
it('hive cells stay inside the core', () => {                   // T13 on a synthetic 600 × 500 block, radius 200
  for (let s = 0; s < 5; s++) { const r = megablockLots(big, sidesOf(big), 200, ctx(s, 'mixed'), mulberry32(s))
    const hive = r.lots.flatMap((l) => l.buildings).filter((b) => b.shape === 'hive')
    expect(hive.length).toBeGreaterThan(10); for (const b of hive) expect(insideRing(b.footprint, r.core, 0.05)).toBe(true)
    for (const [a, b] of r.alleys) for (const p of [a, b]) expect(insideOrOn(p, r.core, 0.05)).toBe(true) }
})
it('a small megablock block falls back to the fit-box core', () => {
  const small = rectPoly(0, 0, 300, 260), r = megablockLots(small, sidesOf(small), 250, ctx(1, 'mixed'), mulberry32(1))
  expect(insideRing(r.core, buildable(small, [7.5, 7.5, 7.5, 7.5])[0], 0.05)).toBe(true); expect(isRectangle(r.core)).toBe(true)
})
it('the ring around the core is perimeter-lotted', () => { /* ≥ 8 non-hive buildings, all outside core + 6 m - 0.05 */ })
it('a compound has 2-4 shapes, 8 m inside the fence', () => {      // T14 on a synthetic 200 × 160 block
  const c = compoundLots(rectPoly(0, 0, 200, 160), { x: 100, y: 0 }, ctx(3, 'corp'), mulberry32(3))!
  const b = c.lots.flatMap((l) => l.buildings); expect(b.length).toBeGreaterThanOrEqual(2); expect(b.length).toBeLessThanOrEqual(4)
  for (const x of b) { for (const p of x.footprint) expect(distToRing(p, c.fence)).toBeGreaterThanOrEqual(8); if (!/^E/.test(x.shape)) expect(x.footprint.length).toBeLessThanOrEqual(12) }
})
it('a block too small for 2 compound buildings gives null', () => { expect(compoundLots(rectPoly(0, 0, 60, 60), { x: 30, y: 0 }, ctx(1, 'corp'), mulberry32(1))).toBeNull() })
```
- [ ] **Step 2: Run** `npx vitest run --dir src/gen/lots -t 'hive cells|small megablock|ring around the core|compound has|too small for 2'`. Expected: FAIL.
- [ ] **Step 3: Implement** per R16 (octagon on the longest-side angle or, 50/50, the block-aligned rectangle of equal area; scale down by 0.05 until inside the piece inset by 26 m; below 0.6 the fit box of that inset; BSP minCell 30, gap 2, jitter 0.3 in the core frame, cells intersected with the core; a cell < 60 m², not holding 6 × 8 or failing the acceptance gate is a `plaza` lot; alleys = the 3 longest cuts clipped to the core), the pinned ring rule, and R17.
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat: megablock hive inside its core, compound shapes fitted`

### Task 9: the new lot pass replaces the old one (GENERATOR_VERSION 10)

**Files:**
- Create: `src/gen/lots/index.ts`, `src/gen/lots/index.test.ts`
- Modify: `src/gen/types.ts` (`GENERATOR_VERSION = 10`; `BlockStyle` exactly as §3.9, `courtyard` gone; `Building` gains `shape: string; lotId: string; details?: Pt[][]`; `SectorModel.lots: Lot[]`), `src/gen/sector/generate.ts` (the lot call, megablock core), `src/gen/streets/lots.ts` (delete all but the pinned kept list), `src/gen/streets/lots.test.ts` (delete the tests of removed code), every test fixture building a `SectorModel` literal (add `lots: []`; tsc lists them)

**Interfaces:**
- Produces: `export function fillLots(districts: District[], blocks: Block[], params: SectorParams, terrain: Terrain, roads: Road[], landmarks?: Landmarks, highway?: Road, frontage: Road[] = [], compoundsIn: Array<{ blockId: string; gateToward: Pt }> = [], forceStyle?: BlockStyle): { buildings: Building[]; lots: Lot[]; blocks: Block[]; megablockCores: Map<string, Pt[]>; compounds: Compound[] }`. Per block: forced cases in R21 order (ring plaza, megablock, compound, strip), else R22 cut, R1 `simplifyFace` + `simplifyPolyline(…, 2)`, `edgeSetbacks`, `buildable`, fabric per R18–R21 (the `fits` test is `MIN_FIT` against each piece's `fitBox` on its longest side), `layoutPiece`, the pinned acceptance gate, ids `LOT00001` / `BLD0001` in order. Lots with no area left are dropped; buildings in water (centroid) are dropped as today.
- `generateSector`: `fillLots(namedDistricts, rawBlocks, params, terrain, roads, { arcologies, megablocks }, hw[0], frontageRoads, compoundPicks)`; `megablocksOut = namedMegablocks.map((m) => ({ ...m, core: cores.get(m.id) ?? m.core, footprint: cores.get(m.id) ?? [] }))`; the model gains `lots`. `corridorRects`, `noBuildStrips` (if no other caller) and the `SIDEWALK` corridor import go.

- [ ] **Step 1: Write the failing tests** (`index.test.ts`, synthetic districts and blocks as in `lots.test.ts`)

```ts
it('every building has a lot and every lot its block', () => {
  const out = fillLots([resDistrict], [bigBlock('D04')], base, dryTerrain, [street(0, 0, 400, 0)])
  const ids = new Set(out.lots.map((l) => l.id))
  for (const b of out.buildings) { expect(ids.has(b.lotId)).toBe(true); expect(out.lots.find((l) => l.id === b.lotId)!.buildingIds).toContain(b.id) }
  expect(out.lots[0].id).toBe('LOT00001'); expect(out.buildings.every((b) => b.shape.length > 0)).toBe(true)
})
it('forceStyle drives every fabric through the pass', () => { for (const f of FABRICS) expect(fillLots([resDistrict], [bigBlock('D04')], base, dryTerrain, [], undefined, undefined, [], [], f).blocks[0].style).toBe(f) })
it('alleys only on megablocks', () => { /* non-megablock blocks: alleys [] */ })
it('is deterministic', () => { expect(fillLots(...a)).toEqual(fillLots(...a)) })
```
`lots.test.ts`: keep `insetRing`, `insetByClipping`, `isStripBlock`, `isLandmarkBlock`, `selectCompounds skips…` and `compounds never sit on strip or landmark blocks` (rewritten on the new `fillLots` signature); delete the rest (their claims move to `src/gen/lots/*.test.ts` and Task 11).
- [ ] **Step 2: Run** `npx vitest run --dir src/gen/lots -t 'every building has a lot|forceStyle drives|alleys only|is deterministic'`. Expected: FAIL.
- [ ] **Step 3: Implement** `index.ts`, the type changes, the `generate.ts` switch and the deletions; `npx tsc -b --noEmit` clean.
- [ ] **Step 4: Run** the same, then `npx vitest run --dir src/gen/streets -t 'insetRing|insetByClipping|isStripBlock|landmark blocks|compounds'`, then `npx vitest run --dir src/gen/sector -t 'is deterministic|2 km sector still has'`. Expected: PASS. Spot-check perf: `npx tsx temp/perf/time.mts` P1 against `temp/perf/time-base.txt`; over +15 % → profile and fix in this task (the fit box and strip clipping are the suspects).
- [ ] **Step 5: Commit** `feat: lots and catalogue shapes replace the clipped BSP lot pass`

### Task 10: rendering lots, parking stripes, details

**Files:** Modify `src/render/svg.ts` (lot layer, parking patterns in `<defs>`, details layer, generic alley path removed), `src/render/theme.ts` (`lot` in `Theme` and all five themes), `src/render/svg.test.ts`

**Interfaces:**
- Produces: `Theme.lot: { parking: string; plaza: string; yard: string; green: string; pool: string; stripe: string }`. Markup: `<path data-lots="<kind>" data-count="N" d="…" fill="…"/>` per non-building kind, both modes, after the district fills and before `renderCompounds`; per parking angle group `<path data-parking="<deg>" d="…" fill="url(#parking-<deg>)"/>` with `<pattern id="parking-<deg>" patternUnits="userSpaceOnUse" width="2.5" height="2.5" patternTransform="rotate(<deg>)"><rect width="0.3" height="2.5" fill="<stripe>"/></pattern>`; after the buildings `<path data-details="1" d="…" fill="none" stroke="<building.stroke>" stroke-width="0.5" vector-effect="non-scaling-stroke"/>`.

- [ ] **Step 1: Write the failing tests** (T16)

```ts
it('lot and details paths in both modes', { timeout: 120000 }, () => {
  const m = generateSector(s42)
  for (const interactive of [false, true]) {
    const svg = renderSector(m, getTheme('neon'), { interactive })
    for (const k of ['parking', 'plaza', 'yard', 'green'] as const) {
      const n = m.lots.filter((l) => l.kind === k).length
      if (n) expect(svg).toContain(`<path data-lots="${k}" data-count="${n}"`)
    }
    expect(svg.indexOf('data-lots')).toBeLessThan(svg.indexOf('data-buildings') === -1 ? svg.indexOf('data-id="BLD') : svg.indexOf('data-buildings'))
    expect(svg).toMatch(/<path data-details="1"[^>]*vector-effect="non-scaling-stroke"/); expect(svg).toMatch(/<pattern id="parking-\d+"/)
  }
})
it('every theme has a green lot tint', () => {
  for (const t of Object.values(themes)) { const [h, s] = hsl(t.lot.green); expect(h, t.id).toBeGreaterThanOrEqual(80); expect(h).toBeLessThanOrEqual(160); expect(s).toBeGreaterThanOrEqual(0.2) }
})
```
(`hsl` is a small hex → [hue°, saturation] helper in the test file.) Update the count tests (~405–430): building counts unchanged in form (details are not `data-buildings`); `renders arcology and megablock marks` asserts `m` has no `data-alleys` path outside the megablock draw instead of `alleyPaths.length > 0`; delete `describe('alleys')`.
- [ ] **Step 2: Run** `npx vitest run --dir src/render -t 'lot and details paths|green lot tint'`. Expected: FAIL.
- [ ] **Step 3: Implement** R31–R34.
- [ ] **Step 4: Run** `npx vitest run --dir src/render`. Expected: PASS (perf-free file; alone).
- [ ] **Step 5: Commit** `feat: draw lots, parking stripes and building details`

### Task 11: sector invariants on the reference seeds

**Files:** Create `src/gen/sector/buildings.test.ts` (everything inside `describe('buildings phase A')`)

Each seed is generated once per file (`beforeAll`, timeout 300000); helpers `interiorAngles`, `widthOk`, `pairOverlapMax` (box prefilter, `clip.intersection` only on box hits) come from `src/gen/lots/fixtures.ts`. Names are the spec's:

```ts
describe.each(SEEDS)('%s', (_, params) => {
  it('min edge', () => { for (const b of m.buildings) expect(minNonArcEdge(b.footprint), b.id).toBeGreaterThanOrEqual(3) })          // T4: arc edge = both ends turn ≤ 15.5°
  it('min width', () => { for (const b of m.buildings) expect(widthOk(b.footprint, 6), b.id).toBe(true) })                           // T5
  it('no small buildings', () => { expect(m.buildings.filter((b) => ringArea(b.footprint) < 60)).toEqual([]) })                    // T6
  it('no overlap', () => { expect(pairOverlapMax(m.buildings.map((b) => b.footprint))).toBeLessThanOrEqual(0.5) })                  // T7
  it('non-rectilinear share', () => {                                                                                                // T9 ratchet
    const plain = m.buildings.filter((b) => !CURVED_OR_SLANTED.has(b.shape) && !hiveCutByCore(b, m))
    expect(plain.filter((b) => interiorAngles(b.footprint).some((a) => off90(a) > 1)).length / plain.length).toBeLessThanOrEqual(NONRECT[params.seed])
  })
  it('triangles', () => { for (const b of m.buildings.filter((x) => x.footprint.length === 3)) { expect(b.shape).toBe('A16'); expect(ringArea(lotOf(b).poly)).toBeGreaterThanOrEqual(1500) } }) // T10
  it('lots', () => { /* T11: simple; inside the block's buildable (recomputed via edgeSetbacks/buildable) ± 0.05; buildings inside their lot ± 0.05; per block pairwise ≤ 0.5 m² except a pool in its green lot */ })
  it('megablock', () => { for (const k of m.megablocks) for (const b of hiveOf(k)) expect(insideRing(b.footprint, k.core, 0.05)).toBe(true) })        // T13
  it('compound', () => { /* T14: 2-4 buildings, ≥ 8 m inside the fence, ≤ 12 vertices unless shape E* */ })
})
describe('road strips', () => { it('lots never overlap a road strip', () => { /* T8: per seed, no footprint vertex closer than its R2 setback − 0.5 to a road centreline (class → SETBACK; highway by level) */ }) })
it('fabric mix', () => { /* T12: pooled over the seeds, rows (sheet zone × density) with ≥ 20 blocks hold each fabric of weight ≥ 20 at ≥ 0.5 × its share; measured table in a comment */ })
it('deterministic', () => { const a = generateSector(S426); expect(a.buildings).toEqual(generateSector(S426).buildings); expect(a.lots).toEqual(generateSector(S426).lots) }) // T15
```
`NONRECT` = `{ 42: 0.02, 782008753: 0.02, 426750495: 0.02, 2268324149: 0.02 }`, lowered per seed to the measured value rounded up to 0.001 if lower (comment `// measured …`).

- [ ] **Step 1: Write** the file as above.
- [ ] **Step 2: Run** `npx vitest run --dir src/gen/sector -t 'buildings phase A'` (alone, ~5 min), then `npx vitest run --dir src/gen/sector -t 'landmarks in road tracing'` (must stay green). Expected: PASS. A red invariant is a defect: fix it in the owning `src/gen/lots/` file with a unit test there reproducing the shape (never by loosening the invariant), then re-run.
- [ ] **Step 3: Commit** `test: building and lot invariants on the reference seeds` (plus `fix: …` commits for any defect found)

### Task 12: uicheck A

**Files:** Modify `tools/uicheck/check.mjs`

- [ ] **Step 1: Find coordinates.** `temp/buildings/scenes.mts` prints, for each of `perimeter`, `terrace`, `zeilen`, `villas`, `podium`, `bigbox`, `megablock`, `compound`, one block of that style with its centroid, preferring ≥ 4 buildings and ≥ 300 m from the map edge, on S42 (`seed=42&tags=coastal,medium,dense,fringe,lively,mixed,river,arcology&pack=generic&theme=print`), else S2268, else S426 (URLs from their tags). S782 is not tag-expressible: a fabric absent from all three takes the first of seeds 1–20 with the S42 tags that has it.
- [ ] **Step 2: Add** one helper `async function zoomShot(url, x, y, sizeM, name)` (the `streets-highway` wheel pattern: move to the map point, wheel until `zoom / z0 ≥ sizeM / 300`, settle 600 ms, POIs off) that fails the run unless `svg [data-lots]` count ≥ 1 and `svg [data-buildings]` count ≥ 1, then screenshots `buildings-<name>.png`. Eight calls with the measured points, each with a comment naming seed, block id and coordinates.
- [ ] **Step 3: Run** `PORT=4174 tools/uicheck/run.sh` (alone). Expected: exit 0. The controller opens all eight `buildings-*.png` plus `landmarks-megablock.png`, `compound.png` and `frontage.png`, and describes each in two sentences (fronts parallel to streets, corner buildings, filler colours and stripes, hive inside the core, no wedges).
- [ ] **Step 4: Commit** `test: uicheck zoom scenes for eight building fabrics`

### Task 13: re-pins, perf, measurement, docs

**Files:** Modify `src/gen/sector/generate.test.ts` and any test with a moved pin, `docs/specs/2026-10-15-buildings-design.md` (§3 "As built (phase A)"), `docs/ROADMAP.md`

- [ ] **Step 1: Full suite** `npx vitest run --dir src` (about 10 min, alone). Expected moves: `block styles › a sector mixes block styles` (rewrite to "≥ 4 distinct styles, none above 60 %" with the measured shares in the comment), `density tags give distinct building counts` (keep the ratios; if red, report the counts, never loosen), svg counts, `compounds` counts, POI-dependent names. Every re-pin carries `// buildings re-roll (v10): old -> new`. Road, block, district, free-end, block-side and landmark-name tests must not move (lots run after them); one that does is a defect fixed in this branch.
- [ ] **Step 2: Perf.** Median of 3 of P1 on HEAD vs main (`temp/perf/time.mts`; main from `git worktree add temp/buildings/perf-main main`, then `git worktree remove temp/buildings/perf-main`). Must be within +15 %; report both numbers.
- [ ] **Step 3: Measurement** (§6). `temp/buildings/an-a.mts` prints per reference seed, before (main worktree) and after: building count, cover %, non-rectilinear and concave share, < 60 m², min width < 6 m, 3-vertex and > 8-vertex counts, median area per fabric, lots per kind and area share, fabric mix per sheet zone, megablock cells outside the core, acceptance-gate rejections, P1 time. Expected after A: non-rectilinear ≤ 2 %, < 60 m² 0, triangles A16 only, outside-core 0, rejections 0.
- [ ] **Step 4: Docs.** Spec §3, an "As built (phase A)" note: this plan's "Decisions this plan pins" list, one line each, and the measurement table. ROADMAP: add the §7 follow-ups (alleys/rear lanes for other fabrics; roof details beyond podium towers and sawtooth; parking stripes per lot without the 5° rounding; landmark variants by flavour pack). Then `npx tsc -b --noEmit`.
- [ ] **Step 5: Commit** in two:
  - `test: phase A re-pins (buildings re-roll v10)`
  - `docs: spec records buildings phase A as built; roadmap follow-ups`
