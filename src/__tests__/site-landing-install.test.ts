// The landing hero's install card (site/src/data/landing.ts) switches targets with radio buttons and
// CSS alone, so each target needs its own selectors in landing.css or its tab never shows anything.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const landing = readFileSync(join(root, 'site/src/data/landing.ts'), 'utf8');
const css = readFileSync(join(root, 'site/src/styles/landing.css'), 'utf8');

const install = landing.slice(landing.indexOf('  install: ['), landing.indexOf('] satisfies InstallTarget[]'));
const targets = [...install.matchAll(/id: '([a-z]+)',[\s\S]*?command: ([^\n]+)/g)].map(([, id, command]) => ({
  id: id as string,
  command: command as string,
}));

describe('the landing install card', () => {
  it('offers the server and every registry client', () => {
    expect(targets.map((t) => t.id)).toEqual(['docker', 'npm', 'python', 'go', 'rust', 'java', 'dotnet']);
  });

  it('styles the tab, command and note of every target', () => {
    for (const { id } of targets) {
      expect(css, id).toContain(`#install-${id}:checked ~ .install .install__targets label[for='install-${id}']`);
      expect(css, id).toContain(`#install-${id}:focus-visible ~ .install .install__targets label[for='install-${id}']`);
      expect(css, id).toContain(`#install-${id}:checked ~ .install [data-install='${id}']`);
      expect(css, id).toContain(`#install-${id}:checked ~ .install__notes [data-note='${id}']`);
    }
  });

  it('pins every package install to the release', () => {
    for (const { id, command } of targets.filter((t) => t.id !== 'docker')) {
      expect(command, id).toContain('${facts.version}');
    }
  });
});
