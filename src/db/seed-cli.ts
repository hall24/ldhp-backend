import { createPgDb } from './client.js';
import { seedSynthetic } from './seed.js';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to load synthetic seed data with NODE_ENV=production');
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const { db, close } = createPgDb(url);
await seedSynthetic(db);
await close();
console.log('synthetic seed loaded');
