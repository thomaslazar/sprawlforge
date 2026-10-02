# Tensor-Field Streets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace twisted-bisection streets with roads traced through a tensor field; districts and blocks become faces of the road graph; the highway gets per-district levels, interchanges and ramps.

**Architecture:** New `src/gen/streets/` package (field → trace → graph → highway → lots) slots into `generateSector` ahead of zoning. Terrain, zoning lottery, names, POIs, piers, worker, tags and exports stay. `src/gen/partition/`, `sector/roads.ts`, `sector/buildings.ts` are deleted; `sector/bridges.ts` shrinks to wet-span marking.

**Tech Stack:** TypeScript, vitest, `polygon-clipping` (face↔land clip and lot clip only), Playwright (toy screenshots, uicheck). No new dependencies.

**Spec:** `docs/specs/2026-09-29-tensor-streets-design.md`

## Global Constraints

- Metric only: meters everywhere, no imperial units in code, UI, docs, exports.
- Determinism: all randomness via `mulberry32(hashSeed(params.seed, '<stage>'))`; never `Math.random()`/`Date.now()`. Same params → deep-equal `SectorModel`.
- Window containment: every generated point lies inside `[0, sizeM]²`.
- `GENERATOR_VERSION` = 5.
- Perf budget in the worker: 4 km ≤ 1.5 s, 6 km ≤ 4 s.
- Conventional Commits, no `Co-Authored-By`, no "Generated with" lines.
- Every task runs `npm test` green before commit; tasks touching render/UI run `tools/uicheck/run.sh` and look at the screenshots.
- Plain-language `ponytail:` comments mark deliberate ceilings.

## Review Focus

1. Inland sector, no water at all: patches have no shore neighbour to bias toward; field must still be defined everywhere (Task 2 test `inland sector has no NaN angles`).
2. Sector where the river runs along a window edge or the highway seed axis is nearly parallel to the river: highway crossing seed must still exist exactly once or be skipped cleanly, never two (Task 5 test `highway crosses river at most once`).
3. Seed where the highway passes through only one district: zero level changes, one segment (Task 8 test `single district → one segment, no transition`).
4. Blocks whose face touches the window edge or the coast: faces must close via boundary pseudo-edges, not leak into one giant outer face (Task 4 test `faces close against window and land boundary`).
5. 2 km sector (smallest): queue and step caps must not starve minor roads to zero (Task 10 test `2 km sector still has streets and buildings`).

---

### Task 1: Types, version, theme keys

**Files:**
- Modify: `src/gen/types.ts`
- Modify: `src/render/theme.ts`
- Test: `src/render/theme.test.ts` (create)

**Interfaces:**
- Produces: `RoadClass` gains `'ramp'`; `HighwayLevel`, `HighwaySegment`, `HighwayCrossing`; `Road.segments?`, `Road.crossings?`; `District.flags`, `Block.flags`; `Theme.road.ramp`, `Theme.highway: { trench: string; column: string; hatch: string }`; `GENERATOR_VERSION = 5`.

- [ ] **Step 1: Write the failing test**

```ts
// src/render/theme.test.ts
import { describe, expect, it } from 'vitest'
import { THEMES } from './theme'

describe('themes', () => {
  it('every theme defines ramp and highway level colours', () => {
    for (const t of Object.values(themes)) {
      expect(t.road.ramp).toMatch(/^#[0-9a-f]{6}$/i)
      for (const k of ['trench', 'column', 'hatch'] as const) expect(t.highway[k]).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })
})
```

