# Streets Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the four street-layer defect mechanisms (stranded-street rule, doubled frontage, converging doubles, ring seeding/hairpins) so seed 42 drops from 79 free street ends and 50 doubled pairs to a handful and 0.

**Architecture:** All changes sit in the sector street pipeline: `infillFaces` / `generateSector` (src/gen/sector/generate.ts), `traceRoads` (src/gen/sector/streets.ts), and one new helper file `src/gen/streets/cleanup.ts` for the converge-and-weld and street-hairpin rules. No tracer, arterial or highway change.

**Tech Stack:** TypeScript, vitest (`npx vitest run --dir src …`, one process at a time, never `pkill -f`), Playwright uicheck (`PORT=4174 tools/uicheck/run.sh`).

**Spec:** docs/specs/2026-10-13-streets-cleanup-design.md

## Global Constraints

- Metric only. Conventional Commits, no `Co-Authored-By` / "Generated with" trailers (check `git log -1 --format=%B`). `npx tsc -b --noEmit` before each commit.
- A test dodge is never a fix; ratchets never loosen (report the number instead). Pins that re-roll (names, counts) are re-pinned in one `test:` commit per task with old/new in the comment.
- GENERATOR_VERSION stays 9. Scratch under `temp/` (ignore `temp/inv*`, foreign worktrees). Never leave Node-only globals (`process.env`) in `src`, even uncommitted: the user's dev server serves the working tree.
- Reference seeds: 42 `coastal,medium,dense,fringe,lively,mixed,river,arcology` 4 km; 426750495 `inland,small,dense,balanced,quiet,sprawl,river` 2 km; 2268324149 `coastal,medium,packed,balanced,quiet,planned` 4 km. Generate via `generateSector({ ...base, seed, size, …tags })` as the existing tests do (see `MODEL_SETS` in generate.test.ts for how tags become params).

## Review Focus

1. A street welded by 2.4 onto a road it merely crosses at a shallow angle: the cut must land on the other road (≤ 1 m), never leave a 5–8 m gap. Task 3 test `welds at first contact`.
2. The final prune (2.2) removing a piece that is a block edge: blocks would then have a phantom side. Task 1 asserts `no road runs through a block` and block counts unchanged on the reference seeds beyond re-rolls.
3. Frontage polyline offset at a sharp ring corner (miter cap): the cap must keep the piece inside the ring; Task 2 unit test has a 60° corner.
4. Ring outward seeding on a half ring: its open ends still get seeds (spokes), streets must not vanish on the open side. Task 4 counts streets touching each K road ≥ 4.
5. A decay cul-de-sac must survive the final prune. Task 1 asserts the decay-end count on seed 42 before/after the prune is equal.

---

### Task 1: stranded streets against the whole network + final street prune (spec 2.1, 2.2)

**Files:**
- Modify: `src/gen/sector/generate.ts:224-230` (stranded rule), `src/gen/sector/generate.ts:331-335` (final prune)
- Modify: `src/gen/sector/streets.ts` (`TracedRoads.decayEnds`), remove the ponytail notes in `withTrimmedFrontage` that say the decay set is unavailable (keep its behaviour).
- Test: `src/gen/sector/generate.test.ts` new describe `street free ends`

**Interfaces:**
- Produces: `TracedRoads.decayEnds: Pt[]`; `generateSector` internal `finalStreetPrune(streets: Road[], all: Road[], terrain, sizeM, decayEnds: Pt[]): Road[]`.

