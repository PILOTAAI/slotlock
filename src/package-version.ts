// Read from package.json so that file is the one place the version is set: built, the artifact's
// own package.json sits beside this module; in a checkout's src/, the root one is a directory up.
import { readFileSync } from 'node:fs';

/** Slotlock's version, or `'unknown'` where no manifest of its own can be read (a bundle). */
export function slotlockPackageVersion(): string {
  for (const candidate of ['./package.json', '../package.json']) {
    try {
      const manifest = JSON.parse(readFileSync(new URL(candidate, import.meta.url), 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (manifest.name === 'slotlock' && typeof manifest.version === 'string') {
        return manifest.version;
      }
    } catch {
      // Not this layout; try the next.
    }
  }
  return 'unknown';
}
