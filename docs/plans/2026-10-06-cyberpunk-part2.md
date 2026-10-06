# Cyberpunk Part 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Service streets with packed strip lots along both sides of the highway, and fenced corporate compounds in corp districts.

**Architecture:** Frontage roads are fixed `F` streets built in `traceRoads` right after the landmarks (offset from the highway, cut at water/plazas/cores), indexed before the arterial passes and never pruned; the stretches along sunken highway segments are removed in `generate.ts` once levels are known. Strip blocks and compounds are new block styles handled in `fillLots`; compounds are selected in `generate.ts` after blocks exist. Render adds a frontage batch and a compound pass to the landmark layer.

**Tech Stack:** TypeScript, vitest, Vite/React, Playwright uicheck.

**Spec:** `docs/specs/2026-10-06-cyberpunk-part2-design.md`

## Global Constraints

- Metric only. Determinism via `mulberry32(hashSeed(seed, '<stage>'))`: new stages `'frontage'` (strip lots) and `'compounds'` (selection + geometry); compound names on the `'names'` stream after the landmark names.
- `FRONTAGE_OFF = STRIP_HALF + 22` m (export `STRIP_HALF` from `streets/highway.ts`; `HIGHWAY_WIDTH = 32`, so `STRIP_HALF = 26`, `FRONTAGE_OFF = 48`). Frontage road: class `street`, width 9, ids `F<n>L` / `F<n>R`.
- Strip lots: BSP `minCell 10, gap 1, jitter 0.3`, cells > 25 m along the road split at 25 m, pieces ≥ 40 m², no alleys. Compound: fence inset 4 m, second fence line 5.5 m, gate 12 m, inner area inset 10 m, BSP `minCell 40, gap 10, jitter 0.2`, 2–4 buildings ≥ 400 m². Selection: corp ≥ 0.7 → 0.6, 0.3–0.7 → 0.3, < 0.3 → 0.1; block land area ≥ 15 000 m²; second draw when district area > 400 000 m².
- `GENERATOR_VERSION = 7`.
- Perf within +10 % of main on seed 42 coastal+river 4 km (median of 3, same machine).
- Conventional Commits, no `Co-Authored-By` / "Generated with" lines (check `git log -1 --format=%B`, amend your own fresh commit if a trailer appeared). Every task: `npx tsc -b --noEmit` + the task's tests before commit; render/UI tasks run `tools/uicheck/run.sh` alone and look at the shots. Ratchets only move down; test dodges are never fixes (R22 of part 1).
- Ruling (plan): highway levels are assigned after districts, which need the arterials, so frontage roads are built along the WHOLE highway during tracing and the pieces along sunken segments are removed afterwards in `generate.ts` (Task 17 step 6); streets left dangling by that removal are pruned by the existing `pruneDangling` street pass.

## Review Focus

1. A sector whose highway is entirely sunken: no frontage roads remain, no strip blocks, nothing dangling (Task 17 test).
2. A coastal highway running along the shore: the seaward frontage road is mostly wet and must vanish without leaving stubs shorter than 60 m (Task 17 test on seed 42 coastal+river).
3. A ring road or plaza touching the frontage band: frontage pieces inside a plaza removed, strip blocks never carry landmark flags (Task 18 test).
4. A corp district whose only big block is a strip block or a hive: no compound there (Task 19 test).
5. A compound block that is shore-clipped or concave: fence inset falls back to clipping; if the inner area yields fewer than 2 buildings the block is NOT a compound (reverts to normal lots) (Task 19 test).

---

### Task 17: Frontage roads

**Files:**
- Modify: `src/gen/streets/highway.ts` (export `STRIP_HALF`; add `frontageRoads`), `src/gen/sector/streets.ts` (`traceRoads`), `src/gen/streets/trace.ts` (`pruneDangling` exemption for `F` prefix, alongside `RING_ID_PREFIX`), `src/gen/sector/generate.ts` (remove sunken stretches), `src/gen/sector/generate.test.ts`, `src/gen/streets/highway.test.ts`

**Interfaces:**
- Produces: `export const FRONTAGE_ID_PREFIX = 'F'`; `export function frontageRoads(highway: Road, terrain: Terrain, sizeM: number, obstacles: Pt[][]): Road[]` in `highway.ts` — both sides, offset `FRONTAGE_OFF` along the full highway (sample every 10 m, normal from neighbouring points as `noBuildStrips` does), cut into dry runs (`dryStreetPieces`-style sampling: drop wet samples, samples inside any obstacle ring, samples outside the window), pieces < 60 m dropped, simplified like streets, ids `F<n>L` / `F<n>R` numbered per piece; `TracedRoads.frontage: Road[]` (also contained in `streets`); `export function trimFrontage(frontage: Road[], highway: Road, segments: HighwaySegment[]): Road[]` in `highway.ts` — removes the stretches whose nearest highway point lies in a `sunken` segment (project each frontage point onto the highway, use `slicePolyline` parametrisation of `segments[i].from/to`), keeps pieces ≥ 60 m.

