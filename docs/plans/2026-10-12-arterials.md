# Arterials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Arterials that always end on something, flow in curves, follow shores with gaps, reach the highway through ramps, and form grids in planned areas that run into organic areas.

**Architecture:** All inside the existing tensor-field tracer. A smoothing pass runs on every streamline before it is indexed (`TraceOpts.smoothRadius`). The arterial stop rule becomes a join rule (`join.ts`: one Bézier connector used by the in-trace join, the end pass and the highway T end). The field gets a style map (plan cells) and a shore profile (setback + gaps). Half interchanges extend `buildInterchanges`.

**Tech Stack:** TypeScript, vitest (`npx vitest run --dir src`), Playwright uicheck (`PORT=4174 tools/uicheck/run.sh`).

**Spec:** `docs/specs/2026-10-12-arterials-design.md`

## Global Constraints

- Metric only. Determinism: every new random draw comes from a named stream `mulberry32(hashSeed(seed, '<stage>'))`; new streams `'shore-setback'`, `'shore-gap'` (noise seeds), `'half-interchanges'`. The dock roll (phase 2) uses the arterial stream already passed to `traceHalf`.
- Numbers (spec): planned `irr < 0.4`; plan cell 1500 m, copy probability 0.7; zone weights corp × 2 / industrial × 1.5 below 0.4, residential × 1.5 / slum × 2 at or above 0.6. `MAJOR.maxTurn = 15°` per step, `stopAtSingularity: true`. Smoothing: bend > 15°, radius 60 m arterials / 25 m streets, 10 m samples, tangent length ≤ half the shorter leg. Join: in-trace target `0.5 × sep` ahead of the foot; end pass reach `1.5 × MAJOR.separation` = 600 m, heading cone 90°, 30 m from target ends, 5 candidates. Shore: setback `30 + 120 × n1`, gap where `n2 > 0.7`, noise scale 600 m, boundary weight `1 − |dist − s| / 150`, lookahead 60 m, dock chance 0.15. Half interchanges: `IC_REACH_M` spacing, chance 0.25, ramp count `4 × full + 2 × half`.
- `GENERATOR_VERSION = 9` (phase 1; phases 2 and 3 keep 9).
- Perf: seed 42 coastal/river 4 km within +15 % of `main` in the container (median of 3 via `temp/perf/time.mts`; if the scratch file is gone, time `generateSector` on set P1 of the test file's model sets).
- Conventional Commits, no `Co-Authored-By` / "Generated with" lines (check `git log -1 --format=%B`; amend your own fresh commit if a trailer appeared). Every task: `npx tsc -b --noEmit` and the task's tests before commit; render/UI tasks run `PORT=4174 tools/uicheck/run.sh` alone and look at the shots. Ratchets only move down; a test dodge is never a fix; a failing model seed is tuned (within the spec's numbers) or reported, never excluded.
- One process at a time in the container (2 CPUs). Kill stale `vite-node` by PID, never `pkill -f`. Vitest: always `--dir src`.
- Branches: phase 1 on `spec/arterials`; phase 2 on `feat/arterials-shores` off it; phase 3 on `feat/arterials-ramps` off that. No PRs are opened by the implementer.

## Review Focus

1. A road end that was welded onto an arterial must still be within 6 m of it after that arterial is re-smoothed by the end pass (the `pinned` predicate) — Task 5 test.
2. An in-trace join whose target lies beyond the target road's end (clamp) must still end on the road, not past it — Task 3 test.
3. The end pass must never join an end to its own road or across water — Task 4 test.
4. A shore walker that cannot turn (water on both sides, peninsula tip) must stop at the bank, not loop — Task 8 test.
5. A tee crossing closer than `IC_REACH_M` to a full interchange stays a plain T end and adds no ramps — Task 11 test.

---

## Phase 1 — join rule, smoothing, style map (branch `spec/arterials`)

### Task 1: `smoothBends`

