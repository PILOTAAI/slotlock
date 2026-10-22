// The package version, read from package.json so that file is the one place it is set. Built, this
// module sits beside the artifact's own package.json (scripts/prepare-package.mjs writes it from the
// root one), which is where it is installed from npm or copied into the image; run from a checkout's
// src/, the root package.json is one directory up.
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