- [ ] **Step 1: Failing tests** — `highway.test.ts`: `frontageRoads offsets both sides and skips water` (synthetic straight highway over the inland stub terrain → two roads at distance `FRONTAGE_OFF ± 1` from the centreline, none when the terrain stub is all water), `trimFrontage removes sunken stretches` (one sunken segment in the middle → the roads split into two pieces each, nothing within the sunken span). `generate.test.ts`: `frontage roads line the highway` on seed 42 coastal+river 4 km and seed 20 coastal+river 2 km — sampling the offset line every 100 m on both sides, a `street` point within 6 m unless the sample is wet, inside a plaza/core, outside the window, or beside a sunken segment; `no frontage along sunken segments`; `frontage roads have no dangling ends` (each end within 6 m of water, the window, a segment boundary or another road); existing invariants (no building on a road, no street ends at the highway) stay green.
- [ ] **Step 2:** `npx vitest run src/gen/streets/highway.test.ts src/gen/sector/generate.test.ts -t frontage` → FAIL.
- [ ] **Step 3: Implement.** In `traceRoads`: after `placeLandmarks`, `frontage = highway ? frontageRoads(highway, terrain, sizeM, [...plazas, ...cores]) : []`; add to the index after ring roads; return `frontage` and include it in `streets` (not in the queue seeds). `pruneDangling`: roads whose id starts with `FRONTAGE_ID_PREFIX` pass through (same place as the `K` exemption). In `generate.ts`: after `segments` exist, `const frontageKept = trimFrontage(frontage, highway, segments)`; replace the frontage roads inside `minorAll` with `frontageKept` before `cutStreetsAtGround`/`pruneCutStreets`, then run the streets `pruneDangling` pass once more so streets that ended on a removed stretch are cut back (reuse the existing call shape from `traceRoads`).
- [ ] **Step 4:** `npx tsc -b --noEmit && npx vitest run src/gen/streets src/gen/sector/generate.test.ts` → PASS (perf.test.ts excluded in the container).
- [ ] **Step 5: Commit** `feat: frontage roads along both sides of the highway`.

### Task 18: Strip blocks

**Files:**
- Modify: `src/gen/types.ts` (`BlockStyle` + `'strip'`), `src/gen/streets/lots.ts`, `lots.test.ts`, `src/render/svg.ts` + `src/render/landmarks.ts` (frontage batch), `src/render/theme.ts` + `theme.test.ts` (`frontage: { fill; stroke }`), `src/render/svg.test.ts`

**Interfaces:**
- Consumes: `highway: Road | undefined` and `STRIP_HALF`, `FRONTAGE_OFF` from Task 17; `fillLots(..., landmarks?, highway?: Road)` gains the highway (pass it from `generate.ts`).
- Produces: strip blocks (`style: 'strip'`, no alleys); `stripBuildingIds` returned like `megablockFootprints` is, or derivable from `block.style === 'strip'` (prefer deriving: render looks up `blocks.find(b => b.id === building.blockId).style`) — pick deriving.

- [ ] **Step 1: Failing tests** — `lots.test.ts`: `strip blocks are packed with narrow lots facing the highway` (seed 42 coastal+river 4 km model: every block whose centroid is within `FRONTAGE_OFF + 1` of the highway and outside `STRIP_HALF` has `style 'strip'`, ≥ 3 buildings, `alleys.length === 0`, every lot bbox side along the highway ≤ 26 m, no landmark flag). `svg.test.ts`: `strip lots render in the frontage batch` (`<path data-frontage` present, count equals the strip building count, those ids absent from `[data-buildings]`). `theme.test.ts`: all themes have `frontage.fill/stroke`.
- [ ] **Step 2:** run → FAIL. **Step 3: Implement** spec §2.2: early branch in the per-block loop (after arcology/megablock branches): detect strip block, BSP along `longestEdgeAngle`, rng `mulberry32(hashSeed(seed, 'frontage'))`, split cells > 25 m, clip to inset and `subtractNoBuild`, pieces ≥ 40 m²; render batch in `landmarks.ts` (or a small `renderFrontage` in `src/render/frontage.ts`), excluded from the generic batch; theme colours per family (neon: a warm amber fill, print: a mid grey, blueprint/synthwave/tokyo-night: a brighter variant of `building.fill`).
- [ ] **Step 4:** `npx tsc -b --noEmit && npx vitest run src/gen/streets src/render src/gen/sector/generate.test.ts` → PASS. **Step 5: Commit** `feat: strip blocks with narrow lots along the highway frontage`.

### Task 19: Compound selection and geometry

**Files:**
- Modify: `src/gen/types.ts` (`Compound`, `LandmarkFlags.compound`, `BlockStyle` + `'compound'`, `SectorModel.compounds`), `src/gen/sector/generate.ts` (selection), `src/gen/streets/lots.ts` (compound branch), `lots.test.ts`, `generate.test.ts`
- Create: `src/gen/landmarks/compounds.ts` (`selectCompounds`)