Check how themes are exported in `theme.ts` (`THEMES` map or array) and import accordingly.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/render/theme.test.ts`
Expected: FAIL, `ramp`/`highway` undefined.

- [ ] **Step 3: Add types in `src/gen/types.ts`**

Exactly as spec §13: `RoadClass = 'highway' | 'arterial' | 'street' | 'ramp'`, `HighwayLevel`, `HighwaySegment { from; to; level; districtId; transition }`, `HighwayCrossing { roadId; at; kind: 'over' | 'under'; interchange }`, `Road.segments?: HighwaySegment[]`, `Road.crossings?: HighwayCrossing[]`, `flags: Record<string, never>` on `District` and `Block`. `GENERATOR_VERSION = 5`.

- [ ] **Step 4: Add theme keys**

In `Theme`: `road: Record<RoadClass, string>` now needs `ramp`; add `highway: { trench: string; column: string; hatch: string }`. Fill all five themes: ramp = a colour between arterial and street; trench = slightly darker than `bg`; column = `bridge.shadow`; hatch = `bridge.deck`.

- [ ] **Step 5: Fix compile fallout**

Run: `npx tsc -b --noEmit`
Expected: errors only where `District`/`Block` literals lack `flags` (`zoning.ts`, `buildings.ts`, tests). Add `flags: {}` to each. `assignZones` gets `flags: {}` in its returned literal.

- [ ] **Step 6: Run all tests, commit**

Run: `npm test`
Expected: PASS.

```bash
git add src/gen/types.ts src/render/theme.ts src/render/theme.test.ts src/gen/sector/zoning.ts src/gen/sector/buildings.ts
git commit -m "feat: road class ramp, highway level types, generator version 5"
```

---

### Task 2: Road field (`streets/field.ts`)

**Files:**
- Create: `src/gen/streets/field.ts`
- Test: `src/gen/streets/field.test.ts`

**Interfaces:**
- Consumes: `effectiveIrregularity(params)` from `sector/zoning.ts`; `fractalNoise2D` from `terrain/noise.ts`; `nearestOnPolyline` from `terrain/rivers.ts`; `Terrain`.
- Produces:

```ts
export interface Patch { center: Pt; angle: number; size: number; shore: boolean }
export interface FieldSample { major: Pt; minor: Pt } // unit vectors, minor ⟂ major
export interface BasisField {
  name: 'grid' | 'boundary' | 'noise' | 'spine'
  /** line-field angle in radians, or null when this basis has nothing to say at p */
  angle(p: Pt): number | null
  weight(p: Pt): number
}
export interface RoadField { sizeM: number; patches: Patch[]; sample(p: Pt): FieldSample }
export function shoreTangent(terrain: Terrain, p: Pt): { angle: number; dist: number } | null
export function buildPatches(params: SectorParams, terrain: Terrain, sizeM: number): Patch[]
export function buildBasisFields(params, terrain, sizeM, patches, extra?: BasisField[]): BasisField[]
export function buildRoadField(params: SectorParams, terrain: Terrain, sizeM: number, extra?: BasisField[]): RoadField
```

- [ ] **Step 1: Write the failing tests**

```ts
// src/gen/streets/field.test.ts
const params = (over: Partial<SectorParams> = {}): SectorParams => ({
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5, irregularity: 0.5,
  landform: 'coastal', river: true, lakes: false, islands: false, piers: false, pack: 'generic', theme: 'neon', ...over,
})
const lineAngleDiff = (a: number, b: number) => { let d = Math.abs(a - b) % Math.PI; return Math.min(d, Math.PI - d) }

it('is deterministic', ...)                       // two builds → same patches, same samples on a 200 m grid
it('patch size follows irregularity', ...)        // irregularity 0.15 → all sizes ≥ 700; 0.85 → all ≤ 600
it('shore patches take the shore tangent', ...)   // for every patch with shore=true: lineAngleDiff(patch.angle, shoreTangent(terrain, patch.center).angle) < 5°
it('inland sector has no NaN angles', ...)        // landform 'inland', river false: sample on 100 m grid, every major vector finite and |major| ≈ 1
it('seams are continuous away from water', ...)   // 20 m grid, adjacent cells both > 250 m from water: lineAngleDiff(majorAngle) < 30°
it('minor is perpendicular to major', ...)        // dot(major, minor) ≈ 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/gen/streets/field.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `shoreTangent`, `buildPatches`**

`shoreTangent`: nearest edge over all `terrain.water` rings plus `terrain.riverSlice?.course`; return that edge's direction angle and distance (use `nearestOnPolyline` per ring, closing rings). Null when no water.

`buildPatches`: jittered lattice over `[-500, sizeM + 500]²`. Base spacing from `effectiveIrregularity(params)` at the lattice point: `900 - 500 * ((irr - 0.05) / 0.9)` clamped to `[400, 900]` (spec §5). Jitter each point by `±0.3 × spacing` using rng `hashSeed(seed, 'patches')`. `shore = shoreTangent(...).dist < 300`. Shore patches: angle = tangent. Others: `rng.chance(0.6)` → angle of nearest shore patch (null if no shore patch → free), else `rng.next() * π`. Note: the lattice spacing varies per point, so build it as rows with the spacing read at each row's start; that is enough.

- [ ] **Step 4: Implement basis fields and `buildRoadField`**

Blend line fields as doubled-angle vectors: each contribution adds `w·(cos 2θ, sin 2θ)`; result angle = `atan2(sy, sx) / 2`. This is what makes two grids meet cleanly at a seam.

- `grid`: nearest and second-nearest patch (by center distance); weight of the second fades linearly over the 100 m seam band (`spec §5`). Weight 1.
- `boundary`: `shoreTangent` angle; weight `1` at dist 0 → `0` at 250 m.
- `noise`: grid angle + `fractalNoise2D(hashSeed(seed,'field-noise'), 2)(p.x/350, p.y/350)` mapped to `±35°`; weight `0.5 × irr` when `irr > 0.4`, else 0.
- `extra` fields appended verbatim (Task 5 passes `spine`).

`sample(p)`: cache on a 20 m grid (`Float32Array` of angles, lazily filled), bilinear interpolation of the doubled-angle vectors between the four cell corners, then unit `major` and `minor = (-major.y, major.x)`. `ponytail: lazy cache fill, precompute the whole grid if profiling says so`.

- [ ] **Step 5: Run tests, commit**

Run: `npx vitest run src/gen/streets/field.test.ts`
Expected: PASS.

```bash
git add src/gen/streets/field.ts src/gen/streets/field.test.ts
git commit -m "feat: tensor road field from orientation patches"
```

