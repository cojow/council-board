// Node's explicit directory entry point keeps `node --test test/` portable.
import fs from 'node:fs';

for (const file of fs.readdirSync(new URL('.', import.meta.url)).sort()) {
  if (file.endsWith('.test.mjs')) await import(new URL(file, import.meta.url));
}
