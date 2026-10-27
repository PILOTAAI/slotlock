// The coding-agent prompt (site/src/data/agent-setup-prompt.md) is copied into people's repositories
// and outlives the release it was published with, so it installs the latest release, never a pinned one.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const prompt = readFileSync(join(import.meta.dirname, '..', '..', 'site/src/data/agent-setup-prompt.md'), 'utf8');

describe('the coding-agent setup prompt', () => {
  it('names the published version once, as history', () => {
    expect(prompt.match(/\{\{version\}\}/g)).toEqual(['{{version}}']);
    expect(prompt).toContain('It was {{version}} when this prompt was published.');
    expect(prompt).not.toMatch(/\d+\.\d+\.\d+/);
  });

  it('pins every install to the latest release it looks up', () => {
    for (const install of [
      'git checkout v<version>',
      'npm install slotlock@<version> postgres',
      'pip install slotlock==<version>',
      'cargo add slotlock@<version>',
      'dotnet add package Slotlock.Client -v <version>',
      'go get github.com/PILOTAAI/slotlock/clients/go@v<version>',
      'io.pylota:slotlock:<version>',
    ]) {
      expect(prompt).toContain(install);
    }
    expect(prompt).toContain('npm view slotlock version');
  });

  it('has no hard line breaks inside a sentence, so it wraps in any window', () => {
    for (const line of prompt.split('\n')) {
      // A wrapped line would start mid-sentence: indented without a bullet, or in lower case.
      if (line.trim()) expect(line, line).toMatch(/^(\s*(- |\d+\. )|[A-Z])/);
    }
  });
});