**Files:**
- Create: `src/gen/streets/smooth.ts`, `src/gen/streets/smooth.test.ts`

**Interfaces:**
- Produces: `export function smoothBends(points: Pt[], minRadius: number, pinned?: (v: Pt) => boolean): Pt[]` — returns a new array; input untouched; `points.length < 3` returned as is.
- Constants: `export const BEND_MIN = (15 * Math.PI) / 180`, `SMOOTH_STEP = 10`.

- [ ] **Step 1: Write the failing tests** (`smooth.test.ts`)

```ts
it('a right angle becomes an arc of the requested radius with sharp endpoints', () => {
  const out = smoothBends([{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }], 60)
  expect(out[0]).toEqual({ x: 0, y: 0 }); expect(out.at(-1)).toEqual({ x: 200, y: 200 })
  expect(maxBendDeg(out)).toBeLessThan(15 + 1e-6)
  // arc centre (140, 60): every point of the arc is 60 m from it
  const arc = out.filter((p) => p.x > 140 && p.y < 60)
  for (const p of arc) expect(Math.hypot(p.x - 140, p.y - 60)).toBeCloseTo(60, 6)
})
it('short legs shrink the radius to fit', () => {
  const out = smoothBends([{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }], 60)
  expect(out[0]).toEqual({ x: 0, y: 0 }); expect(out.at(-1)).toEqual({ x: 40, y: 40 })
  expect(maxBendDeg(out)).toBeLessThan(45)   // radius 20 → 90° over 3 samples of 10 m
})
it('a straight or gently bending line is unchanged', () => {
  const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 10 }]
  expect(smoothBends(pts, 60)).toEqual(pts)
})
it('a pinned vertex is kept', () => {
  const pts = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }]
  expect(smoothBends(pts, 60, (v) => v.x === 200 && v.y === 0)).toEqual(pts)
})
```
`maxBendDeg(pts)` is a local helper: the largest turn between consecutive segments, in degrees.

- [ ] **Step 2: Run** `npx vitest run --dir src src/gen/streets/smooth.test.ts` — FAIL (module missing).
- [ ] **Step 3: Implement** `smoothBends`. Per interior vertex `v` with legs `a→v`, `v→b` and turn `θ > BEND_MIN` and not pinned: tangent length `t = R · tan(θ/2)` with `R = minRadius`; if `t > min(|av|, |vb|) / 2` set `t` to that bound and `R = t / tan(θ/2)`; the arc runs from `v − t·û(av)` to `v + t·û(vb)` around the centre on the bisector, sampled every `SMOOTH_STEP` metres (at least 2 points); replace `v` by the samples. Process vertices in order on the original polyline (legs measured on the original points).
- [ ] **Step 4: Run the test file** — PASS.
- [ ] **Step 5: Commit** `feat: smoothBends replaces sharp polyline bends with arcs`

### Task 2: arterials are smoothed before indexing; turn clamp

**Files:**
- Modify: `src/gen/streets/trace.ts` (`TraceOpts`, `MAJOR`, `MINOR`, `traceHalf` singularity line, `traceLayer`)
- Test: `src/gen/streets/trace.test.ts`

**Interfaces:**
- `TraceOpts` gains `smoothRadius?: number` and `stopAtSingularity?: boolean`.
- `MAJOR = { ..., maxTurn: (15 * Math.PI) / 180, stopAtSingularity: true, smoothRadius: 60 }`, `MINOR = { ..., smoothRadius: 25 }`.
- `traceLayer` calls `smoothBends(points, opts.smoothRadius)` when set, before `index.add` and before building the `Road`.

