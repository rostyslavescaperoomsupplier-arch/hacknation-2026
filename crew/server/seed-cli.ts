// npm run seed: wipe the database and generate fresh sample data
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.ts';
import { seed } from './seed.ts';

const file = process.env.CREW_DB || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'crew.db');
console.log('[crew] seeded', file, seed(openDb(file)));
