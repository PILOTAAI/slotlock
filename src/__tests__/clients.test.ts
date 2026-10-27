// The language clients as a set: one version, one scenario every suite runs against a server, and a
// CI job that runs all five against the image and cannot pass by skipping them.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT), 'utf8');

const SUITES = {
  python: 'clients/python/tests/test_client.py',
  go: 'clients/go/client_test.go',
  rust: 'clients/rust/tests/client.rs',
  java: 'clients/java/src/test/java/io/pylota/slotlock/SlotlockClientTest.java',
  dotnet: 'clients/dotnet/tests/Slotlock.Tests/SlotlockClientTests.cs',
};

describe('the language clients', () => {
  it('all declare one version', () => {
    const versions = [
      /^__version__ = "([^"]+)"/m.exec(read('clients/python/src/slotlock/_transport.py'))?.[1],
      /^version = "([^"]+)"/m.exec(read('clients/python/pyproject.toml'))?.[1],
      /const Version = "([^"]+)"/.exec(read('clients/go/client.go'))?.[1],
      /^version = "([^"]+)"/m.exec(read('clients/rust/Cargo.toml'))?.[1],
      /^version = "([^"]+)"/m.exec(read('clients/java/build.gradle.kts'))?.[1],
      /VERSION = "([^"]+)"/.exec(read('clients/java/src/main/java/io/pylota/slotlock/SlotlockClient.java'))?.[1],
      /<Version>([^<]+)<\/Version>/.exec(read('clients/dotnet/src/Slotlock/Slotlock.csproj'))?.[1],
      /const string Version = "([^"]+)"/.exec(read('clients/dotnet/src/Slotlock/SlotlockClient.cs'))?.[1],
    ];
    // The package's: the release scripts move them together (scripts/client-versions.sh).
    expect(new Set(versions)).toEqual(new Set([JSON.parse(read('package.json')).version]));
  });

  it.each(Object.entries(SUITES))('%s runs the shared scenario against a server', (_language, path) => {
    const suite = read(path);
    for (const check of [
      'SLOTLOCK_URL',
      'SLOTLOCK_ADMIN_KEY',
      'BK/', // a reference with a slash, a space and an accent, in the path
      'ü',
      'overlap',
      'confirmation_required',
      'resource_not_found',
      'authentication_required',
      'unencrypted',
      'next_cursor',
      'ics:https://calendar.example.com/fleet.ics',
      '00000000-0000-4000-8000-000000000000',
    ]) {
      expect(suite, `${path} lacks ${check}`).toContain(check);
    }
  });

  it('run in CI against the image, after a step that fails without a key', () => {
    const ci = read('.github/workflows/ci.yml');
    const job = ci.slice(ci.indexOf('\n  clients:\n'));
    expect(job).toContain('tags: slotlock:ci');
    expect(job).toContain('SLOTLOCK_CONFIRM_WRITES=slotlock_delete_event');
    expect(job).toContain('--scope read,write,admin');
    expect(job).toMatch(/if \[\[ ! "\$key" =~ \^slk_\[0-9A-Za-z\]\{46\}\$ \]\]; then\n\s+echo "::error::key create printed no key"\n\s+exit 1/);
    expect(job).toContain('echo "::add-mask::$key"');
    const keyStep = job.indexOf('SLOTLOCK_ADMIN_KEY=$key');
    for (const command of [
      'python -m unittest -v tests/test_client.py',
      'go test -count=1 -v ./...',
      'cargo +1.94.0 test --locked',
      'gradle build --console=plain',
      'dotnet run --project tests/Slotlock.Tests',
    ]) {
      const at = job.indexOf(command);
      expect(at, command).toBeGreaterThan(keyStep);
    }
  });
});
