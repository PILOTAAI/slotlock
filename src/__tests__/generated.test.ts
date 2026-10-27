// Files generated from the code, committed so tools and other languages can read them: openapi.json
// (the REST API, application API included) and each language client's operations. Each must equal
// what the code generates now. SLOTLOCK_WRITE_GENERATED=1 writes them instead of comparing.
import { readFileSync, writeFileSync } from 'node:fs';
import { Validator } from '@seriousme/openapi-schema-validator';
import { describe, expect, it } from 'vitest';
import { generateClients } from '../../clients/generate.js';
import { slotlockOpenApi } from '../agent-server.js';

const ROOT = new URL('../../', import.meta.url);
const WRITE = process.env.SLOTLOCK_WRITE_GENERATED === '1';

function expectFile(path: string, content: string) {
  const url = new URL(path, ROOT);
  if (WRITE) {
    writeFileSync(url, content);
    return;
  }
  let committed: string;
  try {
    committed = readFileSync(url, 'utf8');
  } catch {
    committed = '';
  }
  expect(committed, `${path} is stale: run SLOTLOCK_WRITE_GENERATED=1 vitest run src/__tests__/generated.test.ts`).toBe(
    content,
  );
}

/** The repository's OpenAPI document: the version is the API's, not the package's, so a release leaves it alone. */
function repositoryOpenApi() {
  const document = slotlockOpenApi({ application: true }) as { info: Record<string, unknown> };
  return { ...document, info: { ...document.info, version: 'v1' } };
}

describe('generated files', () => {
  it('openapi.json is the REST API the server serves, and valid OpenAPI 3.1', async () => {
    const document = repositoryOpenApi();
    const validator = new Validator();
    const result = await validator.validate(document);
    expect(result.errors ?? []).toEqual([]);
    expectFile('openapi.json', `${JSON.stringify(document, null, 2)}\n`);
  });

  it("each language client's operations are openapi.json's, one method per operation", () => {
    const files = generateClients(repositoryOpenApi());
    expect([...files.keys()]).toHaveLength(5);
    for (const [path, content] of files) expectFile(path, content);
  });

  it("the .NET client still has every method 0.2.0's callers compile against", () => {
    const compat = JSON.parse(
      readFileSync(new URL('clients/dotnet/compat-0.2.0.json', ROOT), 'utf8'),
    ) as { methods: Record<string, string[]> };
    const source = generateClients(repositoryOpenApi()).get(
      'clients/dotnet/src/Slotlock/SlotlockClient.Operations.g.cs',
    ) as string;
    // Every public method's parameter list, defaults left out, by name.
    const methods = new Map<string, string[][]>();
    for (const match of source.matchAll(/public Task<JsonObject> (\w+)\(([^)]*)\)/g)) {
      const params = (match[2] as string).split(',').map((p) => p.trim().replace(/ = default$/, ''));
      methods.set(match[1] as string, [...(methods.get(match[1] as string) ?? []), params]);
    }
    const name = (id: string) =>
      `${id.replace(/^slotlock_/, '').replace(/(^|_)([a-z])/g, (_m, _s, letter: string) => letter.toUpperCase())}Async`;
    expect(Object.keys(compat.methods)).toHaveLength(19);
    for (const [id, params] of Object.entries(compat.methods)) {
      expect(methods.get(name(id)), id).toContainEqual(params);
    }
    // Where a parameter came in before the token, the 0.2.0 list is an overload of its own.
    for (const method of ['CreateResourceAsync', 'AcquireHoldAsync', 'UpdateEventAsync']) {
      expect(methods.get(method), method).toHaveLength(2);
    }
  });
});
