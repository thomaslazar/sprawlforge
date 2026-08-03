# SprawlForge Roadmap

## Build order

1. **Sector generator** — v1 per `docs/specs/2026-08-03-sprawlforge-design.md`
2. **Metroplex generator** — parent of sectors, proves linkage chain
3. **Battlemap generator** — interiors/street combat, seeded from sector buildings
4. **Node map generator** — abstract location graphs

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
- **Tile-based rendering** for metroplex scale — only if SVG performance
  actually hurts.

## Cross-cutting

- **Multi-language UI** — English first, German second. UI strings are
  externalized from day one (no hardcoded labels in components) so adding
  German is translation work, not refactoring. Generated map content
  (district/POI names) is flavor-pack territory, not UI i18n.

## Open questions

- Custom domain (sprawlforge.*) — decide when Pages deploy exists.
- Community flavor packs — loading third-party pack JSON from file/URL.
