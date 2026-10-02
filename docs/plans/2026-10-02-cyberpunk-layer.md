# Cyberpunk Layer Part 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add arcologies (giant corp structures the road net bends toward) and megablocks (solid slum masses with no streets) as placed-before-roads landmarks, named, marked, rendered.

**Architecture:** New `src/gen/landmarks/place.ts` picks landmark sites after the highway and before arterials. The tracer gains `obstacles`; the field gains a `radial` basis per arcology; a ring road per arcology is pre-added like the highway. Zoning, lots, POIs, names and the renderer read landmark flags.

**Tech Stack:** TypeScript, vitest, polygon-clipping (already present), Playwright for uicheck. No new dependencies.

**Spec:** `docs/specs/2026-10-02-cyberpunk-layer-design.md`

## Global Constraints

- Metric only. Determinism via `mulberry32(hashSeed(seed, '<stage>'))`; stage `'landmarks'` for placement, `'names'` reused for landmark names. Window containment.
- `GENERATOR_VERSION` = 6.
- Perf: within +10 % of `main` on seed 42 coastal+river 4 km (median of 3).
- Conventional Commits, no `Co-Authored-By` / "Generated with" lines (check `git log -1 --format=%B`, amend your own fresh commit if a trailer appeared).
- Every task: `npx tsc -b --noEmit` + the task's tests before commit; tasks touching render or UI run `tools/uicheck/run.sh` (alone, not concurrently with vitest) and look at the screenshots.
- Ratchets in `generate.test.ts` only go down.

## Review Focus

1. Inland sector with no highway (all edges sea is impossible inland; but a sector whose highway trace is empty): placement must work with `highway` undefined (Task 1 test).
2. 2 km sector: at most one arcology and one megablock; a sector where no candidate satisfies the distances yields zero landmarks without throwing (Task 1 test).
3. Arcology next to a river: the plaza must not swallow the river bank — candidates are ≥ 150 m from water (Task 1) and the ring road must not enter water (Task 3 test).
4. Megablock core inside a face that also holds normal lots: no lot overlaps the core (Task 5 test).
5. POI lottery placing a club inside an arcology plaza (Task 6 test).

---

### Task 1: Types, pack patterns, placement

**Files:**
- Modify: `src/gen/types.ts`, `src/gen/names/names.ts`, `src/gen/names/packs/generic.ts`, `src/gen/names/packs/shadowrunish.ts`
- Create: `src/gen/landmarks/place.ts`, `src/gen/landmarks/place.test.ts`

**Interfaces:**
- Produces: spec §8 types (`Arcology`, `Megablock`, `LandmarkFlags`, `BlockStyle` + `'megablock'`, `SectorModel.arcologies/megablocks`, `GENERATOR_VERSION = 6`); `FlavorPack.arcologyPatterns: string[]`, `megablockPatterns: string[]`; POI types `arcology` (zones `['corp']`) and `megablock` (zones `['slum']`) in both packs; and
```ts
export interface Landmarks { arcologies: Arcology[]; megablocks: Megablock[] }
export function placeLandmarks(params: SectorParams, terrain: Terrain, sizeM: number, highway: Road | undefined, field: RoadField): Landmarks
export function ringRoad(a: Arcology): Road   // id a.ringRoadId, class arterial, width 18, 48 segments, closed (last point = first)
export function octagon(center: Pt, radius: number, angle: number, jitter?: (i: number) => number): Pt[]
```
`Arcology.name` / `Megablock.name` are `''` here (Task 6 names them).

- [ ] **Step 1: Failing tests** (`place.test.ts`): `is deterministic`; `counts follow the power tag` (seed 42 size 4 inland: corpDominance 0.85 → 2-3 arcologies and ≤ 1 megablock; 0.5 → 1-2 / 1-2; 0.15 → ≤ 1 / 2-4); `a 2 km sector has at most one of each`; `landmarks keep their distances` (≥ 150 m from water on a coastal+river seed, ≥ 250 m from the highway, arcologies ≥ 900 m apart, megablocks ≥ 700 m from arcologies); `works without a highway` (pass `undefined`); `ring road is closed and inside the window`; `no candidate → zero landmarks, no throw` (a terrain fixture that is almost all water).
- [ ] **Step 2: Run** `npx vitest run src/gen/landmarks` → FAIL (module missing).
- [ ] **Step 3: Implement** per spec §3 (lattice 300 m jittered ±0.3, candidate filters, greedy picks, octagons, ring road). Field major angle at the centre from `field.sample(center).major`.
- [ ] **Step 4: Types and packs.** Add the types; `flags` types change from `Record<string, never>` to `LandmarkFlags` (compile fallout: literals keep `flags: {}`); patterns and POI types in both packs (4+ patterns each, using existing tables `corpA`, `corpB`, `place`, `adj`).
- [ ] **Step 5:** `npx tsc -b --noEmit && npx vitest run src/gen/landmarks src/gen/names` → PASS. Commit `feat: landmark placement for arcologies and megablocks`.

