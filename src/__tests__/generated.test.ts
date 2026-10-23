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
});