**Interfaces:**
- Produces: `export function selectCompounds(districts: District[], blocks: Block[], params: SectorParams, terrain: Terrain): Array<{ id: string; blockId: string; districtId: string }>` (rng `'compounds'`, rules of spec §3.1; land area via the existing 20 m sampler or `ringArea` minus water samples); `fillLots(..., compounds?: Array<{ id; blockId }>)` → returns `compounds: Compound[]` (name `''`) with `fence`, `gate`, `center`; blocks get `style 'compound'`, `flags.compound`; a block whose inner area yields < 2 buildings is NOT turned into a compound (falls back to normal lots, dropped from the returned list).

- [ ] **Step 1: Failing tests** — `lots.test.ts`: `a compound has a fence, a gate and 2–4 buildings` (seed 42 inland 4 km corp 0.85 model: for each compound: fence vertices inside the block footprint, gate length 12 ± 1 m, gate endpoints within 1 m of the fence, 2–4 buildings all inside the fence and none within 2 m of the gate segment, `alleys.length === 0`); `compounds never sit on strip or landmark blocks`. `generate.test.ts`: `compound counts follow the power band` (three seeds × corp 0.85/0.5/0.15 at 4 km: count ≤ number of corp districts × 2; ≥ 1 on seed 42 corp 0.85); determinism (same seed → same compounds).
- [ ] **Step 2:** FAIL. **Step 3: Implement** spec §3.1–3.2; the gate side = fence edge whose midpoint is nearest the widest road within 15 m (roads passed in: `fillLots` already receives `noBuild` only — pass `roads: Road[]` too, or precompute `gateEdge` in `generate.ts` and hand `{ id, blockId, gateToward: Pt }`; prefer the latter to keep `fillLots` thin).
- [ ] **Step 4:** `npx tsc -b --noEmit && npx vitest run src/gen/streets src/gen/landmarks src/gen/sector/generate.test.ts` → PASS. **Step 5: Commit** `feat: walled corporate compounds in corp districts`.

### Task 20: Compound names, POIs and render

**Files:**
- Modify: `src/gen/names/names.ts` + both packs (`compoundPatterns`, POI type `corp_campus` zones `['corp']`), `src/gen/sector/generate.ts` (names after landmark names), `src/gen/sector/pois.ts` + `pois.test.ts`, `src/render/landmarks.ts`, `src/render/theme.ts` + `theme.test.ts` (`compound: { fence; ground }`), `src/render/svg.test.ts`

- [ ] **Step 1: Failing tests** — `pois.test.ts`: `one corp_campus POI per compound with its name` (buildingId `''`, at the centre); `names.test.ts`: both packs have ≥ 3 `compoundPatterns` and the `corp_campus` type; `svg.test.ts`: `renders compound ground and double fence with a gate gap` (`[data-compound]` count = compounds; two fence polylines per compound, each open, total fence polyline length ≈ perimeter − 12 m ± 2 m); `theme.test.ts`: new keys in all themes.
- [ ] **Step 2:** FAIL. **Step 3: Implement** spec §3.3 (`placePois(..., landmarks, compounds = [])`; render in the landmark pass before roads; ground fill `compound.ground`, fence lines 0.8 px `compound.fence`, gate span skipped on both lines).
- [ ] **Step 4:** `npx tsc -b --noEmit && npx vitest run src/gen/sector src/gen/names src/render` → PASS. **Step 5: Commit** `feat: compound names, corp campus POIs and fence render`.

### Task 21: Version, uicheck, docs, perf

**Files:** `src/gen/types.ts` (`GENERATOR_VERSION = 7`) + the tests that pin it, `tools/uicheck/check.mjs`, `ARCHITECTURE.md`, `docs/ROADMAP.md`, spec status line.

- [ ] uicheck: after the landmark block load `?seed=42&tags=coastal,river` → ≥ 1 `[data-frontage]`, screenshot `frontage.png`; load `?seed=42&tags=inland,corp-run` → ≥ 1 `[data-compound]`, screenshot `compound.png`. Run `tools/uicheck/run.sh` alone; look at both shots and describe them.
- [ ] 700 m crops: one frontage stretch and one compound on those seeds via a fresh Playwright script in `temp/`; describe.
- [ ] Perf median of 3 vs `main` (worktree under the scratchpad dir), report ratio.
- [ ] Docs: ARCHITECTURE pipeline row for frontage roads (after Landmarks) and compounds (in Lots); ROADMAP: part 2 done note, perf round next, under-deck markets as a later idea; spec status → implemented.
- [ ] Commit `docs: cyberpunk part 2 uicheck and docs` (version bump may ride in Task 20's commit if a test pins it there; otherwise here as `feat: generator version 7`).

## Plan self-review notes

- Spec coverage: §2.1 → T17, §2.2 → T18, §3.1–3.2 → T19, §3.3 → T20, §4–5 → T21 + per-task tests, §6 n/a.
- Ruling in Global Constraints resolves the level-vs-arterial ordering the spec glossed over.
- Review Focus 1–5 pinned: 1,2 → T17; 3 → T18; 4,5 → T19.
