// Wardrobe for the 3D gull: slot + colours per modelled item (from Gniazdo Mewki catalog).
export type Slot = 'head' | 'neck' | 'eyes' | 'body' | 'hand';
export type ItemId = string;
export type Outfit = Partial<Record<Slot, ItemId>>;
export interface Item { id: ItemId; slot: Slot; name: string; colors: string[] }

export const ITEMS: Item[] = [
  {"id":"bowtie-black","slot":"neck","name":"Czarna muszka","colors":["#111111"]},
  {"id":"kerchief-red","slot":"neck","name":"Czerwona apaszka","colors":["#b3261e","#ffffff"]},
  {"id":"tuning-fork","slot":"hand","name":"Kamerton","colors":["#3a3a3a","#ffffff"]},
  {"id":"round-sunglasses","slot":"eyes","name":"Okrągłe okulary","colors":["#111111","#b39a5a"]},
  {"id":"scarf-gold","slot":"neck","name":"Złoty szalik","colors":["#b39a5a","#7a6328"]},
  {"id":"sailor-sweater","slot":"body","name":"Marynarski sweter w paski","colors":["#ffffff","#1f3a5f"]},
  {"id":"sailor-cap","slot":"head","name":"Czapka marynarska","colors":["#ffffff","#1f3a5f","#b39a5a"]},
  {"id":"headphones","slot":"head","name":"Słuchawki","colors":["#111111","#b39a5a"]},
  {"id":"bowtie-gold","slot":"neck","name":"Złota muszka","colors":["#b39a5a"]},
  {"id":"baton","slot":"hand","name":"Batuta","colors":["#ffffff","#8a5a2b"]},
  {"id":"tailcoat","slot":"body","name":"Frak","colors":["#111111","#ffffff"]},
  {"id":"top-hat","slot":"head","name":"Cylinder","colors":["#111111","#b39a5a"]},
  {"id":"jazz-beret","slot":"head","name":"Jazzowy beret","colors":["#111111","#b3261e"]},
  {"id":"laurel","slot":"head","name":"Wieniec laurowy","colors":["#b39a5a","#3f6b3a"]},
  {"id":"school-backpack","slot":"body","name":"Szkolny plecak","colors":["#b39a5a","#1f3a5f"]},
  {"id":"monocle","slot":"eyes","name":"Monokl","colors":["#b39a5a"]},
  {"id":"opera-glasses","slot":"hand","name":"Lornetka teatralna","colors":["#b39a5a","#111111"]},
];

const map = new Map(ITEMS.map((i) => [i.id, i]));
export const itemById = (id: ItemId): Item | undefined => map.get(id);
