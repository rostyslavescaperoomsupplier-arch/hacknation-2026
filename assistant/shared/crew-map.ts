// Where the crew database's rooms (teammates' `crew/` server, branch `statystyki`, demo ship "MS Brda") sit on OUR
// ferry model (Jantar Unity, public/models/ship.glb: metres, Y up, bow +Z, port -X).
// The demo DB describes a different ship, so this table is the bridge between the two: room code -> our zone + a 3D
// anchor. When the team re-seeds the DB with Jantar Unity rooms, only this table changes.
// Shared by the assistant server (server/crew.ts) and the client (src/ship/**). Keep it dependency-free.
export type CrewZone =
  | 'bridge' | 'cabins-fwd' | 'cabins-mid' | 'cabins-aft' | 'restaurant' | 'lounge' | 'reclining-lounge'
  | 'vehicle-d1' | 'vehicle-d2' | 'engine-room' | 'engine-control' | 'boat-deck';

export interface CrewRoomPlace { zone: CrewZone; at: [number, number, number] }

export const CREW_ROOM_PLACES: Record<string, CrewRoomPlace> = {
  'D1-01': { zone: 'engine-room', at: [0, -3.5, -52] },        // Maszynownia główna
  'D1-02': { zone: 'engine-control', at: [0, -3.5, -78] },     // Centrala manewrowa (ECR)
  'D1-03': { zone: 'engine-room', at: [-6, -3.5, -12] },       // Warsztat mechaniczny
  'D1-04': { zone: 'engine-room', at: [5, -3.5, -2] },         // Pompownia
  'D1-05': { zone: 'engine-room', at: [0, -3.5, 32] },         // Magazyn części zamiennych
  'D1-06': { zone: 'vehicle-d1', at: [10, 2.2, 52] },          // Chłodnie prowiantowe
  'D2-01': { zone: 'vehicle-d1', at: [0, 2.2, 0] },            // Pokład ładunkowy
  'D2-02': { zone: 'vehicle-d2', at: [-10, 7.4, 48] },         // Biuro ładunkowe
  'D2-03': { zone: 'restaurant', at: [12, 16.4, 46] },         // Kuchnia (galley)
  'D2-04': { zone: 'restaurant', at: [0, 16.4, 40] },          // Mesa załogi
  'D2-05': { zone: 'restaurant', at: [-7, 16.4, 52] },         // Mesa oficerska
  'D2-06': { zone: 'vehicle-d2', at: [10, 7.4, -60] },         // Pralnia
  'D2-07': { zone: 'lounge', at: [-8, 16.4, 9] },              // Szpital okrętowy
  'D2-08': { zone: 'vehicle-d2', at: [-10, 7.4, 56] },         // Magazyn bosmański
  'D3-01': { zone: 'cabins-fwd', at: [0, 12.9, 40] },          // Kabiny oficerskie
  'D3-02': { zone: 'cabins-mid', at: [0, 12.9, 2] },           // Kabiny załogi blok A
  'D3-03': { zone: 'cabins-aft', at: [0, 12.9, -56] },         // Kabiny załogi blok B
  'D3-04': { zone: 'lounge', at: [3, 16.4, 12] },              // Świetlica
  'D3-05': { zone: 'reclining-lounge', at: [0, 16.4, -55] },   // Siłownia
  'D3-06': { zone: 'bridge', at: [8, 19.9, 40] },              // Biuro kapitana
  'D4-01': { zone: 'bridge', at: [0, 22.4, 57] },              // Mostek nawigacyjny
  'D4-02': { zone: 'bridge', at: [-8, 22.4, 50] },             // Kabina radiowa (GMDSS)
  'D4-03': { zone: 'bridge', at: [6, 19.9, 44] },              // Sala odpraw
  'D4-04': { zone: 'boat-deck', at: [12, 19.9, -40] },         // Stacja ratunkowa (muster station A)
};

/** 3D position of a terminal: its room anchor, spread sideways for the 2nd/3rd reader in the same room. */
export function terminalAt(roomCode: string, terminalCode: string): [number, number, number] | null {
  const p = CREW_ROOM_PLACES[roomCode];
  if (!p) return null;
  const n = terminalCode.charCodeAt(terminalCode.length - 1) - 65; // ...-A, -B, -C
  return [p.at[0] + (n > 0 ? 3 * n : 0), p.at[1] + 1.2, p.at[2] + (n > 0 ? 2 : 0)];
}
