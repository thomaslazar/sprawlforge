# Terrain v2 + City-Adapts-to-Terrain — Design

Date: 2026-08-04
Status: approved
Supersedes: the `geography` step of `docs/specs/2026-08-03-sprawlforge-design.md` §4.
Out of scope here: organic street patterns (phase 3) — separate spec, see ROADMAP.

## 1. Problem

v1 water is a placeholder: a straight east-coast strip or a horizontal river
band, never both, no bridges, land clipped as a rectangle, and every map's
water looks the same. Terrain v2 replaces it with a real terrain model that
the city adapts to — and that stays consistent across the future
metroplex → sector hierarchy.

## 2. Core principle: terrain is a metroplex-scale field

`terrainHeight(x, y)` is a pure function over metroplex world coordinates,
seeded entirely from `hashSeed(metroSeed, 'terrain')`. It exists everywhere
at once; there are no seams to stitch.

- **Sectors sample a window.** A sector evaluates the field over its world
  rectangle on a fine grid (~128×128) and extracts waterlines by
  marching-squares contouring. Where sector D07 ends and D08 begins, the
  waterline continues by construction — both read the same function.
- **The metroplex renders the same field coarsely.** Fractal noise carries
  detail at every scale, so coarse (metro) and fine (sector) views agree.
- This is the hierarchical-seeding principle applied to terrain, and it is
  deliberately built before the metroplex generator exists: retrofitting
  cross-scale consistency later is the classic failure mode of
  city-first/terrain-second generators.

### Field construction

- Seeded fractal value noise (hand-rolled, ~40 lines, no dependency;
  deterministic from the rng module — no `Math.random`).
- Plus a **gradient field** whose shape family sets the landmass character:
  - concave gradient → bay
  - convex → peninsula / headland
  - radial → island(s)
  - linear → coastal strip
  - flat-high → inland (little or no water)
- Water = everywhere `height < 0` (threshold). A **water-level knob**
  shifts the threshold.

### One contouring pass, all features

Coast, lakes, islands and river channels all fall out of the same
marching-squares pass over the sampled window:

- a below-threshold basin inland is a **lake**
- an above-threshold patch inside water is an **island**
- the carved river channel (below) contours into **banks** automatically

No per-feature special-case geometry.

### Rivers

- Traced at **metroplex level**: gradient descent from a high region with
  meander noise, stored as a coarse world-space polyline. Deterministic
  from `hashSeed(metroSeed, 'rivers')`.
- **Destination rule:** the trace ends at the sea when the field has one;
  in a landlocked metro it ends at the **lowest point on the metro
  boundary** — the river flows through the city and off the map, as real
  inland rivers do. A metro can therefore be: dry, river-only, coast-only,
  or both (estuary).
- The course is **carved into the heightfield** (heights lowered along the
  path, width tapering downstream). Relief follows the river, not the
  other way round — this ordering avoids the classic
  contours-crossing-water artifacts.
- An **estuary** is simply the carve meeting a bay: no special case.
- Sectors refine their stretch of the course with seeded subdivision
  anchored to the shared coarse points, so neighboring sectors agree at the
  boundary.
- v2 ships 0–1 river per metro context. **Tributaries/confluences are
  explicitly excluded** (ROADMAP) — bridge placement at confluences is a
  known-unsolved problem class.

### Standalone sector tool

The sector tool keeps working without a metroplex parent: it fabricates a
virtual metro context from `hashSeed(sectorSeed, 'metro-ctx')` and
**positions its sampling window** so the user's terrain choice comes true —
"coastal" puts the window on the field's waterline, "river city" on a traced
course, "inland" away from water. Same code path as linked sectors, only
the anchor differs.

## 3. Tags instead of sliders

All numeric knobs disappear behind **template tags** — clickable chips in
the UI, a comma list in the URL. Internally the generator keeps taking
`SectorParams` numerics; a fixed, deterministic tag→value table maps
between them. Tags come in **exclusion groups** (selecting one deselects
its siblings):

| Group    | Tags                                                    | Maps to |
|----------|---------------------------------------------------------|---------|
| terrain  | `inland \| river \| coastal \| bay \| estuary \| island \| lakes` (none = auto) | window anchor + gradient family + water threshold |
| size     | `small \| medium \| large`                              | sector edge km |
| density  | `sparse \| dense \| packed`                             | density |
| power    | `corp-run \| balanced \| fringe`                        | corpDominance |
| activity | `quiet \| lively`                                       | poiDensity |

