// Prints the anchor installation list from assistant/shared/positions.ts (the single source of truth).
//   node --experimental-strip-types firmware/tools/anchors.mjs          per-deck summary
//   node --experimental-strip-types firmware/tools/anchors.mjs --csv    one line per anchor: id,ble_name,deck,x,y,z,tx
import { ANCHORS, ANCHOR_PREFIX, DECKS, DECK_NAME, TX_1M } from '../../assistant/shared/positions.ts';

if (process.argv.includes('--csv')) {
  console.log('id,ble_name,deck,x,y,z,tx');
  for (const a of ANCHORS) console.log([a.id, ANCHOR_PREFIX + a.id, a.deck, ...a.at, a.tx ?? TX_1M].join(','));
} else {
  for (const d of DECKS) {
    const ids = ANCHORS.filter((a) => a.deck === d).map((a) => a.id);
    console.log(`${DECK_NAME[d].pl.padEnd(30)} ${String(ids.length).padStart(3)}  ${ids[0]} .. ${ids[ids.length - 1]}`);
  }
  console.log(`${'Razem'.padEnd(30)} ${String(ANCHORS.length).padStart(3)}`);
}
