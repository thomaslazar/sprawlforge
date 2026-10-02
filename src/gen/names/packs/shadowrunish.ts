import type { FlavorPack } from '../names'
import { generic } from './generic'

export const shadowrunish: FlavorPack = {
  ...generic,
  id: 'shadowrunish',
  label: 'Sprawl (Shadowrun-ish)',
  tables: {
    ...generic.tables,
    adj: ['Redmond', 'Puyallup', 'Downtown', 'Tacoma', 'Everett', 'Auburn', 'Lower', 'Old', 'North', 'South'],
    corpA: ['Shirasagi', 'Tanaka-Doyle', 'Federated Kord', 'Zeta-Prime', 'Aztek', 'Renraki', 'Evo-Dyne', 'Wuxing-Pac', 'Saeder', 'Mitsuhama-West'],
    venue: ['The Daze', 'Matchsticks', 'Banshee', 'The Big Rhino', 'Underworld', 'Penumbra', 'Dante\'s', 'The Skeleton'],
  },
  arcologyPatterns: ['{corpA} Arcology Complex', '{corpA} Corporate Court', '{corpA} Spire', 'The {corpA} Tower'],
  megablockPatterns: ['{adj} Sprawl Block', 'The {adj} Warrens', '{adj} Housing Stack', '{adj} Barrens Tower'],
  poiTypes: [
    ...generic.poiTypes.filter((p) => p.type !== 'arcology' && p.type !== 'megablock'),
    { type: 'talismonger', label: 'Talismonger', zones: ['slum', 'residential', 'entertainment'], namePatterns: ['{adj} Talismans', '{street} Charms'] },
    { type: 'matrix_hub', label: 'Matrix hub', zones: ['corp', 'entertainment', 'residential'], namePatterns: ['{corpA} Grid Node', '{street} Hub'] },
    { type: 'arcology', label: 'Arcology', zones: ['corp'], namePatterns: ['{corpA} Arcology Complex', '{corpA} Corporate Court', '{corpA} Spire', 'The {corpA} Tower'] },
    { type: 'megablock', label: 'Megablock', zones: ['slum'], namePatterns: ['{adj} Sprawl Block', 'The {adj} Warrens', '{adj} Housing Stack', '{adj} Barrens Tower'] },
  ],
}