- [ ] **Step 1: Write the failing test** — `describe('street free ends')`: for each reference seed, generate once (`beforeAll`, timeout 120000), build a `RoadIndex(200)` of every road, count street/infill ends that are > 6 m from any other road (`nearestMatching(p, 6, h => h.id !== r.id)` null), not `onWindowEdge(p, sizeM, 1)`, not within 15 m of water (`inWater` on a 15 m 8-point star), not inside a plaza/core. Log the list with ids and positions. Assert `expect(free.length).toBeLessThanOrEqual(BOUND)` with BOUND = 15 for seed 42 (provisional; set to the measured value at the end of Task 5, comment records the before value 79).
- [ ] **Step 2: Run it** — `npx vitest run --dir src -t "street free ends"` → FAIL on seed 42 (79).
- [ ] **Step 3: Stranded rule** — generate.ts:227–228: the anchor set is `[...others, ...roads, ...pieces]` minus `r` itself and minus already-dropped ids.
- [ ] **Step 4: decay ends out** — streets.ts: add `decayEnds` to `TracedRoads` and return it. generate.ts: after `infillFaces`, build the full index (hw, arterials, ramps, minor, infill) and run `pruneDangling([...minor, ...infill], index, terrain, sizeM, { accept: c => c !== 'highway', interiorOnly: true, minLength: 60, keep: new Set(decayEnds.map(endKey)), waterAnchor: streetWaterAnchor(terrain, sizeM) })`; the result replaces `minor`/`infill` in the `markWetSpans` call (keep infill ids identifiable: filter by id set afterwards).
- [ ] **Step 5: Run the new describe and the block tests** — `npx vitest run --dir src -t "street free ends|runs through a block|block size|lakes bound"` → free ends on seed 42 well under 30 (report the number); block tests green or re-pin with numbers.
- [ ] **Step 6: Commit** — `fix: stranded streets are judged against every road, final street prune keeps decay ends`

### Task 2: one frontage polyline per face side, infill twins (spec 2.3, 2.4 last paragraph)

**Files:**
- Modify: `src/gen/sector/generate.ts:72-87` (`frontageOf`), `:128-219` (polyline-aware `add`, `inCore`, `reach`, weld, twin check)
- Test: `src/gen/sector/generate.test.ts` (`frontageOf` exported for the unit test; `no doubled streets` describe)

**Interfaces:**
- Produces: `export function frontageOf(f: { footprint: Pt[] }, highway: Road): Pt[][]` — one polyline per run.

- [ ] **Step 1: Failing unit test** — a square-ish face whose south side is three edges along a curved highway polyline (vertices every 80 m, turning 20° per vertex), highway 0–6 m from those edges: `frontageOf` returns exactly 1 polyline, every point ≥ 20 m inside the ring, and no two of its segments overlap (consecutive points strictly advance along the highway direction). Add a second face with a 60° corner between two highway-side edges: all points inside the ring.
- [ ] **Step 2: Failing doubled test** — `describe('no doubled streets')`: per reference seed, for every pair of street-class roads, sample A every 5 m, count consecutive samples within 6 m of B; a run > 20 m is a doubled pair. Assert the pair list `toEqual([])`. (Expect ~50 on seed 42 before.)
- [ ] **Step 3: Run both** → FAIL.
- [ ] **Step 4: Implement** per spec 2.3: runs of consecutive highway-side ring edges (wrap around the ring start), offset polyline with bisector normals and the `2 × FRONTAGE_M` cap, 60 m extension only at run ends, `clipSegmentToRing` per segment then re-chain into one polyline (a clip that splits a run yields two roads). `add(points: Pt[])` builds the piece; `inCore` samples every segment; `reach` and the weld iterate every segment of every piece; the cut-stop `segCross` iterates frontage segments. Twin check: before `add` of a BSP cut, skip it when more than 20 m of it lies within 15 m of, and within 15° of, any existing piece or any street inside the face.
- [ ] **Step 5: Run** `npx vitest run --dir src -t "frontage|doubled|street free ends|runs through a block"` → the unit test green; seed 20 `frontage` describe green; doubled pairs on seed 42 down to the traced-converging class only (report the remaining list; Task 3 clears it).
- [ ] **Step 6: Commit** — `fix: one frontage piece per face side along the highway, no infill twin cuts`

### Task 3: converge-and-weld (spec 2.4)

**Files:**
- Create: `src/gen/streets/cleanup.ts`, `src/gen/streets/cleanup.test.ts`
- Modify: `src/gen/sector/generate.ts` (call before the final prune)

**Interfaces:**
- Produces: `export function weldConverging(streets: Road[], index: RoadIndex, opts?: { near?: number; run?: number; minLength?: number }): Road[]` — defaults 8 m, 20 m, 60 m; `index` holds every road; streets are the roads to cut (class street), returned in order, ids unchanged.

