# Organic Street Patterns (Terrain v2, Phase 3) — Design

Status: approved for planning
Branch: `spec/organic-streets`
Depends on: `docs/specs/2026-08-04-terrain-v2-design.md` (phases 1+2, merged)

## 1. Goal

Replace the treemap-looking BSP street fabric with organically varied
street patterns, while keeping the planned-megacity character where it
belongs. One algorithm — **twisted bisection** — with a single continuous
`irregularity` parameter covers the whole range from near-grid (planned
corp fabric) to crooked dense lanes (sprawl), so roadmap options A
(perturbation) and C (zone-hybrid) become regions of one parameter space
rather than separate generators. Option B (cross-district merged organic
fabric) is an explicit non-goal.

## 2. Core algorithm: twisted bisection

New module `src/gen/partition/`.

Recursive bisection of an arbitrary polygon. Each cut is a short polyline
with a bend near its middle, chosen so both endpoints meet the polygon
boundary near-perpendicular. The outer shape's character propagates
inward: a curved waterfront district produces curved lanes, a straight
one stays straight.

Parameters:

- `minCell` — stop recursing below this area/extent (same role as today's
  BSP `minCell`).
- `gap` — cut corridor width (becomes the road width).
- `irregularity` (0..1) — the one style parameter. Drives, together:
  - cut-position jitter (0 → near-midpoint cuts),
  - bend/twist magnitude (0 → straight cuts),
  - cut-angle freedom (0 → axis-aligned-ish, 1 → any angle the shape
    suggests).
- injected `Rng` — fully deterministic, seeded per level via
  `hashSeed(seed, …)` like every other stage.

At `irregularity ≈ 0` the output is visually equivalent to the current
BSP grid (perpendicular near-even cuts). Nothing in the pipeline ever
requests exactly 0 — even planned zones keep a floor of variation.

Cells are **never merged across parent polygons**. Each district is
partitioned independently inside its own closed boundary; seams between
districts are roads by construction. (The reference technique's
documented instability came from the cross-cell merge step — we
structurally avoid it.)

## 3. Standalone toy prototype (hard gate)

The partitioner is validated in isolation before any sector wiring.
The toy exercises the *shipping* `src/gen/partition/` module, not
throwaway code:

- A small dev-only harness page (not part of the app bundle, e.g.
  `tools/partition-toy/`) rendering partitions of test polygons —
  square, convex blob, concave blob, and a real waterline-clipped land
  polygon captured from the terrain generator — across a sweep of
  irregularity values, with seed/irregularity/minCell controls.
- Unit/property tests in `src/gen/partition/`:
  - determinism (same seed → identical output),
  - cuts terminate on the boundary, no self-intersections,
  - every cell ≥ `minCell` bound, cells tile the parent (area
    conservation within gap tolerance),
  - `irregularity = 0` produces near-axis-aligned near-even cuts.

Sector integration starts only after the toy passes tests **and** looks
right visually (uicheck-style screenshot review of the harness).

## 4. Sector integration

### 4.1 Partition domain (district level)

Districts partition the **coast-clipped land hull with rivers left in**:

- Coast/ocean is excluded from the domain — waterfront districts hug the
  actual coastline natively instead of being bbox cells clipped after
  the fact.
- Rivers stay inside the domain — cuts crossing a river become bridge
  candidates and flow through the existing clip → truncate → bridge
  pipeline unchanged in spirit.

The highway split stays as today (straight strip; highways are planned
infrastructure). A gently curved highway is deferred to ROADMAP.

### 4.2 Two levels, one partitioner

- **Level 1 — districts:** partition the domain with a low-ceiling
  irregularity (arterials bend gently; they are still planned
  infrastructure). Cuts become arterials.
- **Level 2 — blocks:** partition each district polygon with that
  district's own irregularity (§5). Cuts become streets.

`bspSplit` survives in exactly one place: building lots *inside* a block
(`buildings.ts`) stay a rectangular grid, rotated to the block's longest
edge — real lots are rectangular-ish along street frontage, and twisted
bisection at 5–30 m scale would cost a polygon-boolean per building for
no visual gain. District- and block-level BSP callers are deleted.

### 4.3 Irregularity assignment

Per district: `clamp01(zoneBase[zone] + seededJitter + tagBias)`.

- `zoneBase` values overlap across zones (corp low, industrial and
  residential mid-low, entertainment mid, docks mid-high, slum high) —
  any zone *can* land anywhere in the range: planned docks and scruffy
  corp fringes both occur.
- `seededJitter` is a deterministic per-district draw wide enough that
  distributions genuinely overlap.
- `tagBias` comes from the street-style tags (§6).
- The clamp floor is > 0 — no district is a perfect grid.

Exact numbers are tuned during implementation on the toy + uicheck
screenshots; the spec fixes the shape (overlapping bases, nonzero
floor), not the constants.

## 5. Data model and pipeline ripple

This is the real cost of the feature.

- **Blocks become polygons.** `Block` gains `poly: Pt[]` as the
  authoritative shape (bbox derivable where needed, e.g. labels).
- **Roads become true polylines.** `Road.points` already types as
  `Pt[]`; bridge planning, water clipping, and truncation currently
  assume straight 2-point segments and are generalized to work
  segment-wise over polylines.
- **Building fill works on polygonal blocks.** Inset the block ring,
  pack oriented buildings inside, reusing the terrain v2 polygon
  clipping/insetting core; buildings inherit local edge orientation, so
  block rotation/curvature carries into the fabric.
- **Renderer** draws block and building polygons (water/land are already
  polygons).
- Downstream consumers of `Rect`-shaped blocks (zoning inputs, POI
  placement, labels, piers) read the polygon or its derived bbox —
  audited during planning.
- `GENERATOR_VERSION` → 4 (every existing seed re-renders differently).

## 6. Tags (no numeric knob)

One new exclusive tag group `streets`, same staged-until-reroll and
materialization semantics as existing groups:

- `planned` — shifts the whole irregularity distribution down (0.15).
- `mixed` — the neutral middle (0.5).
- `sprawl` — shifts it up (0.85).

`mixed` is an explicit tag (not "neither active") because
`materializeTags` rolls an explicit member for every unstaged group —
a bare URL is a fully materialized surprise-me, and the streets group
keeps that invariant. No slider.

## 7. Testing

- Partition module: unit/property tests per §3.
- Sector level: existing generator tests updated for polygonal blocks;
  determinism tests still pin exact output per seed.
- `tools/uicheck/`: extended in the same task as the UI change —
  exercise `planned` and `sprawl` tags, screenshot review by eye (not
  just exit codes), including a water-heavy seed to check waterfront
  districts and bridges.

## 8. Out of scope (→ ROADMAP)

- Option B: merged cells / cross-district organic fabric.
- Curved highways.
- Transit lines, structural editing, everything already deferred in
  ROADMAP.

## 9. Delivery

Spec, plan, and implementation all live on `spec/organic-streets`,
merged to `main` via a single PR. The `no-pois` tag commit rode on this
branch as a grid-visibility aid during development; during PR review it
was replaced by a render-side "Show POIs" toggle (instant, no reroll) —
the tag no longer exists.
Implementation phases: (1) partition module + toy, gate; (2) sector
wiring both levels + data-model ripple; (3) tags + UI + uicheck.
