import { rmSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const dist = fileURLToPath(new URL('../dist/', import.meta.url));

if (basename(dist) !== 'dist' || dirname(dist) !== dirname(scriptDirectory)) {
  throw new Error('Refusing to clean an unexpected Slotlock build directory');
}

rmSync(dist, { force: true, recursive: true });
