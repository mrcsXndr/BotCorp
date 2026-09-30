// Gzip total of the built JS (dist/assets/*.js), in KB. CI fails the build over the budget.
import { readdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'assets');
const budget = Number(process.argv[2] || 450);
let total = 0;
for (const f of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
  const gz = gzipSync(readFileSync(path.join(dir, f))).length;
  total += gz;
  console.log(`${(gz / 1024).toFixed(1).padStart(8)} KB  ${f}`);
}
const kb = total / 1024;
console.log(`${kb.toFixed(1).padStart(8)} KB  total gzip (budget ${budget} KB)`);
process.exit(kb <= budget ? 0 : 1);