---

### Task 3: Streamline tracer (`streets/trace.ts`)

**Files:**
- Create: `src/gen/streets/trace.ts`
- Test: `src/gen/streets/trace.test.ts`

**Interfaces:**
- Consumes: `RoadField` (Task 2); `inWater(terrain, p)` from `sector/bridges.ts`; `Rng`.
- Produces:

```ts
export interface Seed { at: Pt; dir?: Pt; crossWater?: boolean }
export interface TraceOpts {
  separation: number; step: number; maxSteps: number; minLength: number
  /** 0..1 separation jitter, 0..1 per-1000m decay probability — both 0 for planned */
  jitter: number; decay: number
  maxTurn?: number // radians per step, default π (no clamp)
}
export const MAJOR: TraceOpts   // separation 400, step 10, maxSteps 600, minLength 60
export const MINOR: TraceOpts   // separation 100, step 10, maxSteps 200, minLength 60
export class RoadIndex {
  constructor(cellSize: number)
  add(id: string, points: Pt[], cls: RoadClass): void
  /** nearest point on any indexed road within radius; segAngle is that segment's direction */
  nearest(p: Pt, radius: number, filter?: (cls: RoadClass) => boolean): { id: string; at: Pt; dist: number; segAngle: number } | null
}
export function traceStreamline(field: RoadField, axis: 'major' | 'minor', seed: Seed, terrain: Terrain, sizeM: number, index: RoadIndex, opts: TraceOpts, rng: Rng, irregularityAt: (p: Pt) => number): Pt[] | null
export function poissonSeeds(sizeM: number, spacing: number, rng: Rng, accept: (p: Pt) => boolean): Seed[]
export function seedsAlong(points: Pt[], every: number, alternate: boolean): Seed[]
export function riverCrossingSeeds(terrain: Terrain, rng: Rng): Seed[]
export function traceLayer(field, axis, seeds: Seed[], terrain, sizeM, index, opts, rng, irregularityAt, idPrefix: string, cls: RoadClass): Road[]
```

- [ ] **Step 1: Write the failing tests**

```ts
it('is deterministic', ...)                                 // same seed → deep-equal traceLayer output
it('never enters water', ...)                               // coastal+river seed 42, MAJOR layer from poissonSeeds: every point !inWater unless the road came from a crossWater seed
it('keeps separation', ...)                                 // no two arterials closer than 200 m (0.5×sep) for more than 100 m of arc
it('snaps endpoints', ...)                                  // every endpoint: on window edge (±1 m), or inWater-adjacent (a point 10 m further is wet), or index.nearest(end, 6) hits another road
it('crossing seed crosses the river', ...)                  // riverCrossingSeeds gives ≥1 seed; traced road has wet points and dry points on both sides
it('respects maxSteps', ...)                                // maxSteps 5 → length ≤ 2×5×step + step
it('sprawl kills some minor roads early', ...)              // irregularity 0.95: at least 10 % of streets end without a snap and inside land
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/gen/streets/trace.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `RoadIndex`**

Uniform grid hash keyed `${cx},${cy}`; each polyline segment registered in every cell its bbox touches. `nearest` scans cells within `radius` and computes point-segment distance.

- [ ] **Step 4: Implement `traceStreamline`**

RK4 with `opts.step`, direction from `field.sample` picking the sign closest to the previous direction (start: `seed.dir` or the raw axis). Trace forward then backward from the seed, join. Per step, stop when (spec §6, in order): outside `[0, sizeM]²` (clamp the last point onto the edge); `inWater` and not `seed.crossWater` (for `crossWater` seeds, water is allowed only while the point is within `riverSlice.width` of the river course); `index.nearest(p, 0.3 × sep)` of same-or-higher class → append that hit point and stop; `index.nearest(p, 0.7 × sep)` whose `segAngle` differs < 25° → stop; step count ≥ `maxSteps`; `rng.chance(decay × step / 1000)` when `irregularityAt(p) > 0.4`. `maxTurn` clamps the angle change per step. Return null when total length < `minLength`.

Separation jitter: `sep = opts.separation × (1 + opts.jitter × (irr − 0.4) / 0.55 × (rng.next() − 0.5) × 2)` sampled once per streamline.

- [ ] **Step 5: Implement seed helpers and `traceLayer`**

`poissonSeeds`: jittered lattice at `spacing` filtered by `accept`, shuffled with `rng` for order independence from lattice orientation. `seedsAlong`: points every `every` m along the polyline, `dir` = segment normal, flipping side when `alternate`. `riverCrossingSeeds`: walk `riverSlice.course` by arc length, place a seed every `1000 ± 200` m (rng), skip where `riverSlice.width > 450`, `dir` = course normal, `crossWater: true`. `traceLayer`: for each seed in order, trace; on success `index.add` and emit `{ id: idPrefix + zero-padded n, class: cls, points, width, name: null }` (width 18 arterial / 9 street). Queue cap `4 × (sizeM / separation)²` seeds.

- [ ] **Step 6: Run tests, commit**

Run: `npx vitest run src/gen/streets/trace.test.ts`
Expected: PASS.

```bash
git add src/gen/streets/trace.ts src/gen/streets/trace.test.ts
git commit -m "feat: streamline road tracer with spatial index"
```

---

### Task 4: Planar graph and faces (`streets/graph.ts`)

**Files:**
- Create: `src/gen/streets/graph.ts`
- Test: `src/gen/streets/graph.test.ts`

**Interfaces:**
- Consumes: `Road[]`, `Terrain`, `polygon-clipping`, `ringArea`.
- Produces:

```ts
export interface PlanarGraph { vertices: Pt[]; edges: Array<{ a: number; b: number; roadId: string | null }> }
/** boundaries are closed rings (window rect, land outlines) added as pseudo-edges with roadId null */
export function buildPlanarGraph(roads: Road[], boundaries: Pt[][], snapTol?: number): PlanarGraph  // snapTol default 5
export function pruneDanglers(g: PlanarGraph): PlanarGraph        // iteratively drop degree-1 vertices (cul-de-sacs do not split faces)
export function facesOf(g: PlanarGraph): Pt[][]                    // inner faces, CCW, outer face dropped
export function clipFacesToLand(faces: Pt[][], terrain: Terrain): Array<{ poly: Pt[]; footprint: Pt[] }>  // footprint = face ∩ land; faces with no land dropped; a face split by water yields the largest piece
export function mergeSlivers(faces: Pt[][], minArea?: number, minWidth?: number): Pt[][]  // 2000, 20
export function degree4Vertices(g: PlanarGraph): Pt[]
export function windowRing(sizeM: number): Pt[]
```

- [ ] **Step 1: Write the failing tests**

```ts
it('two crossing roads on a square give four faces', ...)        // window 1000, roads (500,0)-(500,1000) and (0,500)-(1000,500) → 4 faces, each area ≈ 250000
it('welds endpoints within snapTol', ...)                          // road ending 3 m short of another still splits the face
it('faces close against window and land boundary', ...)           // one road across a coastal land ring: faces count ≥ 2, total area ≈ land area within 1 %
it('dangling road does not split a face', ...)                     // road from (500,0) to (500,400) inside a 1000 square → 1 face
it('mergeSlivers removes thin faces', ...)                         // a 1000×15 strip between two faces → merged, count drops by one
it('degree4Vertices counts crossroads', ...)                       // the crossing-roads fixture → 1 vertex at (500,500)
it('is deterministic', ...)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/gen/streets/graph.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `buildPlanarGraph`**