- [ ] **Step 1: Failing tests** in cleanup.test.ts: (a) street B runs parallel to road A 4 m away for 60 m then diverges → B is cut at its first sample within 8 m, its new end within 1 m of A, length of the kept part > 0; (b) B starts on A and runs along it 30 m then leaves → kept part is the tail, start welded on A; (c) B crosses A at 60° → unchanged (run < 20 m); (d) remainder 40 m → dropped.
- [ ] **Step 2: Run** → FAIL (module missing).
- [ ] **Step 3: Implement** with `index.nearestMatching(q, near, h => h.id !== r.id && h.cls !== 'highway')`, 5 m samples via the same stepping `pruneDangling` uses; track the run by hit id. `ponytail:` middle runs keep the part before.
- [ ] **Step 4: Wire** in `generateSector` before the final prune of Task 1, on `[...minor, ...infill]` against the full index; rebuild the index after.
- [ ] **Step 5: Run** `npx vitest run --dir src/gen/streets/cleanup.test.ts` then `-t "doubled|street free ends|runs through a block|block size"` → doubled pairs = 0 on all three seeds.
- [ ] **Step 6: Commit** — `fix: a street converging on another road is welded at first contact`

### Task 4: ring seeds outward, street hairpins (spec 2.5)

**Files:**
- Modify: `src/gen/sector/streets.ts:140` (ring seeds), `src/gen/streets/cleanup.ts` (`dropStreetHairpins`)
- Test: `src/gen/streets/cleanup.test.ts`, `src/gen/sector/generate.test.ts` (`no ring-band streets` in the existing `no hairpin spokes` describe or beside it)

**Interfaces:**
- Produces: `export function dropStreetHairpins(streets: Road[], index: RoadIndex, chord = 40, maxLength = 80): Road[]`.

- [ ] **Step 1: Failing tests** — unit: a 70 m U with both ends on one road 25 m apart → dropped; a 70 m street between two different roads → kept; a 300 m crescent on one road → kept. Sector: seed 42 arcology: no street has both ends within 6 m of a `K` road; no street sample inside the ring-minus-plaza band unless that street crosses the ring (sample every 10 m); each K road still has ≥ 4 streets/spokes touching it.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — streets.ts:140: for arterials with a `K` id, seeds from `seedsAlong(points, 100, false)` get `dir` = outward radial from the owning arcology centre (`arcologies[i]` pairs with `ringsOrNull[i]`), `axis: 'major'`, `oneWay: true`; other arterials unchanged. `dropStreetHairpins` after `prunedStreets` in `traceRoads`.
- [ ] **Step 4: Run** the tests plus `-t "no hairpin spokes|landmarks in road tracing|street free ends"` → green or re-pins with numbers.
- [ ] **Step 5: Commit** — `fix: ring roads seed streets outward only, street hairpins are dropped`

### Task 5: measure, suite, uicheck, ratchets

**Files:**
- Modify: `src/gen/sector/generate.test.ts` (final BOUND per seed, re-pins), `tools/uicheck/check.mjs` (zoomed scene)
- Report: `.superpowers/sdd/2026-10-13-streets-cleanup/task-5-report.md`

- [ ] **Step 1: Measure** with a scratch script under `temp/cleanup/` (model it on `temp/inv/temp/p12.ts`, do not modify temp/inv): per reference seed, free ends by cause, doubled pairs, infill count, blocks > 60 000 m², on `main` (worktree `temp/inv/temp/main` is d2215e3 — use `git worktree add temp/cleanup-main main` instead) and on HEAD. Table in the report.
- [ ] **Step 2: Set the free-end BOUND** per seed to the measured value (comment: before/after, decay share).
- [ ] **Step 3: Full suite** `npx vitest run --dir src` once; list every red with numbers; re-pin count/name pins in one `test: re-pin seeds after the streets cleanup` commit; invariants stay red and are reported.
- [ ] **Step 4: uicheck** — add scene `streets-highway`: seed 42 with the reference tags, zoomed on the highway landing east of the river bridge (around x 1850–2450, y 1900–2350). If `check.mjs` scenes have no zoom option, add `view: { x, y, w, h }` that sets the SVG viewBox before the shot. Run `PORT=4174 tools/uicheck/run.sh`, look at `streets-highway.png`, `arterials-grid.png`, `arterials-coast.png`, `landmarks-arcology.png`; two sentences each.
- [ ] **Step 5: Commit** — `test: street free-end ratchets, uicheck streets-highway scene`