- [ ] **Step 1: Write the failing tests** (trace.test.ts, reuse the file's existing field/terrain fixtures)

```ts
it('traceLayer smooths each streamline before indexing it', () => {
  // a field with a 90° seam (two patches at 0 and π/2); one major seed; smoothRadius 60
  const roads = traceLayer(seamField, 'major', [{ at: seedPt }], dryTerrain, 2000, new RoadIndex(200), { ...MAJOR, maxTurn: undefined, stopAtSingularity: false }, rng, () => 0.2, 'A', 'arterial')
  expect(maxBendDeg(roads[0].points)).toBeLessThan(15 + 1e-6)
})
it('arterials stop at a field singularity even with the turn clamp', () => {
  // a radial field centre: the walker reaching it must stop, not loop (points never revisit within 5 m)
})
```
- [ ] **Step 2: Run** `npx vitest run --dir src src/gen/streets/trace.test.ts -t "smooths|singularity"` — FAIL.
- [ ] **Step 3: Implement.** Singularity line becomes `if (i > 0 && (opts.stopAtSingularity ?? opts.maxTurn === undefined) && ... > SINGULARITY_TURN) break`. `traceLayer`: `const pts = opts.smoothRadius ? smoothBends(points, opts.smoothRadius) : points`.
- [ ] **Step 4: Run** the two tests and the whole trace test file — PASS; run `src/gen/sector/generate.test.ts` and record which pins fail (expected: counts/names; they are re-pinned in Task 6, not here).
- [ ] **Step 5: Commit** `feat: arterial streamlines are turn-clamped and smoothed before indexing`

### Task 3: `joinCurve` and the in-trace join

**Files:**
- Create: `src/gen/streets/join.ts`, `src/gen/streets/join.test.ts`
- Modify: `src/gen/streets/trace.ts` (`hitPar` block in `traceHalf`)

**Interfaces:**
- Produces: `export function joinCurve(p: Pt, dir: Pt, target: Pt, reject: (q: Pt) => boolean): Pt[] | null` — quadratic Bézier, control `p + dir × (|target − p| / 2)`, samples every 10 m, at least 4 points, first sample excluded (`p` is already on the road), last sample exactly `target`; null when `reject` is true for any sample.
- Produces: `export const JOIN_AHEAD = 0.5` (fraction of separation), `JOIN_REACH = 1.5` (fraction, end pass), `JOIN_CONE = Math.PI / 2`.
- trace.ts: in the `hitPar` block, for `opts.bridgeRivers` and `hitPar.cls !== 'highway'` and `!isSourceAt`: `target = index.pointAlong(hitPar, dirSign × 0.5 × sep)` (new `RoadIndex.pointAlong(hit: MatchHit, arc: number): Pt` — the point `arc` metres along the hit road from the foot, clamped to the road's ends; sign chosen so the target lies ahead of the walker). Append `joinCurve(p, dir, target, reject)` where `reject = (q) => inWater(terrain, q) || inObstacle(q) || outside window || !!index.nearest(q, 0.3 * sep, (c) => sameOrHigher(c) && c !== 'highway' && id !== hitPar.id)` (the nearest callback has no id; use `nearestMatching` with `h.id !== hitPar.id`). On null, break as today.

- [ ] **Step 1: Write the failing tests** (join.test.ts)

```ts
it('leaves along dir and ends on target', () => {
  const c = joinCurve({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 200, y: 100 }, () => false)!
  expect(c.at(-1)).toEqual({ x: 200, y: 100 })
  expect(Math.abs(c[0].y / c[0].x)).toBeLessThan(0.2)   // first sample still heading along +x
  expect(maxBendDeg([{ x: 0, y: 0 }, ...c])).toBeLessThan(15)
})
it('is null when a sample is rejected', () => {
  expect(joinCurve({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 200, y: 100 }, (q) => q.x > 100)).toBeNull()
})
```
trace.test.ts:
```ts
it('an arterial stopped by a near-parallel arterial joins it with a curve', () => {
  // uniform field angle 0; index holds arterial X along y = 150 from x = 0..2000; seed at (100, 0) heading +x inside 0.7·sep but outside 0.3·sep
  // expect: the traced road's last point lies within 1 m of y = 150, and maxBendDeg(points) < 15 + 1e-6
})
it('a join target beyond the target road end is clamped to that end', () => {
  // target road X from x = 0..120 only; the end must be within 1 m of X's end point
})
```
- [ ] **Step 2: Run** both files — FAIL.
- [ ] **Step 3: Implement** join.ts, `RoadIndex.pointAlong`, and the trace.ts change. The direction sign: `+` when `(b − a) · dir > 0` for the hit segment `a→b`.
- [ ] **Step 4: Run** both test files — PASS.
- [ ] **Step 5: Commit** `feat: arterials join a near-parallel arterial with a curve instead of stopping`

### Task 4: end pass `joinFreeEnds`

**Files:**
- Modify: `src/gen/streets/join.ts`, `src/gen/streets/join.test.ts`, `src/gen/sector/streets.ts`

**Interfaces:**
- Produces: `export function joinFreeEnds(roads: Road[], terrain: Terrain, sizeM: number, index: RoadIndex, obstacles: Pt[][]): { roads: Road[]; joined: number }` — `index` holds every road in `roads` plus the highway/frontage (built by `indexOf` in streets.ts) and is kept in sync (`index.remove(id)` + `index.add` for a changed road). Ring roads (`RING_ID_PREFIX`) are targets, never sources. Water end = `nearWater(terrain, end, 15)` (bridges.ts). Edge = within 1 m of the window. Anchored = `index.nearestMatching(end, 6, h => h.id !== road.id && h.cls === 'arterial')`.
- Candidate search: `index.forEachInRadius(end, JOIN_REACH × MAJOR.separation, …)` collecting hits with `cls === 'arterial'`, `id !== road.id`, `edge >= 30`, angle between the end heading (last 20 m of arc) and `hit.at − end` ≤ `JOIN_CONE`; sort by distance; try at most 5 with `joinCurve(end, heading, hit.at, reject)`; on success append (reverse the road first when the end is `points[0]`, then reverse back), re-smooth with `smoothBends(points, 60, pinned)` where `pinned = (v) => !!index.nearestMatching(v, 6, h => h.id !== road.id && h.edge < 1)`.
- streets.ts: `arterials = joinRiverStubs(...)`; then `({ roads: arterials } = joinFreeEnds(arterials, terrain, sizeM, indexOf(arterials), plazas))`; then `pruneDangling` as today.

- [ ] **Step 1: Write the failing tests** (join.test.ts, small synthetic road sets, dry terrain fixture from trace.test.ts)

```ts
it('a free end curves into the nearest arterial ahead', () => { /* A ends at (500, 0) heading +x; B runs x = 800, y = -500..500: A's new end within 1 m of B, maxBendDeg < 15 + 1e-6, joined = 1 */ })
it('never joins its own road, and never across water', () => { /* own road only → unchanged; water strip between → unchanged, joined = 0 */ })
it('ignores targets outside the heading cone', () => { /* B behind A → unchanged */ })
it('a road ending on A stays anchored after A is re-smoothed', () => { /* C ends on A's corner vertex; after joinFreeEnds (A joins something else), C's end is still within 6 m of A */ })
```
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** `joinFreeEnds` and wire it in `streets.ts`.
- [ ] **Step 4: Run** join tests, then `src/gen/sector/generate.test.ts -t "arterial"` — join tests PASS; note generate failures for Task 6.
- [ ] **Step 5: Commit** `feat: free arterial ends join the nearest arterial instead of being pruned`

### Task 5: re-smooth after river joins; prune becomes last resort

**Files:**
- Modify: `src/gen/sector/bridges.ts` (`joinRiverStubs`), `src/gen/streets/trace.ts` (`pruneDangling` returns count), `src/gen/sector/streets.ts`, `src/gen/sector/generate.ts` (expose), `src/gen/sector/generate.test.ts`

**Interfaces:**
- `joinRiverStubs` re-smooths every road it concatenated with `smoothBends(points, 60, pinned)` (same pinned predicate, using its `index` argument).
- `pruneDangling` keeps its signature. `TracedRoads` gains `pruned: number`: the number of arterials the arterial prune dropped or cut (`before.length − after.length` plus roads whose `points` array is a new object). The test calls `traceRoads(p, sampleTerrain(p, sizeM), sizeM)` directly (`sampleTerrain` from `src/gen/terrain`, as `generate.ts` does); `terrainFor(p)` below is that call.

- [ ] **Step 1: Write the failing test** (generate.test.ts, new `describe('arterial ends (model seeds)')` with the 12 parameter sets copied from `temp/perf/sets.mts` as a `const MODEL_SETS` in the test file; `resolveTags` from `src/app/tags`):

```ts
for (const [name, p] of Object.entries(MODEL_SETS)) {
  it(`${name}: every arterial end is anchored and nothing was pruned`, { timeout: 120000 }, () => {
    const t = traceRoads(p, terrainFor(p), p.size * 1000)     // terrainFor: the same call generateSector makes (see generate.ts)
    expect(t.pruned, 'prune fired').toBe(0)
    const idx = new RoadIndex(200); for (const r of [...t.arterials, ...(t.highway ? [t.highway] : [])]) idx.add(r.id, r.points, r.class)
    for (const r of t.arterials) for (const e of [r.points[0], r.points.at(-1)!]) {
      if (ring(r)) continue
      const ok = onEdge(e) || idx.nearestMatching(e, 6, (h) => h.id !== r.id && h.cls === 'arterial') || nearWater(t.terrain, e, 15)
      expect(ok, `${name} ${r.id}`).toBeTruthy()
    }
    for (const r of t.arterials) expect(maxBendDegInterior(r.points, 15), `${name} ${r.id} bend`).toBeLessThan(15 + 1e-6)
  })
}
```
`maxBendDegInterior(pts, skipM)` ignores vertices within `skipM` of either end.

- [ ] **Step 2: Run** `npx vitest run --dir src src/gen/sector/generate.test.ts -t "arterial ends"` — FAIL where the prune still fires or bends remain. Record per seed.
- [ ] **Step 3: Implement** the bridges.ts re-smooth and the `pruned` count. Tune within the spec (candidate count, cone) until the prune count is 0 on all 12 sets; if a seed cannot reach 0 within the spec's numbers, report it in the task summary with the end's coordinates and reason instead of excluding the seed.
- [ ] **Step 4: Run** the describe — PASS.
- [ ] **Step 5: Commit** `feat: river joins re-smoothed; arterial prune is a last resort`

### Task 6: style map and zoning bias

**Files:**
- Modify: `src/gen/streets/field.ts` (`buildPatches`), `src/gen/sector/zoning.ts` (`zoneWeights`, `assignZones`), `src/gen/streets/field.test.ts`, `src/gen/sector/zoning.test.ts`

**Interfaces:**
- `buildPatches` unchanged signature; internally `const PLAN_CELL = 1500`, `PLAN_COPY = 0.7`, `PLANNED_BELOW = 0.4`; a `Map<number, number>` of drawn cell angles keyed `ix * 100003 + iy`.
- `zoneWeights(params: SectorParams, shore: boolean, irr: number)`.

- [ ] **Step 1: Write the failing tests**

field.test.ts:
```ts
it('planned patches in one plan cell share an angle; organic patches do not', () => {
  // params irregularity 0.15 (planned bias) → most of the map is planned: for patches whose irr < 0.4 and same 1500 m cell, angles equal; with irregularity 0.85 at least two patches in one cell differ
})
```
zoning.test.ts:
```ts
it('zone weights follow the style', () => {
  const w = zoneWeights(params, false, 0.2); expect(w.corp).toBeCloseTo(2 * zoneWeights(params, false, 0.5).corp)
  const o = zoneWeights(params, false, 0.7); expect(o.slum).toBeCloseTo(2 * zoneWeights(params, false, 0.5).slum)
})
```
- [ ] **Step 2: Run** both files — FAIL.
- [ ] **Step 3: Implement.** In `buildPatches`, pass `irr` (already built) into the per-patch loop: `planned = !shore && irr(center) < PLANNED_BELOW`; planned → `angle = cellAngle(cell)` where `cellAngle` draws `rng.next()` for the copy roll then (if not copied) `rng.next() * Math.PI` for the angle; the second loop (shore copy / random) skips planned patches. In `assignZones`, compute `eff = effective(ringCentroid(poly))` before `zoneWeights(params, shore, eff)`.
- [ ] **Step 4: Run** both files — PASS.
- [ ] **Step 5: Commit** `feat: planned areas share grid angles per plan cell; zoning follows the style`

### Task 7: version 9, re-pins, uicheck scenes, docs

**Files:**
- Modify: `src/gen/types.ts` (`GENERATOR_VERSION = 9`), `src/gen/sector/generate.test.ts` and every other test with a pinned count/name that moved, `tools/uicheck/check.mjs`, `docs/ROADMAP.md`, `ARCHITECTURE.md` (one line on join.ts/smooth.ts in the code map)

- [ ] **Step 1: Run** the full suite `npx vitest run --dir src` (≈ 10 min). Collect every failure.
- [ ] **Step 2: Re-pin** moved counts/names with the comment `// arterials re-roll (v9)`; ratchets (block size limits, minimum counts) may only tighten or stay; a loosened ratchet must be listed in the task summary with the before/after value for the user to decide. Any failure that is a real defect (dangling, crossing water, degenerate road) is fixed, not re-pinned.
- [ ] **Step 3: uicheck.** Add after the `streets-sprawl-river` scene:
```js
await page.goto(`${BASE}/?seed=42&tags=inland,planned,corp-run`)
await page.waitForSelector('svg'); await page.screenshot({ path: `${OUT}/arterials-grid.png` })
if ((await countAttr(page, 'svg [data-junctions]')) < 20) fail('arterials-grid: too few crossroads')
await page.goto(`${BASE}/?seed=42&tags=coastal,river,arcology`)
await page.waitForSelector('svg'); await page.screenshot({ path: `${OUT}/arterials-coast.png` })
if ((await page.locator('svg [data-bridge]').count()) < 1) fail('arterials-coast: no bridge rendered')
```
Run `PORT=4174 tools/uicheck/run.sh`; open both PNGs and describe in the summary what the arterials look like (corners, free ends, the west peninsula).
- [ ] **Step 4: Perf** — median of 3 of P1 vs main; report the numbers.
- [ ] **Step 5: Docs.** ROADMAP: nothing removed yet (phases 2/3 pending); ARCHITECTURE code map gains `streets/join.ts`, `streets/smooth.ts`.
- [ ] **Step 6: Run** `npx tsc -b --noEmit` and the full suite — PASS. Commit in two: `test: re-pin seeds for the arterial re-roll (v9)` and `feat: generator version 9; uicheck arterial scenes`.

## Phase 2 — shores (branch `feat/arterials-shores`)

### Task 8: shore profile and boundary basis

**Files:**
- Modify: `src/gen/streets/field.ts`, `src/gen/streets/field.test.ts`

**Interfaces:**
- Produces: `export function shoreProfile(params: SectorParams): { setback(p: Pt): number; gap(p: Pt): boolean }` — `fractalNoise2D(hashSeed(seed, 'shore-setback'), 2)` and `'shore-gap'`, both sampled at `p / 600`; `setback = 30 + 120 × n1`, `gap = n2 > 0.7`.
- `boundaryBasis(terrain, profile)` weight: `gap(p) ? 0 : clamp(0, 1, 1 − |dist − setback(p)| / 150)`.
- `buildBasisFields` builds the profile once and passes it; `buildRoadField` unchanged signature.

- [ ] **Step 1: Tests:** `shoreProfile` is deterministic per seed and setback stays within 30..150 over 1000 random points; `boundaryBasis` weight is 0 at the water line, 1 at the setback, 0 at setback + 150, 0 in a gap (construct the profile by hand for the test: pass `{ setback: () => 80, gap: () => false }`).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat: shore profile sets the waterfront setback and gaps`

### Task 9: shore steer and dock ends

**Files:**
- Modify: `src/gen/streets/trace.ts` (`traceHalf`), `src/gen/streets/trace.test.ts`

**Interfaces:**
- Constants `SHORE_LOOKAHEAD = 60`, `DOCK_CHANCE = 0.15`; `TraceOpts.shoreLookahead?` (highway 200, via `HIGHWAY_OPTS`), the dock roll only when `opts.bridgeRivers` (never the highway). Spec §5.3 last paragraph: the highway steers along the coast too; add a highway.test.ts case on seed 1584279735 (coastal, small, sparse, corp-run, normal, mixed, river) asserting the highway reaches a second edge.
- In `traceHalf`, arterials only (`opts.bridgeRivers`), before the `inWater(next)` block: `ahead = p + dir × SHORE_LOOKAHEAD`; if `inWater(terrain, ahead)` and not `inRiverBand(...)` (so the bridge rule keeps priority) and `!dock`: if `!dockDecided` → `dockDecided = true; dock = rng.chance(DOCK_CHANCE)`; if `!dock` → `rawDir = shore tangent at p (shoreTangent(terrain, p, SHORE_LOOKAHEAD + opts.step)) sign-resolved toward dir`, then the clamp applies as usual. A walker whose `next` is in water still breaks (bank stop: dock end or a tip it could not turn around).

- [ ] **Step 1: Tests** (trace.test.ts, a terrain fixture with a straight coast at y = 1000, land below):
```ts
it('an arterial heading at the coast turns and runs along it', () => { /* seed at (500, 500) heading +y; expect: the road's last point is not within 15 m of water OR the road has ≥ 30 points with y between 850 and 1000; maxBendDeg < 15 + 1e-6 */ })
it('a dock walker ends at the bank', () => { /* rng stub whose chance() returns true: last point within 15 m of water, points never revisit (no loop) */ })
it('a walker at a peninsula tip stops at the bank', () => { /* water on three sides within 60 m: the trace ends, point count bounded, no point in water */ })
```
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** trace tests — PASS.
- [ ] **Step 5: Commit** `feat: arterials turn along the shore; a seeded few end at the dock`

### Task 10: phase 2 pins, waterfront test, uicheck

**Files:**
- Modify: `src/gen/sector/generate.test.ts`, re-pinned tests, `tools/uicheck/check.mjs` (no new scene; `arterials-coast` is looked at), `docs/ROADMAP.md`

- [ ] **Step 1: Test** on P1 (`describe('waterfront arterials (seed 42)')`): at least one arterial has a contiguous run ≥ 400 m within 150 m of the sea (`maxCloseRun` from testutil against the water rings); water ends ≤ 20 % of arterial ends; at least one shore stretch > 300 m of arc has no arterial within 150 m (sample the largest sea ring every 50 m). Also re-run the Task 5 model-seed describe (prune still 0, bends still ≤ 15°).
- [ ] **Step 2: Run** the full suite; re-pin as in Task 7 Step 2 with comment `// arterials re-roll (v9, shores)`.
- [ ] **Step 3: uicheck**, look at `arterials-coast.png` and `streets-sprawl-river.png`; describe the waterfront.
- [ ] **Step 4: ROADMAP:** remove "Arterials at water fronts".
- [ ] **Step 5: Commit** `test: waterfront arterial invariants and re-pins` and `docs: roadmap drops the waterfront item`

## Phase 3 — half interchanges (branch `feat/arterials-ramps`)

### Task 11: T ends on the highway

**Files:**
- Modify: `src/gen/streets/join.ts` (`joinFreeEnds` gets `highway?: Road`), `src/gen/streets/trace.ts` (`PruneOpts.acceptEnd?: (cls: RoadClass, at: Pt) => boolean`), `src/gen/sector/streets.ts`, `src/gen/streets/join.test.ts`

**Interfaces:**
- `joinFreeEnds(roads, terrain, sizeM, index, obstacles, highway?)`: an end with no join candidate whose road crosses the highway (`segmentCrossesPolyline` per road segment, last crossing nearest the end) is cut at that crossing point if the crossing angle is ≥ 45° and the remaining road ≥ 300 m; the crossing point becomes the end (exactly on the highway polyline). Returns `{ roads, joined, tees: number }`.
- `pruneDangling` accepts an end when `opts.acceptEnd?.(hit.cls, end)` is true; streets.ts passes `acceptEnd: (c, at) => c === 'highway' && distToPolyline(at, highway.points) <= 1`.

- [ ] **Step 1: Tests:** an arterial crossing a highway and ending free beyond it with no arterial within 600 m is cut at the crossing (end within 1 mm of the highway); a crossing at 30° is not cut (end stays free); a road that would be < 300 m after the cut stays as is. Prune test: an arterial ending exactly on the highway survives the arterial prune when `acceptEnd` is passed.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** join + trace tests — PASS.
- [ ] **Step 5: Commit** `feat: an unjoinable arterial beyond the highway ends on it as a T`

### Task 12: half interchanges

**Files:**
- Modify: `src/gen/types.ts` (`HighwayCrossing.tee?: boolean; half?: boolean`), `src/gen/streets/highway.ts` (`highwayCrossings`, `buildInterchanges`), `src/gen/sector/generate.ts` (rng stream), `src/gen/streets/highway.test.ts`, `src/gen/sector/generate.test.ts` (ramp count test)

**Interfaces:**
- `highwayCrossings`: an arterial whose end lies within 1 m of the highway yields `{ roadId, at, kind, interchange: false, tee: true }` (the `atEnd` skip applies to streets only; keep it for streets).
- `buildInterchanges(highway, crossings, roads, segments, terrain, sizeM, rng: Rng)`: full interchanges as today, never on a tee. Then every tee gets `half: true` and two ramps (the `rampTriples` side where the arterial lies: the side whose `ta` is inside the road) when they fit and the tee is ≥ `IC_REACH_M` from every chosen crossing. Then chance ramps: non-tee crossings, highway order, `squareEnough && continues && ≥ IC_REACH_M from all chosen` → `rng.chance(0.25)` → side `rng.chance(0.5) ? -1 : 1` → `half: true` + 2 ramps if that side fits. Ramp ids continue `R<n>`.
- generate.ts: `buildInterchanges(..., mulberry32(hashSeed(params.seed, 'half-interchanges')))`.

- [ ] **Step 1: Tests** (highway.test.ts): a tee crossing gets exactly 2 ramps on the arterial's side; a tee within `IC_REACH_M` of a full interchange gets none; chance ramps never appear within `IC_REACH_M` of another interchange; generate.test.ts: `ramp count is 4 × full + 2 × half` replaces the ×4 test; `every tee crossing meets the highway at ≥ 45°`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** highway + generate ramp tests — PASS.
- [ ] **Step 5: Commit** `feat: half interchanges at arterial T ends and by chance at crossings`

### Task 13: phase 3 pins, uicheck, docs

- [ ] **Step 1:** full suite; re-pin with `// arterials re-roll (v9, ramps)`; model-seed describe and waterfront describe still green.
- [ ] **Step 2:** uicheck: `arterials-grid` asserts `countAttr(page, 'svg [data-ramps]') >= 6`; look at the shots.
- [ ] **Step 3:** ROADMAP: remove "Half interchanges"; ARCHITECTURE invariant line: "an arterial never ends free: it joins, ends at water, the edge, or the highway as a T".
- [ ] **Step 4:** perf check as in Task 7 Step 4.
- [ ] **Step 5: Commit** `test: re-pins for half interchanges` and `docs: roadmap and architecture for the arterial round`