---

### Task 2: Field radial basis and tracer obstacles

**Files:**
- Modify: `src/gen/streets/field.ts`, `src/gen/streets/trace.ts`, tests alongside.

**Interfaces:**
- Produces: `radialBasis(center: Pt, rInner: number, rOuter: number): BasisField` (name `'radial'`; angle = line angle toward the centre; weight 1.5 at `rInner` → 0 at `rOuter`, 0 inside `rInner`); `BasisField.name` union gains `'radial'`.
- `TraceOpts.obstacles?: Pt[][]`; `traceHalf` stops when `next` is inside any obstacle (`pointInRings`, bbox prefilter); `poissonSeeds(..., accept)` callers pass `accept` that also rejects obstacle points; `seedsAlong(points, every, alternate, reject?: (p: Pt) => boolean)` drops seeds for which `reject(p)` is true.

- [ ] **Step 1: Failing tests**: `radial basis points at the centre` (angle at (c.x + 300, c.y) is horizontal; at (c.x, c.y + 300) vertical; weight 0 inside rInner, 0 beyond rOuter); `a streamline stops at an obstacle` (square obstacle in the path on the inland stub field → last point outside the obstacle, within one step of its edge); `seedsAlong rejects seeds inside obstacles`.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** `npx vitest run src/gen/streets` → PASS. Commit `feat: radial basis field and tracer obstacles`.

---

### Task 3: Wire landmarks into road tracing

**Files:**
- Modify: `src/gen/sector/streets.ts`, `src/gen/sector/generate.ts` (call order only), `src/gen/sector/generate.test.ts`

**Interfaces:**
- `traceRoads(params, terrain, sizeM): TracedRoads` gains `landmarks: Landmarks` and `ringRoads: Road[]` in its result; internally: highway → `placeLandmarks` → field rebuilt with `extra = arcologies.map(radialBasis(center, r + 60, 800))` → ring roads added to the index → arterial seeds = highway seeds + ring-road seeds (`seedsAlong(ring, 400, false)`, crossing axis) + river crossings + Poisson (rejecting obstacle points) → arterial passes with `obstacles = plazas` → street queue with `obstacles = plazas + cores`. Ring roads are part of `arterials` in the output (so graph, naming, prune treat them as arterials; `pruneDangling` must not touch a closed ring: skip roads whose first and last point coincide).
- `infillFaces` skips faces containing an arcology centre or megablock core; for a megablock face it measures `area − coreArea`.

- [ ] **Step 1: Failing tests** in `generate.test.ts` on seed 42 inland 4 km corpDominance 0.85 and seed 7 bay 4 km corpDominance 0.15: `no road enters an arcology plaza`; `no street enters a megablock core`; `ring roads are closed and spoked` (≥ 4 arterial ends within 6 m of each ring road); `landmark faces are not infilled` (no infill road inside a plaza or core); keep every existing test green (re-baseline only downward).
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** `npx tsc -b --noEmit && npx vitest run src/gen` → PASS. Commit `feat: roads bend toward arcologies and stop at megablocks`.

---

### Task 4: Zoning and district flags

**Files:**
- Modify: `src/gen/sector/zoning.ts`, `zoning.test.ts`, `generate.ts`

**Interfaces:**
- `assignZones(districtPolys, params, terrain, forced: Array<{ at: Pt; zone: ZoneType; flag: LandmarkFlags }> = [])`: a polygon containing `at` gets that zone and `flags` merged; the lottery runs for the rest.