Insert every road segment and boundary segment. Weld: a vertex within `snapTol` of an existing vertex reuses it; an endpoint within `snapTol` of a segment interior splits that segment. Intersections: bucket segments in a grid hash (cell 200 m), test pairs sharing a cell, split both at the intersection point. Dedupe zero-length edges.

- [ ] **Step 4: Implement `pruneDanglers`, `facesOf`, `degree4Vertices`**

`facesOf`: half-edge walk. For each vertex sort outgoing edges by angle; from each unused directed edge walk taking the next edge clockwise around the target vertex; collect rings; drop the ring with the largest absolute area (outer) and any ring with `ringArea` sign indicating a hole traversal of the outer boundary. Degree-4: vertices with exactly four incident edges whose `roadId` is not null.

- [ ] **Step 5: Implement `clipFacesToLand`, `mergeSlivers`, `windowRing`**

`clipFacesToLand`: `polygonClipping.intersection([faceRing], terrain.land)`; keep the largest resulting polygon's outer ring as `footprint`, drop when empty. `mergeSlivers`: min width = `2 × area / perimeter`; merge into the neighbour sharing the longest edge by removing the shared edge (union of the two rings along that edge; use `polygonClipping.union` — once per sliver, slivers are rare).

- [ ] **Step 6: Run tests, commit**

Run: `npx vitest run src/gen/streets/graph.test.ts`
Expected: PASS.

```bash
git add src/gen/streets/graph.ts src/gen/streets/graph.test.ts
git commit -m "feat: planar road graph with face extraction"
```

---

### Task 5: Highway trace (`streets/highway.ts`, part 1)

**Files:**
- Create: `src/gen/streets/highway.ts`
- Test: `src/gen/streets/highway.test.ts`

**Interfaces:**
- Consumes: `buildRoadField` with an `extra` spine basis (Task 2), `traceStreamline` (Task 3), `riverCrossingSeeds` shape.
- Produces:

```ts
export const HIGHWAY_WIDTH = 32
export function spineBasis(angle: number, weight?: number): BasisField   // weight 2
export function traceHighway(params: SectorParams, terrain: Terrain, sizeM: number): { road: Road; field: RoadField }
```

