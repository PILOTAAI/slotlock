// The REST reference and Postman collection on slotlock.pylota.io (site/scripts/api-reference.mjs)
// are generated from openapi.json: every route has a page and a request, and nothing else.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

interface Reference {
  overview: string;
  pages: { slug: string; group: string; markdown: string }[];
  postman: {
    auth: { type: string };
    variable: { key: string }[];
    item: { name: string; item: { name: string; request: { method: string; url: { raw: string } } }[] }[];
  };
  operationCount: number;
}

const generator = (await import(
  pathToFileURL(join(root, 'site/scripts/api-reference.mjs')).href
)) as {
  renderApiReference(args: {
    openApi: unknown;
    version: string;
    toolExamples: Record<string, unknown>;
    fail(message: string): never;
  }): Reference;
  readApiOperations(openApi: unknown): Map<string, { method: string; path: string }>;
  pageSlug(id: string): string;
  GROUPS: { name: string; operations: string[] }[];
};

const openApi = JSON.parse(read('openapi.json'));
const fail = (message: string): never => {
  throw new Error(message);
};

describe('the site REST reference', () => {
  const reference = generator.renderApiReference({
    openApi,
    version: '0.0.0',
    toolExamples: {},
    fail,
  });
  const operations = generator.readApiOperations(openApi);

  it('has one page per operation in openapi.json, each with its method and route', () => {
    expect(reference.pages).toHaveLength(operations.size);
    for (const [id, operation] of operations) {
      const page = reference.pages.find((p) => p.slug === generator.pageSlug(id));
      expect(page, id).toBeDefined();
      expect(page?.markdown).toContain(
        `api-method-${operation.method}">${operation.method.toUpperCase()}</span><code>${operation.path}</code>`,
      );
    }
  });

  it('puts every operation in the Postman collection once, behind a bearer key', () => {
    const requests = reference.postman.item.flatMap((folder) => folder.item);
    expect(requests).toHaveLength(operations.size);
    expect(reference.postman.auth.type).toBe('bearer');
    expect(reference.postman.variable.map((v) => v.key)).toEqual(
      expect.arrayContaining(['baseUrl', 'apiKey']),
    );
    const routes = requests.map((r) => `${r.request.method} ${r.request.url.raw.split('?')[0]}`);
    for (const operation of operations.values()) {
      expect(routes).toContain(
        `${operation.method.toUpperCase()} {{baseUrl}}${operation.path.replace(/\{(.+?)\}/g, ':$1')}`,
      );
    }
  });

  it('refuses an operation that has no group, so a new route cannot go undocumented', () => {
    const withExtra = structuredClone(openApi);
    withExtra.paths['/v1/new-thing'] = {
      get: { ...openApi.paths['/v1/resources'].get, operationId: 'slotlock_new_thing' },
    };
    expect(() =>
      generator.renderApiReference({ openApi: withExtra, version: '0.0.0', toolExamples: {}, fail }),
    ).toThrow(/slotlock_new_thing; add it to GROUPS/);
  });

  it('names only error codes the server can answer', () => {
    const source = ['agent-server.ts', 'agent-store-backend.ts', 'application-api.ts', 'store.ts', 'types.ts']
      .map((file) => read(`src/${file}`))
      .join('\n');
    const errors = reference.overview.slice(reference.overview.indexOf('## Errors'));
    const codes = [...errors.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map(([, code]) => code as string);
    expect(codes.length).toBeGreaterThan(10);
    for (const code of codes) expect(source, code).toContain(`'${code}'`);
  });
});