- [ ] Tests: `forced zones win the lottery`; `generate`: the district containing each arcology centre is `corp` with `flags.arcology`, each megablock core district is `slum` with `flags.megablock`. Implement, PASS, commit `feat: landmark districts are zoned corp and slum`.

---

### Task 5: Lots: arcology blocks empty, megablock core as one building

**Files:**
- Modify: `src/gen/streets/lots.ts`, `lots.test.ts`, `generate.ts`

**Interfaces:**
- `fillLots(districts, blocks, params, terrain, noBuild, forcedStyle?, landmarks?: Landmarks)`: a block whose centroid lies inside an arcology plaza → `flags.arcology = id`, no buildings, no alleys; a block whose face contains a megablock core → `flags.megablock = id`, `style: 'megablock'`, ONE building = core inset 3 m (concave allowed via `insetByClipping`), alleys = BSP cuts of the core bbox at 60 m clipped to the core, the core is a no-build strip for the rest of the face's normal lots.

- [ ] Tests: `arcology blocks have no buildings`; `a megablock core is exactly one building with alleys`; `lots around a megablock never overlap the core`. Implement, PASS (`npx vitest run src/gen/streets src/gen/sector/generate.test.ts`), commit `feat: megablock cores and empty arcology blocks in the lot pass`.

---

### Task 6: Names and POIs

**Files:**
- Modify: `src/gen/sector/generate.ts`, `src/gen/sector/pois.ts`, `pois.test.ts`, `generate.test.ts`

**Interfaces:**
- Landmark names from `nameRng` after districts: `generateName(rng.pick(pack.arcologyPatterns), pack.tables, rng)` (same for megablocks).
- `placePois(districts, buildings, pack, params, landmarks?)`: first one POI per landmark at its centre (`type: 'arcology' | 'megablock'`, `name` = landmark name, `buildingId: ''`, `districtId` = containing district), then the lottery, which skips buildings whose centroid lies in a plaza (there are none) and never picks a `type` of `arcology`/`megablock`.

- [ ] Tests: `one POI per landmark with its name`; `names are non-empty and from the pack patterns`; `lottery never places a POI inside a plaza`. Implement, PASS, commit `feat: landmark names and POIs`.

---

### Task 7: Rendering, themes, uicheck, docs

**Files:**
- Modify: `src/render/theme.ts`, `theme.test.ts`, `src/render/svg.ts`, `svg.test.ts`, `tools/uicheck/check.mjs`, `ARCHITECTURE.md`, `docs/ROADMAP.md`

- [ ] Theme keys per spec §7 in all five themes (test extends the existing all-themes check).
- [ ] `svg.ts`: landmark pass after buildings, before roads: arcology plaza fill, footprint octagon, two inner rings, `data-arcology`; megablock core `data-megablock` with `megablock.fill`, its alleys in `megablock.alley`; landmark labels with district-label styling one size larger, always shown. Test: `renders arcology and megablock marks` on the corp-run and fringe seeds.
- [ ] uicheck: after the existing planned/sprawl block, load `?seed=42&tags=inland,corp-run` and assert ≥ 1 `[data-arcology]`; load `?seed=7&tags=bay,fringe` and assert ≥ 1 `[data-megablock]`; screenshot both as `landmarks-arcology.png` / `landmarks-megablock.png`. Run `tools/uicheck/run.sh`; look at the shots.
- [ ] Perf check: seed 42 coastal+river 4 km median of 3 vs `main`; report.
- [ ] ARCHITECTURE.md: one row in the pipeline table ("Landmarks", `landmarks/place.ts`, after Highway) and one sentence under the road field about the radial basis and obstacles. ROADMAP: move "Cyberpunk street layer" to a done note pointing at this spec; add part 2 (highway frontage, corporate compounds) as the next entry.
- [ ] Commit `feat: render arcologies and megablocks; uicheck and docs`.

---

## Plan self-review notes

- Spec coverage: §3→T1, §4→T2+T3, §5→T4+T5, §6→T1 (patterns/types)+T6, §7→T7, §8→T1, §9 spread over tasks, §10 docs→T7.
- `pruneDangling` skipping closed rings is the one tracer-side rule beyond the spec text; without it the ring road's "ends" (which coincide) could be judged unanchored.
- Megablock faces: the spec says "ONE building"; lots for the remaining face area are normal rows, so a megablock face is a mix. Infill measures `area − coreArea` so it is not split.
