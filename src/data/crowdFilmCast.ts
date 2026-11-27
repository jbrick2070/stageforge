export const STEAMBOAT_FILM = Object.freeze({
  title: 'Steamboat Willie',
  year: 1928,
  sourceUrl: 'https://commons.wikimedia.org/wiki/File:Steamboat_Willie_(1928)_by_Walt_Disney.webm',
  continuityUrl: 'https://tile.loc.gov/storage-services/service/mbrs/cdmmi/s2/94/5m/02/12/4/s2945m02124/s2945m02124.pdf',
} as const);

export const STEAMBOAT_APPEARANCES = Object.freeze({
  'stageforge-steamboat-1928-mickey-capped': { family: 'cartoon', role: "Mickey Mouse", appearance: "Boat-hand cap", scene: "Opening wheelhouse sequence" },
  'stageforge-steamboat-1928-mickey-bare': { family: 'cartoon', role: "Mickey Mouse", appearance: "Hat off", scene: "Potato peeling and parrot finale" },
  'stageforge-steamboat-1928-minnie-with-ukulele': { family: 'cartoon', role: "Minnie Mouse", appearance: "With ukulele", scene: "Podunk Landing boarding" },
  'stageforge-steamboat-1928-minnie': { family: 'cartoon', role: "Minnie Mouse", appearance: "Flower hat and skirt", scene: "Deck performance" },
  'stageforge-steamboat-1928-pete': { family: 'cartoon', role: "Captain Pete", appearance: "Captain's hat", scene: "Wheelhouse confrontation" },
  'stageforge-steamboat-1928-parrot': { family: 'animal', role: "Ship's parrot", appearance: "Perched", scene: "Wheelhouse and porthole" },
  'stageforge-steamboat-1928-cow-thin': { family: 'animal', role: "Dock cow", appearance: "Before hay", scene: "Dock loading sequence" },
  'stageforge-steamboat-1928-cow-round': { family: 'animal', role: "Dock cow", appearance: "After hay", scene: "Dock loading and deck performance" },
  'stageforge-steamboat-1928-goat': { family: 'animal', role: "Goat", appearance: "Short tail and beard", scene: "Sheet-music and phonograph gag" },
  'stageforge-steamboat-1928-galley-cat': { family: 'animal', role: "Galley cat", appearance: "Long curled tail", scene: "Musical performance" },
  'stageforge-steamboat-1928-waterfowl': { family: 'animal', role: "Duck", appearance: "Broad bill", scene: "Musical performance" },
  'stageforge-steamboat-1928-sow': { family: 'animal', role: "Mother pig", appearance: "Sow", scene: "Deck performance" },
  'stageforge-steamboat-1928-piglet-light': { family: 'animal', role: "Piglet", appearance: "Light coat", scene: "Piglet litter on deck" },
  'stageforge-steamboat-1928-piglet-dark': { family: 'animal', role: "Piglet", appearance: "Dark coat", scene: "Piglet litter on deck" },
  'stageforge-steamboat-1928-dock-bird-upright': { family: 'animal', role: "Dock bird", appearance: "Upright", scene: "Podunk Landing crate" },
  'stageforge-steamboat-1928-dock-bird-leaning': { family: 'animal', role: "Dock bird", appearance: "Leaning", scene: "Podunk Landing crate" },
} as const);

export type SteamboatModelId = keyof typeof STEAMBOAT_APPEARANCES;

export const STEAMBOAT_MODEL_IDS = Object.freeze(Object.keys(STEAMBOAT_APPEARANCES) as SteamboatModelId[]);

export function isSteamboatModelId(id: string): id is SteamboatModelId {
  return Object.hasOwn(STEAMBOAT_APPEARANCES, id);
}

/** The standard cast preset includes one appearance per role, three piglets, and both dock birds. */
export const STEAMBOAT_DEFAULT_PLACEMENT_MODEL_IDS = [
  'stageforge-steamboat-1928-mickey-capped',
  'stageforge-steamboat-1928-minnie-with-ukulele',
  'stageforge-steamboat-1928-pete',
  'stageforge-steamboat-1928-parrot',
  'stageforge-steamboat-1928-cow-thin',
  'stageforge-steamboat-1928-goat',
  'stageforge-steamboat-1928-galley-cat',
  'stageforge-steamboat-1928-waterfowl',
  'stageforge-steamboat-1928-sow',
  'stageforge-steamboat-1928-piglet-light',
  'stageforge-steamboat-1928-piglet-dark',
  'stageforge-steamboat-1928-piglet-light',
  'stageforge-steamboat-1928-dock-bird-upright',
  'stageforge-steamboat-1928-dock-bird-leaning',
] as const satisfies readonly SteamboatModelId[];