`traceHighway` builds its own field (`buildRoadField(params, terrain, sizeM, [spineBasis(axis)])`) where `axis = π/2 ± rng.next()·(π/9)` (vertical ± 20°) from `hashSeed(seed, 'highway')`; entry point on the top edge at `x = sizeM × (0.3 + 0.4 × rng.next())`; traced with `{ ...MAJOR, maxSteps: 2000, maxTurn: step / 300 }` (min bend radius 300 m) and `crossWater: true` restricted to the river corridor as in Task 3; the trace stops at water that is not the river (sea/lake) — if that happens before reaching the opposite edge, retry up to 3 entry points (`rng`), then keep the longest. `road = { id: 'H1', class: 'highway', width: 32, name: null, points }`. The returned `field` is discarded by callers (the sector field has no spine).

- [ ] **Step 1: Write the failing tests**

```ts
it('is deterministic', ...)
it('spans the window', ...)                       // first point y ≈ 0 and last point y ≈ sizeM (±1) for inland seed 42
it('bends gently', ...)                           // angle change between consecutive 10 m segments ≤ step/300 rad + 1e-6
it('highway crosses river at most once', ...)     // count contiguous wet runs along the polyline for seeds 42, 7, 1443928265 with river: each ≤ 1
it('never enters sea or lake', ...)               // coastal seed: every wet point is within riverSlice.width of the river course
```

- [ ] **Step 2: Run tests to verify they fail**, **Step 3: implement**, **Step 4: run tests**

Run: `npx vitest run src/gen/streets/highway.test.ts`
Expected: PASS after implementation.

- [ ] **Step 5: Commit**

```bash
git add src/gen/streets/highway.ts src/gen/streets/highway.test.ts
git commit -m "feat: trace one curved highway through a spine field"
```

---

### Task 6: Preview harness (`tools/streets-toy/`) — hard gate

**Files:**
- Create: `tools/streets-toy/index.html`, `tools/streets-toy/main.ts`, `tools/streets-toy/shot.mjs`, `tools/streets-toy/run.sh`
- Delete: `tools/partition-toy/`

**Interfaces:**
- Consumes: Tasks 2–5 plus `sampleTerrain`, `assignZones` is NOT used here (no zoning yet).
- Produces: screenshots in `tools/streets-toy/shots/` — `toy-<tag>-<stage>.png` for tags `planned|mixed|sprawl`, stages `patches|field|roads|faces`.

- [ ] **Step 1: Copy `tools/partition-toy/run.sh` to `tools/streets-toy/run.sh`** (path swap only), then `git rm -r tools/partition-toy`.

- [ ] **Step 2: Write `main.ts`**

Query params `seed` (default 1443928265), `size` (4), `tag` (`planned|mixed|sprawl` → irregularity 0.15/0.5/0.85). Params like Task 2's fixture with `landform: 'coastal', river: true`. Pipeline: `sampleTerrain` → `buildRoadField` → `traceHighway` → `RoadIndex` → `traceLayer(major)` seeds = `seedsAlong(highway, 400)` + `riverCrossingSeeds` + `poissonSeeds(400, on land)` → `traceLayer(minor)` seeds = `seedsAlong` each arterial every 100 m alternating → `buildPlanarGraph` with `[windowRing, ...land outer rings]` → `pruneDanglers` → `facesOf` (major graph and full graph separately). Render one `<figure>` per stage as inline SVG in `[0,sizeM]²`: water fill, patches as dots with an angle tick sized by `size/4`; field glyphs every 100 m; roads coloured by class (highway red, arterial cyan, street grey); faces: district faces stroked thick, block faces thin, degree-4 vertices as small circles. Show timing per stage in a `<pre>`.

- [ ] **Step 3: Write `shot.mjs`**

For each tag, `goto /tools/streets-toy/?tag=<tag>`, wait for `figure` count 4, screenshot each figure to `toy-<tag>-<stage>.png`. Fail if any figure is missing or if the page reports a stage over 1.5 s (read the `<pre>`).

- [ ] **Step 4: Run and look**

Run: `tools/streets-toy/run.sh`
Expected: 12 PNGs. Look at them. Gate (spec §11): through-streets, crossroads, shore-following roads, visible orientation seams between patches, one curved highway. If the roads read as noise, tune constants in Tasks 2–3 (seam band, noise weight, snap radii) here before any sector wiring, and re-run.

- [ ] **Step 5: Commit**

```bash
git add tools/streets-toy
git commit -m "feat: streets toy harness replaces partition toy"
```

---

### Task 7: Lots (`streets/lots.ts`)

**Files:**
- Create: `src/gen/streets/lots.ts`
- Test: `src/gen/streets/lots.test.ts`

**Interfaces:**
- Consumes: `Block`, `District`, `Terrain`, `polygon-clipping`, `pointInRings`, `rotatePt`, `ringArea`.
- Produces:

```ts
export const ZONE_BUILD: Record<ZoneType, { minCell: number; fill: number }>  // copy from buildings.ts
export function insetRing(ring: Pt[], d: number): Pt[] | null   // edge-offset inset; null when it collapses
export function fillLots(districts: District[], blocks: Block[], params: SectorParams, terrain: Terrain, noBuild: Pt[][]): Building[]
```

- [ ] **Step 1: Write the failing tests**

