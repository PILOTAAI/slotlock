// Several runs of the database suites can share one PostgreSQL cluster (one container serving many
// checkouts). Roles are cluster-wide, so a suite that creates a role under a fixed name drops and
// recreates the role another run is using. Every role a suite creates must carry a random part.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const directory = new URL('./', import.meta.url);
const suites = readdirSync(directory).filter((name) => name.endsWith('.integration.test.ts'));

/** Each `CREATE ROLE` in a suite, with the name it creates exactly as the source writes it. */
function createdRoles(source: string): string[] {
  return [...source.matchAll(/CREATE ROLE ("?\$\{[^}]+\}[A-Za-z0-9_]*"?|"?[A-Za-z0-9_]+"?)/g)].map(
    ([, name]) => name as string,
  );
}

/** Whether `variable` is declared in `source` from a random value (directly or through another). */
function randomlyNamed(source: string, variable: string, seen = new Set<string>()): boolean {
  if (seen.has(variable)) return false;
  seen.add(variable);
  const declaration = new RegExp(`(?:const|let) ${variable} = ([^;]+);`).exec(source)?.[1];
  if (declaration === undefined) return false;
  if (/\brandom(?:UUID|Bytes)\(/.test(declaration)) return true;
  return [...declaration.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)].some(([, inner]) =>
    randomlyNamed(source, inner as string, seen),
  );
}

describe('database suite roles', () => {
  it('finds the suites and the roles they create (the scan is not vacuous)', () => {
    expect(suites.length).toBeGreaterThan(10);
    const all = suites.flatMap((name) =>
      createdRoles(readFileSync(new URL(name, directory), 'utf8')),
    );
    expect(all.length).toBeGreaterThan(10);
  });

  it.each(suites)('%s names every role it creates with a random part', (name) => {
    const source = readFileSync(new URL(name, directory), 'utf8');
    for (const role of createdRoles(source)) {
      const variable = /^"?\$\{([A-Za-z_][A-Za-z0-9_]*)/.exec(role)?.[1];
      // A literal name, or one built from a value that is the same on every run, collides.
      expect({ role, random: variable !== undefined && randomlyNamed(source, variable) }).toEqual({
        role,
        random: true,
      });
    }
  });
});
