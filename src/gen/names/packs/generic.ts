import type { FlavorPack } from '../names'

export const generic: FlavorPack = {
  id: 'generic',
  label: 'Generic Cyberpunk',
  tables: {
    adj: ['Neon', 'Iron', 'Chrome', 'Black', 'Lower', 'Upper', 'Old', 'New', 'East', 'West'],
    place: ['Heights', 'Row', 'Docks', 'Yards', 'Junction', 'Terrace', 'Flats', 'Strip', 'Quarter', 'Gardens'],
    corpA: ['Apex', 'Helix', 'Omni', 'Zenith', 'Vertex', 'Nova', 'Kessler', 'Draco', 'Meridian', 'Halcyon'],
    corpB: ['Dynamics', 'Biotech', 'Systems', 'Industries', 'Securities', 'Robotics', 'Logistics', 'Media', 'Energy', 'Holdings'],
    street: ['Wire', 'Circuit', 'Solder', 'Carbon', 'Cobalt', 'Mercury', 'Static', 'Vapor', 'Signal', 'Relay'],
    streetType: ['Street', 'Avenue', 'Boulevard', 'Expressway', 'Route'],
    venue: ['Afterlife', 'Voltage', 'Chrome Cat', 'Zero Zero', 'Blackout', 'The Socket', 'Neon Lotus', 'Glitch'],
  },
  districtPatterns: ['{adj} {place}', '{street} {place}'],
  streetPatterns: ['{street} {streetType}', '{adj} {streetType}'],
  arcologyPatterns: ['{corpA} Arcology', '{corpA}-{corpB} Spire', '{corpA} Hive', 'The {corpB} Ziggurat'],
  arcologyPatternsByDesign: {
    ziggurat: ['The {corpA} Ziggurat', '{corpA} Pyramid', '{corpA}-{corpB} Step Pyramid'],
    cluster: ['{corpA} Towers', '{corpA}-{corpB} Complex', 'The {corpB} Towers'],
    satellites: ['{corpA} Campus', '{corpA}-{corpB} Spire Campus', 'The {corpB} Spire'],
    twins: ['{corpA} Twin Towers', 'The {corpA}-{corpB} Gemini', 'Gemini {corpB} Towers'],
    crescent: ['{corpA} Crescent', 'The {corpB} Arc', '{corpA}-{corpB} Crescent Complex'],
    stack: ['{corpA} Stack', 'The {corpB} Terraces', '{corpA}-{corpB} Terraces'],
  },
  megablockPatterns: ['{place} Block', 'The {adj} Hive', '{place} Stacks', '{adj} Warren'],
  poiTypes: [
    { type: 'corp_hq', label: 'Corporate HQ', zones: ['corp'], namePatterns: ['{corpA} {corpB} HQ'] },
    { type: 'corp_office', label: 'Corporate office', zones: ['corp', 'entertainment'], namePatterns: ['{corpA} {corpB}'] },
    { type: 'club', label: 'Nightclub', zones: ['entertainment', 'slum', 'residential'], namePatterns: ['Club {venue}', '{venue}'] },
    { type: 'clinic', label: 'Clinic', zones: ['residential', 'slum', 'corp'], namePatterns: ['{adj} {place} Clinic', '{corpA} Medcenter'] },
    { type: 'market', label: 'Market', zones: ['slum', 'residential', 'docks'], namePatterns: ['{street} Market', '{adj} Bazaar'] },
    { type: 'safehouse', label: 'Safehouse', zones: ['slum', 'residential', 'industrial', 'docks'], namePatterns: ['{street} Den', '{adj} Hole'] },
    { type: 'warehouse', label: 'Warehouse', zones: ['industrial', 'docks'], namePatterns: ['{corpA} Storage {streetType}', 'Depot {street}'] },
    { type: 'bar', label: 'Bar', zones: ['slum', 'entertainment', 'docks', 'industrial', 'residential', 'corp'], namePatterns: ['The {street}', '{venue} Bar'] },
    { type: 'arcology', label: 'Arcology', zones: ['corp'], namePatterns: ['{corpA} Arcology', '{corpA}-{corpB} Spire', '{corpA} Hive', 'The {corpB} Ziggurat'] },
    { type: 'megablock', label: 'Megablock', zones: ['slum'], namePatterns: ['{place} Block', 'The {adj} Hive', '{place} Stacks', '{adj} Warren'] },
  ],
}
