# SprawlForge

Free, open, static web toolkit for cyberpunk TTRPGs — system-agnostic,
Shadowrun-friendly. Procedural map generators with deterministic seeds:
share a URL, get the identical map.

**Live:** https://thomaslazar.github.io/sprawlforge/

## Tools

- **Sector generator** — a few km² of sprawl: roads, zoned districts,
  buildings, named POIs. Metric everywhere.
- Metroplex, battlemap and node-map generators: see `docs/ROADMAP.md`.

## Development

Everything runs in the devcontainer (VS Code → "Reopen in Container"):

    npm install
    npm run dev     # http://localhost:5173
    npm test
    npm run build   # static output in dist/

## Self-hosting

`npm run build`, then serve `dist/` with any static file server. The build
uses relative paths (`base: './'`), so any subpath works.

## Design docs

- `docs/specs/` — product and architecture specs
- `docs/plans/` — implementation plans
- `docs/ROADMAP.md` — deferred features

## License

MIT