```ts
it('inset of a square shrinks by d on every side', ...)
it('lots stay inside the block footprint', ...)                  // every building vertex inside footprint ring (±0.5 m)
it('lots avoid the no-build strip', ...)                          // a strip polygon across the block → no building vertex inside it
it('lot count scales with zone minCell', ...)                     // same block, corp vs slum → slum has more buildings
it('is deterministic', ...)
it('keeps the block id chain', ...)                               // every building.blockId exists and building.districtId === block.districtId
```

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement**

`insetRing`: offset each edge inward by `d`, intersect consecutive offset lines; if the result self-intersects or the area drops below 0, return null. `ponytail: no miter limit, sharp spikes on very acute corners; switch to polygon-clipping offset if the toy shows spikes`.

`fillLots` per block: `inset = insetRing(footprint, SIDEWALK 6)`; skip if null or area < 500. Grid axis = direction of the block's longest edge. Lay a rotated rect grid with cell `minCell` (zone) and `fill` coverage jitter as in old `buildings.ts`; a lot whose 4 corners are all inside `inset` and outside every `noBuild` ring is kept as-is; a straddling lot is clipped with `polygonClipping.intersection` against `inset` then `difference` against `noBuild`; drop pieces < 40 m². Ids `BLD` + zero-padded counter. `rng = mulberry32(hashSeed(seed, 'buildings'))`.

- [ ] **Step 4: Run tests, commit**

```bash
git add src/gen/streets/lots.ts src/gen/streets/lots.test.ts
git commit -m "feat: building lots on graph faces"
```

---

### Task 8: Highway levels, crossings, interchanges (`streets/highway.ts`, part 2)

**Files:**
- Modify: `src/gen/streets/highway.ts`
- Test: `src/gen/streets/highway.test.ts`

**Interfaces:**
- Consumes: `District[]` with `poly`, `Road[]` arterials and streets, `RoadIndex`, `nearestOnPolyline`, `pointInRings`.
- Produces:

```ts
export function assignHighwayLevels(highway: Road, districts: District[], terrain: Terrain, rng: Rng): HighwaySegment[]
export function levelAt(segments: HighwaySegment[], t: number): HighwayLevel
export function highwayCrossings(highway: Road, roads: Road[], segments: HighwaySegment[], rng: Rng): HighwayCrossing[]
export function cutStreetsAtGround(streets: Road[], highway: Road, segments: HighwaySegment[]): Road[]
export function buildInterchanges(highway: Road, crossings: HighwayCrossing[], roads: Road[], segments: HighwaySegment[]): { crossings: HighwayCrossing[]; ramps: Road[] }
export function noBuildStrips(highway: Road, segments: HighwaySegment[]): Pt[][]
```

- [ ] **Step 1: Write the failing tests**

```ts
it('single district → one segment, no transition', ...)
it('levels change one step at a time', ...)              // adjacent segments: never sunken↔elevated directly
it('at most two level changes', ...)
it('short district inherits the previous level', ...)    // district crossed for < 500 m
it('sunken never crosses the river', ...)                 // segment containing a wet t → level !== 'sunken'
it('corp prefers sunken', ...)                            // all-corp districts → all segments sunken
it('ground stretch cuts streets at the corridor edge', ...) // street crossing a ground segment → split into two, no point within width/2 + 1 of the centerline
it('interchanges every ~1 km with four ramps', ...)      // 4 km highway → 3–4 interchanges, each 4 ramp roads, ramps class 'ramp' width 8, name null
it('no interchange on a bridge or transition', ...)
```

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement `assignHighwayLevels`**

Walk the highway by arc length (10 m samples); the district at each sample = the district whose `poly` contains the point (`pointInRings`); runs of the same district become stretches `[from, to]` in `t`. Apply spec §9 rules 1–6 with the preference table (`residential|entertainment` and `industrial|docks|slum` roll their alternative once per sector with `rng`). Rule 6 (river) = any 10 m sample in the stretch is wet → forced `elevated`; if that violates the change cap, redo with cap+1. `transition = true` on every segment whose level differs from the previous. Wet detection reuses `inWater`.

- [ ] **Step 4: Implement crossings, cuts, interchanges, strips**

`highwayCrossings`: for every arterial/street segment intersecting the highway polyline (segment intersection), record `at` (highway `t`), `kind`: elevated → `'under'`, sunken → `'over'`, ground → arterials `rng.chance(0.5) ? 'over' : 'under'`, streets on ground are not crossings (they get cut). `cutStreetsAtGround`: for each street, remove the part within `HIGHWAY_WIDTH/2 + 5` m of the highway centerline inside a ground segment; remnants keep `id + 'a'` / `'b'`, drop remnants < 40 m. `buildInterchanges`: walk the highway; every 1000 m pick the nearest arterial crossing not on a wet interval and not within 200 m of a `transition` segment start; mark `interchange: true`; four ramps per spec §9: from a point 120 m along the arterial on each side to a point 200 m along the highway in each direction, quadratic curve sampled at 10 points with the control point at the arterial/highway intersection offset 30 m toward the ramp's side; ids `R` + zero-padded. `noBuildStrips`: for elevated and ground segments, a corridor polygon `HIGHWAY_WIDTH/2 + 10` m each side.

