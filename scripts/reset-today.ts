import { loadEnv } from '../lib/load-env.js';
loadEnv();

import { getDb } from '../lib/db.js';

const date = new Date().toLocaleDateString('sv-SE');
const db = getDb();
const result = db.prepare('DELETE FROM activities WHERE date = ?').run(date);
console.log(`Deleted ${result.changes} records for ${date}`);
