// Physical RFID terminals (server/terminals.ts): check-in body validation for POST /api/checkin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validCheckin } from '../server/terminals.ts';

test('checkin validation: 4- and 7-byte UIDs, any separators, direction defaults to in', () => {
  assert.deepEqual(validCheckin({ rfid: '59:BA:E9:5A', terminal: 'T-D4-01-A' }), { rfid: '59:BA:E9:5A', terminal: 'T-D4-01-A', direction: 'in' });
  assert.equal(validCheckin({ rfid: '04-95-34-a7-e8-60-ac', terminal: 'T-D4-01-A', direction: 'out' })?.direction, 'out');
});

test('checkin validation: rejects junk', () => {
  for (const b of [null, {}, { rfid: '59:BA:E9:5A' }, { rfid: 'DROP TABLE', terminal: 'T' }, { rfid: '59:BA:E9', terminal: 'T' },
    { rfid: '59:BA:E9:5A:1', terminal: 'T' }, { rfid: '59:BA:E9:5A', terminal: "T'; --" }, { rfid: '59:BA:E9:5A', terminal: 'T', direction: 'up' },
    { rfid: 1234, terminal: 'T' }]) assert.equal(validCheckin(b), null, JSON.stringify(b));
});