- [ ] **Step 5: Run tests, commit**

```bash
git add src/gen/streets/highway.ts src/gen/streets/highway.test.ts
git commit -m "feat: highway levels per district, interchanges and ramps"
```

---

### Task 9: Bridges shrink

**Files:**
- Modify: `src/gen/sector/bridges.ts`, `src/gen/sector/bridges.test.ts`

**Interfaces:**
- Produces: `markWetSpans(roads: Road[], terrain: Terrain): Road[]` — for roads that have wet samples (crossing seeds, highway): split into dry pieces and a wet piece marked `bridge: true` (the wet piece keeps the original id + `'b'`; landing 15 m into land on both sides as today's `LANDING`). Keep `inWater`, `waterIntervals`, `truncateUnlandableRoads`, `MIN_SHORE_ANGLE` logic for sea/lake touches. Delete `planBridges`, `splitHostAtBridges`, `truncateOverSpanRoads`, `clipRoadsToLand` and their tests; delete `joinArterialsAcrossHighway` from `roads.ts` (the whole file goes in Task 10).

- [ ] **Step 1: Rewrite tests**: keep tests for `inWater`, `waterIntervals`, `truncateUnlandableRoads`; add `markWetSpans splits a river-crossing road into dry-wet-dry with the wet piece bridged` and `a fully dry road is returned unchanged (same object)`.
- [ ] **Step 2: Run, fail, implement, pass**: `npx vitest run src/gen/sector/bridges.test.ts`
- [ ] **Step 3: Commit**: `git commit -m "refactor: bridges reduce to wet-span marking"`

---

### Task 10: Rewire `generateSector`, delete the partitioner

**Files:**
- Modify: `src/gen/sector/generate.ts`, `src/gen/sector/generate.test.ts`, `src/gen/sector/zoning.ts` (import path for `irregularityField`)
- Move: `src/gen/partition/irregularity.ts` → `src/gen/streets/irregularity.ts` (with its test)
- Delete: `src/gen/partition/twisted.ts` + test, `src/gen/sector/roads.ts` + test, `src/gen/sector/buildings.ts` + test
- Test: `src/gen/sector/generate.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–9.
- Produces: `generateSector(params): SectorModel` with the spec §4 order.

- [ ] **Step 1: Add failing tests to `generate.test.ts`**

```ts
it('roads include one highway with segments and crossings', ...)
it('districts are faces: every block centroid is inside its district poly', ...)
it('has crossroads on a planned seed', ...)         // degree4Vertices(buildPlanarGraph(model.roads, [...])).length ≥ 20 for seed 42 planned 4 km
it('2 km sector still has streets and buildings', ...) // size 2: streets ≥ 20, buildings ≥ 50
it('ramps are unnamed and never bridges', ...)
```

Keep the existing tests; `does not throw on seeds that used to break polygon-clipping` stays as a smoke test over the same seeds.

- [ ] **Step 2: Rewrite `generateSector`**

Order (spec §4): `sampleTerrain` → `buildRoadField` → `traceHighway` → `RoadIndex(200)` with the highway added → arterials `traceLayer(major, [seedsAlong(highway,400,false), ...riverCrossingSeeds, ...poissonSeeds(400, land)], 'A', 'arterial')` → streets `traceLayer(minor, arterials.flatMap(seedsAlong(…,100,true)), 'S', 'street')` with `MINOR` jitter/decay = `0.4`/`0.2` → major graph `buildPlanarGraph([highway, ...arterials], [windowRing, ...landOuterRings])` → `pruneDanglers` → `facesOf` → `mergeSlivers` → `clipFacesToLand` → `assignZones(faces.map(f => f.poly), …)` (existing signature; `flags: {}`) → `assignHighwayLevels` → `cutStreetsAtGround` → `highwayCrossings` → `buildInterchanges` → full graph with all roads → block faces → `Block { poly, footprint, districtId by centroid, flags: {} }` → `markWetSpans` on all roads → names (highway + arterials named as today, streets and ramps `null`) → `fillLots(…, noBuildStrips)` → `deriveDistricts` → POIs → piers.

Rng streams: `'patches'`, `'field-noise'`, `'highway'`, `'arterials'`, `'streets'`, `'zones'` (existing), `'highway-levels'`, `'buildings'`, `'names'` (existing).

- [ ] **Step 3: Delete old modules, fix imports**

`git rm` the files listed. `zoning.ts` imports `irregularityField` from `../streets/irregularity`. `ZONE_IRREGULARITY` stays in `zoning.ts` (still feeds `District.irregularity`).

- [ ] **Step 4: Run everything**

Run: `npx tsc -b --noEmit && npm test`
Expected: PASS. Fix any test that asserted twisted-bisection specifics by deleting it, not by weakening a new one.

- [ ] **Step 5: Commit**

```bash
git add -A src/gen
git commit -m "feat: sector pipeline traces roads first, districts from faces"
```

---

### Task 11: Render highway levels, ramps, junction markers

**Files:**
- Modify: `src/render/svg.ts`
- Test: `src/render/svg.test.ts` (create if absent; check for an existing render test first)

**Interfaces:**
- Consumes: `Road.segments/crossings`, `theme.highway`, `theme.road.ramp`, `degree4Vertices`.
- Produces: SVG with `polyline[data-class="ramp"]`, `circle[data-junction="4"]`, `[data-level="elevated|sunken|ground"]` groups.

- [ ] **Step 1: Write the failing test**

```ts
it('emits ramp polylines, junction markers and highway level groups', () => {
  const svg = renderSvg(generateSector(params42Planned), themes.neon)
  expect(svg).toMatch(/data-class="ramp"/)
  expect((svg.match(/data-junction="4"/g) ?? []).length).toBeGreaterThanOrEqual(20)
  expect(svg).toMatch(/data-level="(elevated|sunken|ground)"/)
})
```

- [ ] **Step 2: Implement draw order**

districts → buildings → streets → arterials → ramps (`theme.road.ramp`, width) → sunken trench (two edge lines `theme.highway.trench` at `±width/2`, the corridor filled with `bg`) → highway stroke per segment as `<g data-level=…>` (ground: shoulder lines at `±width/2+3`; elevated: the stroke plus column ticks every 40 m, 6 m long, `theme.highway.column`, drawn under the stroke) → crossing decks: for `kind: 'over'` a short `bridge.deck` polyline of the crossing road clipped to the corridor, for `'under'` a dashed segment inside the corridor → transitions: hatched band 150 m (`theme.highway.hatch`, 4 m stripes) → bridges (existing pass) → piers → junction markers `<circle data-junction="4" r="0" fill="none">` at `degree4Vertices` → labels. Reuse the existing `n()` formatting and clip groups.

- [ ] **Step 3: Run tests, run uicheck, look at screenshots**

Run: `npm test && tools/uicheck/run.sh`
Expected: uicheck green (theme pass needs every theme's new keys — Task 1 did that). Open `tools/uicheck/shots/streets-planned.png` and `streets-sprawl.png`; the highway must visibly change style between districts.

- [ ] **Step 4: Commit**

```bash
git add src/render
git commit -m "feat: render highway levels, ramps and crossroad markers"
```

---

### Task 12: uicheck assertions, perf test, docs

**Files:**
- Modify: `tools/uicheck/check.mjs`, `ARCHITECTURE.md`, `docs/ROADMAP.md`
- Create: `src/gen/sector/perf.test.ts`

- [ ] **Step 1: uicheck**: after the existing `planned` screenshot, add
```js
if ((await page.locator('svg polyline[data-class="ramp"]').count()) < 1) fail('planned: no ramps')
if ((await page.locator('svg circle[data-junction="4"]').count()) < 20) fail('planned: too few crossroads')
```
Run `tools/uicheck/run.sh`; look at all screenshots.

- [ ] **Step 2: perf test**

```ts
// src/gen/sector/perf.test.ts
describe.skipIf(!!process.env.CI)('perf budget', () => {
  it('4 km under 1.5 s', () => { const t = performance.now(); generateSector({ ...base, size: 4 }); expect(performance.now() - t).toBeLessThan(1500) })
  it('6 km under 4 s', () => { const t = performance.now(); generateSector({ ...base, size: 6 }); expect(performance.now() - t).toBeLessThan(4000) })
})
```
`base` = seed 42, coastal, river, irregularity 0.5. If it fails, profile `field.sample` and `buildPlanarGraph` first (they scale with size).

- [ ] **Step 3: ARCHITECTURE.md**: replace the pipeline table with spec §4 and "The partitioner (the heart)" with a short "The road field and tracer" paragraph (map, not diary). Update the invariant list: remove the `districts ↔ blocksByDistrict positional` invariant (blocks now carry `districtId` by centroid), add "streamlines never enter water except from a crossing seed".

- [ ] **Step 4: ROADMAP.md**: mark "Organic street patterns" as replaced by tensor streets; add spec §14 items under Deferred; remove the sliver-block and "improved building placement" notes if now covered, otherwise reword to what remains.

- [ ] **Step 5: Run everything, commit**

Run: `npm test && tools/uicheck/run.sh`

```bash
git add tools/uicheck/check.mjs src/gen/sector/perf.test.ts ARCHITECTURE.md docs/ROADMAP.md
git commit -m "test: uicheck crossroads and ramps, perf budget; docs for tensor streets"
```

---

## Plan self-review notes

- Spec coverage: §5→T2, §6→T3, §7→T4, §8→T3+T9, §9→T5+T8+T11, §10→T12, §11→T6, §12→T2–T12 tests, §13→T1, §15 deletions→T6+T10, ARCHITECTURE/ROADMAP→T12.
- `assignZones` already takes `Pt[][]`, so "adapted" in the spec means only `flags: {}` (T1) and the import path (T10).
- Organic curved lots (spec §5 last line) are delivered by clipping the rotated grid against curved faces, not by a separate lot algorithm; `ponytail:` note in T7.