`river` is the landlocked river-city tag — river present, no sea (destination
rule §2).

- URL: `?seed=4711&tags=coastal,large,dense,corp-run&pack=…&theme=…` —
  `seed`, `pack` and `theme` stay explicit params; everything numeric is
  tag-derived. Unselected groups use their default.
- The v1 water-level slider idea is folded into the terrain tags.
- **No backwards compatibility with the v1 URL scheme.** Pre-release,
  no shared links exist; the old numeric params simply stop parsing.
  Until a release-worthy state is declared, URL-scheme changes need no
  migration path.
- `GENERATOR_VERSION` → 2; the version lives in `meta`.

## 4. City adapts to terrain

### Land partitioning

BSP road layout runs on the land's bounding slabs as today, but every
district, block and building footprint is **clipped against the land
polygons**. Blocks meet the waterline exactly — waterfront buildings stand
at the river's edge. Clipped slivers below a minimum area are dropped.

Polygon boolean ops come from the small `polygon-clipping` library —
hand-rolling robust polygon booleans is a known folly. This library is the
seed of the polygon geometry core that phase 3 (organic streets) will also
use.

### Bridges

- Where water splits the road network, selected **highways and arterials
  extend across** at crossing points; **streets never cross**.
- Crossing orientation snaps **perpendicular to local flow** (the river
  polyline's normal at the crossing).
- Road class sets bridge width (highway wide, arterial narrower).
- Model: the crossing segment is flagged `bridge: true`; the renderer draws
  a deck and a shadow on the water.
- Acceptance: the road graph must remain **connected** across water — a
  graph-connectivity test guards this.

### Shore-aware zoning

- The `docks` zone becomes eligible only on coast/wide-river shores
  (replaces the v1 `coast`-boolean gate).
- Blocks touching water get a mild density bonus.
- Corp waterfront is allowed (plazas facing the water).

### Piers & harbor décor

In scope, but explicitly the **last task** of the plan and behind its own
knob: a decoration pass over the finished model with hard adjacency rules —
piers only on docks-zoned shore, never overlapping, never ending on land,
never on lakes without a docks zone. This layer is historically the most
bug-prone part of comparable generators; it may slip without blocking the
release.

## 5. Rendering water

- **Shallow-water gradient band** along shores (smooth gradient, no
  discrete bands in v2).
- **Inner glow/shadow on the land edge** so land reads as raised.
- Bridges: deck + shadow on water.
- **No wave ornaments** — evaluated and rejected in comparable tools;
  recorded here so nobody re-adds them casually.
- Both themes (neon, print) get water treatments; theme stays a pure
  mapping table, no theme logic in the generator.

## 6. Architecture placement

```
src/gen/terrain/
  noise.ts        seeded fractal value noise
  field.ts        terrainHeight(x,y): gradient families + noise + carving
  contour.ts      marching squares → water/land polygons
  rivers.ts       metro-level course tracing + sector refinement
src/gen/sector/   geography.ts is replaced by a thin adapter over terrain/
src/render/       water band, shore glow, bridge rendering
```

- `src/gen/terrain/` is pure TS like the rest of `gen/` — no React, no DOM,
  fully deterministic, unit-tested in isolation.
- The metroplex generator (roadmap item 3) will consume `terrain/` directly;
  nothing in `terrain/` may assume sector scale.

## 7. Testing

- **Field purity:** same seed ⇒ bit-identical field samples.
- **Contour invariants:** closed polygons, no self-intersections, water
  area responds monotonically to the water-level knob.
- **Cross-sector continuity:** two adjacent sector windows produce
  identical waterline samples along their shared edge.
- **River carving:** river polyline lies inside water polygons; width
  tapers monotonically.
- **Bridges:** road graph connected across water; bridge segments
  perpendicular to flow within tolerance.
- **Clipping:** no building/block area outside land beyond epsilon; no
  degenerate slivers.
- **uicheck:** one screenshot per terrain preset, both themes; look at
  them.

## 8. Explicitly deferred (ROADMAP)

- Tributaries/confluences (and their bridge-angle problem)
- Elevation rendering (contour lines / hillshading) — the field now exists,
  rendering it is a later, cheap win
- Discrete shallow-water bands as a theme option
- Ships/boats and other harbor props beyond piers
- Organic street patterns (phase 3, separate spec)
