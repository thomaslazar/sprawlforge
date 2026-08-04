# SprawlForge Roadmap

## Build order

1. **Sector generator** — v1 per `docs/specs/2026-08-03-sprawlforge-design.md` ✅
2. **Terrain v2 + organic map redesign** — next up, needs its own design
   spec; see below
3. **Metroplex generator** — parent of sectors, proves linkage chain
4. **Battlemap generator** — interiors/street combat, seeded from sector buildings
5. **Node map generator** — abstract location graphs

## Terrain v2 + organic map redesign

Phases 1+2 are specced: `docs/specs/2026-08-04-terrain-v2-design.md`
(metro-scale heightfield, one-pass water contouring, carved rivers,
bridges, waterline clipping, shore zoning, piers). Phase 3 (organic
streets) remains a future spec. Additional deferrals recorded in that
spec §8: tributaries/confluences, elevation rendering, shallow-water
bands, ships/harbor props.

v1 water is a toy (straight east coast, horizontal river band, coast wins
over river, no bridges, land clipped as rectangle) and the BSP street grid
reads as a treemap. One redesign, three shippable phases, one
`GENERATOR_VERSION` bump if landed as one release. Phases 1+2 and the
organic street patterns share a dependency: an arbitrary-polygon geometry
core (clipping, insetting, filling non-rectangular shapes).

1. **Terrain v2** — terrain generated first, city adapts. Coast on any
   side with a curved waterline; meandering river that can coexist with
   the coast and flow into it; waterline as first-class polyline. Biggest
   variety win, visible even with rectangular streets.
2. **City adapts to terrain** — blocks/buildings clipped to the waterline
   (waterfront buildings reach the river's edge), dock zones biased to
   the shore, roads crossing water become bridges (rendered as such,
   network stays connected).
3. **Organic street patterns** — options, in ascending effort:
   - **A: perturbation pass** — keep BSP skeleton; jitter road
     centerlines, rotate district lattices a few degrees, buildings
     inherit rotation. Planned-city-that-aged look.
   - **C: zone-hybrid** — perturbed grid for corp/industrial/residential
     (planned megacity fabric), separate irregular generator for
     slum/old-quarter districts (crooked dense lanes). Zone contrast as
     storytelling.
   - **B: full Voronoi partition** — fully organic street fabric everywhere.
     Only if A/C prove insufficient; several times their cost.

## Deferred (explicit v1 excludes — do not forget)

- **Structural editing** — moving walls/roads/buildings by hand. v1 is
  generate + knobs + light annotation only.
- **Elevation / terrain height** on sector maps.
- **Transit lines** — rail/metro/monorail layer. Good v2 candidate for
  sector maps.
- **3D anything.**
- **VTT export formats** (Foundry / Universal VTT with walls & lighting
  data) — data model deliberately keeps wall/door semantics so this stays
  possible.
- **Poster-tiling PDF** for printing battlemaps across multiple pages.
- **Blueprint theme** — third theme; cheap once theme system exists.
- **Better label placement** — v1 ships good-enough overlap heuristics.
- **Annotation layer + JSON override export/import** — user labels, markers,
  renames stored as diffs against generated state (spec §3). Follow-up plan
  after sector v1 ships.
- **Tile-based rendering** for metroplex scale — only if SVG performance
  actually hurts.
- **Zone-mix knob** — spec §4 lists zone mix weights as a district knob;
  v1 UI only exposes corp dominance (zoning derives the rest).
- **PNG resolution knob** — spec §3 calls for a resolution knob; v1 export
  is fixed at 2x.
- **Hierarchical per-entity naming** — spec §3 specifies `hash(seed,
  entityId)` per name; v1 draws all names from one sequential RNG stream
  seeded once. Switching later renames everything on existing URLs —
  needs a `GENERATOR_VERSION` bump when it happens.
- **Road/building id format overflow** — ids are fixed-width
  (`A99`/`S999`/`BLD999999`); a large enough sector (e.g. size 8) can
  exceed the padding and produce colliding/malformed ids.
- **Massively extend flavor-pack name tables** — current tables are ~10
  words each, so names repeat quickly across a map. Grow every table
  (adj/place/corpA/corpB/street/venue) by an order of magnitude in both
  packs, and add more patterns per name kind for variety.
- **Name uniqueness check** — generator draws names independently, so
  duplicates like two "Club Afterlife" on one map happen. Track used
  names per sector and retry (or draw without replacement) so every
  district/POI name is unique within a map. Deterministic retries only —
  same seed must still give same names (`GENERATOR_VERSION` bump).

## Cross-cutting

- **App styling** — the UI currently has no design at all: components use
  ad-hoc inline `style={{…}}` props (KnobPanel, MapView, App, error
  boundary) and browser-default widgets. Replace with a proper stylesheet
  (plain CSS file is enough — no CSS-in-JS dependency) and give the app
  chrome an actual look (dark cyberpunk panel to match the neon theme,
  styled sliders/selects/buttons). Inline styles should survive only where
  values are computed at runtime (e.g. the map transform).

- **Multi-language UI** — English first, German second. UI strings are
  externalized from day one (no hardcoded labels in components) so adding
  German is translation work, not refactoring. Generated map content
  (district/POI names) is flavor-pack territory, not UI i18n.

## Open questions

- Custom domain (sprawlforge.*) — decide when Pages deploy exists.
- Community flavor packs — loading third-party pack JSON from file/URL.
