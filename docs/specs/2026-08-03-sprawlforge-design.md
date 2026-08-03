# SprawlForge — Product & Architecture Design

Date: 2026-08-03
Status: approved

## 1. Product & scope

SprawlForge is a free, open, static web toolkit for cyberpunk TTRPGs.
System-agnostic at the core, Shadowrun-friendly through flavor packs. Public
from day one, but with no accounts, no backend, and no server-side storage —
all state lives in URLs and user-exported files.

The model is Watabou's Procgen Arcana (https://watabou.github.io): each tool
is its own page with a full-viewport map, a knob panel, and a reroll button.
Generate and tweak knobs — no structural editing, only light annotation on
top of generated output.

### Tool suite

| Tool      | Scale                                    | Phase |
|-----------|------------------------------------------|-------|
| Sector    | few km²: blocks, roads, zones, POIs      | 1     |
| Metroplex | whole sprawl, districts as regions       | 2     |
| Battlemap | building interior / street combat scale  | 3     |
| Node map  | abstract locations + connections (graph) | 4     |

Sector ships first: it is the closest to the proven Watabou model and is the
parent artifact for battlemap linkage. Metroplex second, because it is the
sector's parent and proves out the linkage chain.

## 2. Architecture & stack

- **React + TypeScript + Vite**, static SPA. Deployed to GitHub Pages via
  GitHub Actions; the build output is a plain folder, so anyone can self-host
  it (nginx, Docker, any static file server).
- **Hard internal boundary** (single app, three layers):
  - `src/gen/` — pure TypeScript, zero React, zero DOM. Input: params + seed.
    Output: plain data model (geometry + metadata). Unit-testable, portable
    to Node or a backend later.
  - `src/render/` — data model → SVG. All theming lives here and only here.
  - `src/app/` — React UI: knob panels, routing, export buttons.
- **Rendering: SVG.** Vector export is free; PNG comes from canvas
  rasterization of the SVG; PDF from SVG. The data model keeps semantic
  information (walls, doors, zones), which keeps VTT export formats possible
  later.
- **Seeded PRNG everywhere.** No `Math.random` in generation. Same seed +
  params = same map, always. Generator algorithms carry a version number;
  algorithm changes bump the version so old shared links can warn or
  reproduce.

## 3. State, linkage, sharing

### URL is the save file

Every map is fully defined by its query string (`?seed=…&size=…&coast=1…`).
Shareable, bookmarkable, zero storage.

### Hierarchical seeds

A child artifact's seed is a deterministic hash of the parent seed and the
child's stable entity id:

```
metroplex seed 4711
 └─ district "D07" → sector seed = hash(4711, "D07")
     └─ building "B23" → battlemap seed = hash(sectorSeed, "B23")
```

- Clicking a district on the metroplex opens the sector tool with seed and
  inherited params (zone type, density, coast) prefilled in the URL.
- Clicking a building/POI on a sector opens the battlemap tool the same way.
- Linkage is pure URL construction — tools stay decoupled and fully usable
  standalone.
- Consequence: one shared metroplex link implies identical sectors and
  battlemaps for everyone. The whole sprawl is one seed, generated lazily.

### Names are generated, not stored

The naming generator is a shared core module (`src/gen/names/`), seeded like
everything else: `hash(seed, entityId)` → name from flavor-pack tables. Same
seed produces the same names at every level — district names, street names,
POI names, down to per-floor tenants of a high-rise
(`hash(buildingSeed, floor)`). Deep detail is generated lazily by the tool
that needs it, from the same seed chain.

### Export / import

Base maps need no export — the URL suffices. The JSON export exists for what
URLs cannot hold: **user overrides only**, stored as diffs against generated
state — annotations (labels, markers, notes), renames ("district D07 →
'Redmond'"), and collections ("my campaign: this metroplex + these five
battlemaps"). Import = regenerate from seed, apply diffs on top. The schema
is versioned from day one.

### Asset exports

SVG (native), PNG (rasterized, resolution knob), PDF (print). VTT formats
and poster-tiling PDF are roadmap items.

## 4. Sector generator v1

Generation pipeline — each step a pure function, data in → data out:

1. **Geography** — coast/river/none toggles; defines unbuildable area.
2. **Road hierarchy** — highways (few, cut through), arterials (subdivide
   land into superblocks), streets (subdivide into blocks). The skeleton
   everything else hangs on.
3. **Zoning** — assign district types to superblock clusters: corp,
   residential, slum/barrens, industrial, entertainment, docks (docks only
   with coast). Knobs: zone mix weights, density, corp dominance.
4. **Blocks & buildings** — per zone, fill blocks with building footprints;
   zone type controls footprint size and regularity (corp = large regular
   towers with plazas, slums = dense irregular small, industrial = huge
   sheds).
5. **POIs** — pick buildings, assign types from the flavor pack (corp HQ,
   club, clinic, safehouse, market, …), generate names. Knob: POI density.
6. **Naming** — district, street, and POI names from flavor-pack tables
   (syllable/pattern-based).

### Data model (sketch)

```
{
  meta: { seed, generatorVersion, params },
  geography, roads[], districts[], blocks[], buildings[], pois[]
}
```

Every entity has a stable id — required for child-seed derivation and for
attaching user overrides.

### Knobs v1

size, seed, coast/river, density, zone mix, corp dominance, POI density,
flavor pack, theme. Reroll button.

**Units: metric, real-world, everywhere.** Sector size in km, battlemap
grids in meters, scale bars on every map. No imperial units anywhere in
code, UI, or exports.

### Explicitly out of scope for v1

See `docs/ROADMAP.md` — structural editing, elevation, transit lines, 3D,
VTT export, poster-tiling PDF.

## 5. Theming & rendering

- Renderer input is the pure data model; output is SVG. A theme is a mapping
  table (zone → fill/stroke/glow, road class → width/color, label → font)
  plus CSS. No theme logic in generators.
- **v1 ships two themes:** *Neon* (dark background, cyan/magenta glows, for
  screens) and *Print* (clean line-art, white background, ink-friendly).
  Blueprint theme later — cheap to add once themes are data.
- Labels are SVG text and follow the theme. Label placement is its own render
  step; v1 uses good-enough overlap-avoidance heuristics (improvement is a
  roadmap item).
- Viewport: pan/zoom on the SVG. No tile rendering — sector-scale SVG is
  fine; if metroplex performance hurts later, solve it when it is real.

## 6. Flavor packs

Data-driven flavor: name tables, POI types, and terminology as swappable
JSON. Ships with **generic cyberpunk** and **Shadowrun-ish** packs. No
trademarked strings baked into code — flavor is data, third parties can add
their own packs.

## 7. Repo, docs, hosting

```
sprawlforge/
  docs/
    specs/           # design docs (this one first)
    plans/           # implementation plans
    ROADMAP.md       # deferred features, explicit excludes
    ADR/             # architecture decision records
  src/gen|render|app # when building starts
  temp/              # gitignored scratch space
  .github/workflows/ # Pages deploy, later
```

- ADRs: one short record per big decision — React+TS+Vite, SVG-first,
  hierarchical seeds, URL-as-state, flavor packs.
- License: MIT.
- README will state that self-hosting = serve `dist/`.

## 8. Testing

- `src/gen/` is pure functions with seeded RNG — deterministic unit tests:
  same seed asserts identical output; property tests for invariants (roads
  connect, buildings don't overlap streets, ids stable).
- Renderer: snapshot tests of SVG output per theme.
- App/UI: light — knob changes update URL, URL round-trips to same map.
