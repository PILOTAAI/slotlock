// The language clients' operations, generated from openapi.json: one method per REST operation in
// Python, Go, Rust, Java and C#, with the operation's route and its arguments typed as the schema
// says. Each client's transport (HTTP, the key, JSON, errors) is written by hand beside it.
// src/__tests__/generated.test.ts compares these files with the committed ones, and writes them
// when SLOTLOCK_WRITE_GENERATED=1.

type Schema = Record<string, unknown>;

export type Kind =
  | { type: 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'any' }
  | { type: 'array'; items: Kind };

export interface Field {
  name: string;
  required: boolean;
  nullable: boolean;
  kind: Kind;
  description: string;
}

export interface ClientOperation {
  /** The operationId, `slotlock_…`. */
  id: string;
  /** The id without its `slotlock_` prefix: `acquire_hold`. */
  name: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  /** Path parameters, in the order the path names them. */
  pathParams: Field[];
  /** Query parameters (GET and DELETE). */
  query: Field[];
  /** Body fields (POST, PUT and PATCH). */
  body: Field[];
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

function typesOf(schema: Schema): string[] {
  const type = schema.type;
  if (typeof type === 'string') return [type];
  if (Array.isArray(type)) return type.map(String);
  return [];
}

/** What a schema holds, and whether it may be null. */
export function kindOf(schema: Schema | undefined): { kind: Kind; nullable: boolean } {
  if (!schema) return { kind: { type: 'any' }, nullable: false };
  const union = (schema.anyOf ?? schema.oneOf) as Schema[] | undefined;
  if (Array.isArray(union)) {
    const nullable = union.some((member) => typesOf(member).includes('null'));
    const members = union.filter(
      (member) => !(typesOf(member).length === 1 && typesOf(member)[0] === 'null'),
    );
    if (members.length === 1) {
      const inner = kindOf(members[0]);
      return { kind: inner.kind, nullable: nullable || inner.nullable };
    }
    const kinds = members.map((member) => kindOf(member).kind.type);
    const same = kinds.every((kind) => kind === kinds[0]) && kinds[0] !== 'array';
    return { kind: { type: same ? (kinds[0] as 'string') : 'any' }, nullable };
  }
  const types = typesOf(schema);
  const nullable = types.includes('null');
  const base = types.filter((type) => type !== 'null');
  if (base.length === 0) {
    if (Array.isArray(schema.enum) && schema.enum.every((value) => typeof value === 'string')) {
      return { kind: { type: 'string' }, nullable };
    }
    if (typeof schema.const === 'string') return { kind: { type: 'string' }, nullable };
    return { kind: { type: 'any' }, nullable };
  }
  if (base.length > 1) return { kind: { type: 'any' }, nullable };
  const type = base[0] as string;
  if (type === 'array') {
    return {
      kind: { type: 'array', items: kindOf(schema.items as Schema | undefined).kind },
      nullable,
    };
  }
  if (
    type === 'string' ||
    type === 'integer' ||
    type === 'number' ||
    type === 'boolean' ||
    type === 'object'
  ) {
    return { kind: { type }, nullable };
  }
  return { kind: { type: 'any' }, nullable };
}

function field(name: string, schema: Schema | undefined, required: boolean): Field {
  const { kind, nullable } = kindOf(schema);
  const description = typeof schema?.description === 'string' ? schema.description : '';
  return { name, required, nullable, kind, description };
}

/** Every operation of an OpenAPI document Slotlock wrote, in the document's order. */
export function clientOperations(document: Schema): ClientOperation[] {
  const operations: ClientOperation[] = [];
  const paths = document.paths as Record<string, Record<string, Schema>>;
  for (const [path, item] of Object.entries(paths)) {
    for (const method of METHODS) {
      const operation = item[method];
      if (!operation) continue;
      const id = String(operation.operationId);
      const parameters = (operation.parameters ?? []) as Schema[];
      const order = [...path.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string);
      const pathParams = order.map((name) => {
        const parameter = parameters.find(
          (candidate) => candidate.in === 'path' && candidate.name === name,
        );
        return field(name, parameter?.schema as Schema | undefined, true);
      });
      const query = parameters
        .filter((parameter) => parameter.in === 'query')
        .map((parameter) =>
          field(String(parameter.name), parameter.schema as Schema, parameter.required === true),
        );
      const bodySchema = (
        (operation.requestBody as Schema | undefined)?.content as Record<string, Schema> | undefined
      )?.['application/json']?.schema as Schema | undefined;
      const required = new Set((bodySchema?.required ?? []) as string[]);
      const body = Object.entries((bodySchema?.properties ?? {}) as Record<string, Schema>).map(
        ([name, schema]) => field(name, schema, required.has(name)),
      );
      operations.push({
        id,
        name: id.replace(/^slotlock_/, ''),
        method: method.toUpperCase(),
        path,
        summary: String(operation.summary ?? ''),
        description: String(operation.description ?? ''),
        pathParams,
        query,
        body,
      });
    }
  }
  return operations;
}

/** Arguments in the order a method takes them: path, then required, then optional. */
function argumentsOf(operation: ClientOperation): {
  path: Field[];
  required: Field[];
  optional: Field[];
} {
  const rest = [...operation.query, ...operation.body];
  return {
    path: operation.pathParams,
    required: rest.filter((candidate) => candidate.required),
    optional: rest.filter((candidate) => !candidate.required),
  };
}

const camel = (name: string) =>
  name.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());
const pascal = (name: string) => {
  const value = camel(name);
  return value.charAt(0).toUpperCase() + value.slice(1);
};
/** Go's initialisms: ResourceID, ResourceIDs, TTLSeconds. */
const goName = (name: string) =>
  name
    .split('_')
    .map((part) => {
      if (part === 'id') return 'ID';
      if (part === 'ids') return 'IDs';
      if (part === 'ttl') return 'TTL';
      if (part === 'url') return 'URL';
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join('');

/** `text` in lines of at most `width` characters, each starting with `prefix`. */
function wrap(text: string, prefix: string, width = 98): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\n+/)) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && prefix.length + line.length + 1 + word.length > width) {
        lines.push(`${prefix}${line}`);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) lines.push(`${prefix}${line}`);
  }
  return lines;
}

const HEADER =
  'Generated from openapi.json by clients/generate.ts. Do not edit: change the server, then run\n' +
  'SLOTLOCK_WRITE_GENERATED=1 npx vitest run src/__tests__/generated.test.ts';

// ---------------------------------------------------------------------------------------- Python

const PYTHON_KEYWORDS = new Set([
  'from',
  'import',
  'class',
  'def',
  'global',
  'lambda',
  'pass',
  'in',
  'is',
  'type',
]);

function pythonType(kind: Kind): string {
  switch (kind.type) {
    case 'string':
      return 'str';
    case 'integer':
      return 'int';
    case 'number':
      return 'float';
    case 'boolean':
      return 'bool';
    case 'object':
      return 'dict[str, Any]';
    case 'array':
      return `list[${pythonType(kind.items)}]`;
    default:
      return 'Any';
  }
}

const pythonArg = (name: string) => (PYTHON_KEYWORDS.has(name) ? `${name}_` : name);
const pythonDoc = (text: string) => text.replaceAll('\\', '\\\\').replaceAll('"""', '\\"\\"\\"');

function pythonOperations(operations: ClientOperation[]): string {
  const out: string[] = [
    ...HEADER.split('\n').map((line) => `# ${line}`),
    'from __future__ import annotations',
    '',
    'from typing import Any',
    '',
    'from ._transport import UNSET, Operation, Transport, Unset',
    '',
    '#: Every operation, by name: its method, path, path parameters and query parameters.',
    'OPERATIONS: dict[str, Operation] = {',
  ];
  for (const operation of operations) {
    const tuple = (names: string[]) =>
      `(${names.map((name) => `"${name}"`).join(', ')}${names.length === 1 ? ',' : ''})`;
    out.push(
      `    "${operation.id}": Operation(`,
      `        "${operation.id}",`,
      `        "${operation.method}",`,
      `        "${operation.path}",`,
      `        ${tuple(operation.pathParams.map(({ name }) => name))},`,
      `        ${tuple(operation.query.map(({ name }) => name))},`,
      '    ),',
    );
  }
  out.push(
    '}',
    '',
    '',
    'class Operations(Transport):',
    '    """Every Slotlock REST operation as a method; `call` runs one by name."""',
    '',
  );
  for (const operation of operations) {
    const { path, required, optional } = argumentsOf(operation);
    const params = ['self', ...path.map((p) => `${pythonArg(p.name)}: str`)];
    if (required.length + optional.length > 0) params.push('*');
    for (const p of required)
      params.push(`${pythonArg(p.name)}: ${pythonType(p.kind)}${p.nullable ? ' | None' : ''}`);
    for (const p of optional) {
      params.push(
        p.nullable
          ? `${pythonArg(p.name)}: ${pythonType(p.kind)} | None | Unset = UNSET`
          : `${pythonArg(p.name)}: ${pythonType(p.kind)} | None = None`,
      );
    }
    const signature = `    def ${operation.name}(${params.join(', ')}) -> dict[str, Any]:`;
    if (signature.length <= 100) {
      out.push(signature);
    } else {
      out.push(`    def ${operation.name}(`);
      for (const param of params) out.push(`        ${param},`);
      out.push('    ) -> dict[str, Any]:');
    }
    out.push(`        """${pythonDoc(operation.summary)}.`, '');
    out.push(...wrap(pythonDoc(operation.description), '        '));
    const documented = [...path, ...required, ...optional].filter((p) => p.description);
    if (documented.length > 0) {
      out.push('', '        Args:');
      for (const p of documented)
        out.push(...wrap(`${pythonArg(p.name)}: ${pythonDoc(p.description)}`, '            '));
    }
    out.push('        """');
    const initial = [...path, ...required].map((p) => `"${p.name}": ${pythonArg(p.name)}`);
    const values = `        values: dict[str, Any] = {${initial.join(', ')}}`;
    if (values.length <= 100) {
      out.push(values);
    } else {
      out.push(
        '        values: dict[str, Any] = {',
        ...initial.map((entry) => `            ${entry},`),
        '        }',
      );
    }
    for (const p of optional) {
      out.push(
        p.nullable
          ? `        if not isinstance(${pythonArg(p.name)}, Unset):`
          : `        if ${pythonArg(p.name)} is not None:`,
        `            values["${p.name}"] = ${pythonArg(p.name)}`,
      );
    }
    out.push(`        return self.call("${operation.id}", values)`, '');
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

// -------------------------------------------------------------------------------------------- Go

function goType(kind: Kind): string {
  switch (kind.type) {
    case 'string':
      return 'string';
    case 'integer':
      return 'int64';
    case 'number':
      return 'float64';
    case 'boolean':
      return 'bool';
    case 'object':
      return 'map[string]any';
    case 'array':
      return `[]${goType(kind.items)}`;
    default:
      return 'any';
  }
}
const goReference = (kind: Kind) =>
  kind.type === 'array' || kind.type === 'object' || kind.type === 'any';

function goOperations(operations: ClientOperation[]): string {
  const out: string[] = [
    ...HEADER.split('\n').map((line) => `// ${line}`),
    '',
    '// Code generated by clients/generate.ts. DO NOT EDIT.',
    '',
    'package slotlock',
    '',
    'import "context"',
    '',
    '// operations is every operation, by name: its method, path, path parameters and query parameters.',
    'var operations = func() map[string]operation {',
    '\tlist := []operation{',
  ];
  for (const operation of operations) {
    const list = (names: string[]) =>
      names.length ? `[]string{${names.map((name) => `"${name}"`).join(', ')}}` : 'nil';
    out.push(
      `\t\t{name: "${operation.id}", method: "${operation.method}", path: "${operation.path}", pathParams: ${list(
        operation.pathParams.map(({ name }) => name),
      )}, query: ${list(operation.query.map(({ name }) => name))}},`,
    );
  }
  out.push(
    '\t}',
    '\tbyName := make(map[string]operation, len(list))',
    '\tfor _, op := range list {',
    '\t\tbyName[op.name] = op',
    '\t}',
    '\treturn byName',
    '}()',
    '',
  );
  for (const operation of operations) {
    const { path, required, optional } = argumentsOf(operation);
    const type = `${goName(operation.name)}Input`;
    const fields = [...path, ...required, ...optional];
    out.push(`// ${type} holds the arguments of [Client.${goName(operation.name)}].`);
    out.push(`type ${type} struct {`);
    fields.forEach((p, index) => {
      if (index > 0) out.push('');
      if (p.description) out.push(...wrap(p.description, '\t// '));
      let fieldType: string;
      if (p.required)
        fieldType = p.nullable && !goReference(p.kind) ? `*${goType(p.kind)}` : goType(p.kind);
      else if (p.nullable) fieldType = `Nullable[${goType(p.kind)}]`;
      else fieldType = goReference(p.kind) ? goType(p.kind) : `*${goType(p.kind)}`;
      out.push(`\t${goName(p.name)} ${fieldType}`);
    });
    out.push('}', '');
    out.push(`func (in ${type}) values() map[string]any {`, '\tvalues := map[string]any{}');
    for (const p of fields) {
      const name = goName(p.name);
      if (p.required) {
        out.push(`\tvalues["${p.name}"] = in.${name}`);
      } else if (p.nullable) {
        out.push(
          `\tif value, ok := in.${name}.get(); ok {`,
          `\t\tvalues["${p.name}"] = value`,
          '\t}',
        );
      } else if (goReference(p.kind)) {
        out.push(`\tif in.${name} != nil {`, `\t\tvalues["${p.name}"] = in.${name}`, '\t}');
      } else {
        out.push(`\tif in.${name} != nil {`, `\t\tvalues["${p.name}"] = *in.${name}`, '\t}');
      }
    }
    out.push('\treturn values', '}', '');
    out.push(
      ...wrap(`${goName(operation.name)}: ${operation.summary}. ${operation.description}`, '// '),
    );
    out.push(
      `func (c *Client) ${goName(operation.name)}(ctx context.Context, in ${type}) (map[string]any, error) {`,
      `\treturn c.Call(ctx, "${operation.id}", in.values())`,
      '}',
      '',
    );
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

// ------------------------------------------------------------------------------------------ Rust

const RUST_KEYWORDS = new Set([
  'type',
  'ref',
  'match',
  'move',
  'self',
  'impl',
  'fn',
  'mod',
  'use',
  'where',
  'loop',
]);

function rustType(kind: Kind): string {
  switch (kind.type) {
    case 'string':
      return 'String';
    case 'integer':
      return 'i64';
    case 'number':
      return 'f64';
    case 'boolean':
      return 'bool';
    case 'array':
      return `Vec<${rustType(kind.items)}>`;
    default:
      return 'Value';
  }
}
const rustField = (name: string) => (RUST_KEYWORDS.has(name) ? `r#${name}` : name);

function rustOperations(operations: ClientOperation[]): string {
  const out: string[] = [
    ...HEADER.split('\n').map((line) => `// ${line}`),
    '',
    'use serde::Serialize;',
    'use serde_json::Value;',
    '',
    'use crate::{Client, Error, Operation};',
    '',
    '/// Every operation: its name, method, path, path parameters and query parameters.',
    'pub(crate) const OPERATIONS: &[Operation] = &[',
  ];
  for (const operation of operations) {
    const list = (names: string[]) => `&[${names.map((name) => `"${name}"`).join(', ')}]`;
    out.push(
      '    Operation {',
      `        name: "${operation.id}",`,
      `        method: "${operation.method}",`,
      `        path: "${operation.path}",`,
      `        path_params: ${list(operation.pathParams.map(({ name }) => name))},`,
      `        query: ${list(operation.query.map(({ name }) => name))},`,
      '    },',
    );
  }
  out.push('];', '');
  for (const operation of operations) {
    const { path, required, optional } = argumentsOf(operation);
    const type = `${pascal(operation.name)}Input`;
    const fields = [...path, ...required, ...optional];
    // Default lets a call name only what it sets (`..Default::default()`); the server refuses a
    // required argument left empty.
    out.push(
      `/// The arguments of [\`Client::${operation.name}\`].`,
      '#[derive(Debug, Clone, Default, Serialize)]',
      `pub struct ${type} {`,
    );
    for (const p of fields) {
      if (p.description) out.push(...wrap(p.description, '    /// '));
      if (p.required) {
        out.push(
          `    pub ${rustField(p.name)}: ${p.nullable ? `Option<${rustType(p.kind)}>` : rustType(p.kind)},`,
        );
      } else if (p.nullable) {
        out.push(
          '    /// `None` leaves it out; `Some(None)` sends null, which clears it.',
          '    #[serde(skip_serializing_if = "Option::is_none")]',
          `    pub ${rustField(p.name)}: Option<Option<${rustType(p.kind)}>>,`,
        );
      } else {
        out.push(
          '    #[serde(skip_serializing_if = "Option::is_none")]',
          `    pub ${rustField(p.name)}: Option<${rustType(p.kind)}>,`,
        );
      }
    }
    out.push('}', '');
  }
  out.push('impl Client {');
  for (const operation of operations) {
    const type = `${pascal(operation.name)}Input`;
    out.push(
      ...wrap(`${operation.summary}.`, '    /// '),
      '    ///',
      ...wrap(operation.description, '    /// '),
    );
    out.push(
      `    pub fn ${operation.name}(&self, input: &${type}) -> Result<Value, Error> {`,
      `        self.call("${operation.id}", serde_json::to_value(input)?)`,
      '    }',
      '',
    );
  }
  out.push('}');
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

// ------------------------------------------------------------------------------------------ Java

function javaType(kind: Kind): string {
  switch (kind.type) {
    case 'string':
      return 'String';
    case 'integer':
      return 'long';
    case 'number':
      return 'double';
    case 'boolean':
      return 'boolean';
    case 'object':
      return 'Map<String, ?>';
    case 'array':
      return 'List<?>';
    default:
      return 'Object';
  }
}
/** A type that can hold null: the boxed one, for a required argument that may be null. */
const javaNullable = (type: string) =>
  ({ long: 'Long', double: 'Double', boolean: 'Boolean' })[type as 'long'] ?? type;
const javaDoc = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('@', '&#64;')
    .replaceAll('*/', '*&#47;');
const kindName = (kind: Kind): string =>
  kind.type === 'array'
    ? `list of ${kindName(kind.items)}`
    : kind.type === 'any'
      ? 'any JSON'
      : kind.type;

function javaOperations(operations: ClientOperation[]): string {
  const out: string[] = [
    ...HEADER.split('\n').map((line) => `// ${line}`),
    'package io.pylota.slotlock;',
    '',
    'import java.util.LinkedHashMap;',
    'import java.util.List;',
    'import java.util.Map;',
    'import java.util.Set;',
    '',
    '/** Every Slotlock REST operation as a method; {@link #call} runs one by name. */',
    'public abstract class SlotlockOperations {',
    '  /** Every operation, by name: its method, path, path parameters and query parameters. */',
    '  static final Map<String, Operation> OPERATIONS =',
    '      Map.ofEntries(',
  ];
  operations.forEach((operation, index) => {
    const list = (names: string[]) => `List.of(${names.map((name) => `"${name}"`).join(', ')})`;
    out.push(
      `          Map.entry("${operation.id}", new Operation("${operation.method}", "${operation.path}", ${list(
        operation.pathParams.map(({ name }) => name),
      )}, ${list(operation.query.map(({ name }) => name))}))${index === operations.length - 1 ? ');' : ','}`,
    );
  });
  out.push(
    '',
    '  /**',
    '   * Runs an operation by its name ({@code slotlock_…}) with its arguments, path parameters included.',
    '   *',
    '   * @return the response body',
    '   * @throws SlotlockException when the server refuses the call',
    '   */',
    '  public abstract Map<String, Object> call(String operation, Map<String, ?> values);',
    '',
    '  private static void putOptional(',
    '      Map<String, Object> values, Map<String, ?> optional, Set<String> names, String operation) {',
    '    if (optional == null) return;',
    '    for (Map.Entry<String, ?> entry : optional.entrySet()) {',
    '      if (!names.contains(entry.getKey())) {',
    '        throw new IllegalArgumentException(operation + " has no optional argument " + entry.getKey());',
    '      }',
    '      values.put(entry.getKey(), entry.getValue());',
    '    }',
    '  }',
    '',
  );
  for (const operation of operations) {
    const { path, required, optional } = argumentsOf(operation);
    const method = camel(operation.name);
    const params = [
      ...path.map((p) => `String ${camel(p.name)}`),
      ...required.map(
        (p) => `${p.nullable ? javaNullable(javaType(p.kind)) : javaType(p.kind)} ${camel(p.name)}`,
      ),
    ];
    const doc = [
      '  /**',
      ...wrap(`${javaDoc(operation.summary)}. ${javaDoc(operation.description)}`, '   * '),
    ];
    if (path.length + required.length + optional.length > 0) doc.push('   *');
    for (const p of [...path, ...required]) {
      doc.push(
        ...wrap(
          `@param ${camel(p.name)} ${javaDoc(p.description || p.name)}${p.nullable ? ' (may be null)' : ''}`,
          '   * ',
        ),
      );
    }
    if (optional.length > 0) {
      const names = optional.map(
        (p) => `{@code ${p.name}} (${kindName(p.kind)}${p.nullable ? ', null clears it' : ''})`,
      );
      doc.push(
        ...wrap(`@param optional the optional arguments, or null: ${names.join(', ')}`, '   * '),
      );
    }
    doc.push(
      '   * @return the response body',
      '   * @throws SlotlockException when the server refuses the call',
      '   */',
    );
    const withOptional = optional.length > 0 ? [...params, 'Map<String, ?> optional'] : params;
    out.push(...doc, `  public Map<String, Object> ${method}(${withOptional.join(', ')}) {`);
    out.push('    Map<String, Object> values = new LinkedHashMap<>();');
    for (const p of [...path, ...required])
      out.push(`    values.put("${p.name}", ${camel(p.name)});`);
    if (optional.length > 0) {
      out.push(
        `    putOptional(values, optional, Set.of(${optional.map((p) => `"${p.name}"`).join(', ')}), "${operation.id}");`,
      );
    }
    out.push(`    return call("${operation.id}", values);`, '  }', '');
    if (optional.length > 0) {
      out.push(
        `  /** {@link #${method}} without optional arguments. */`,
        `  public Map<String, Object> ${method}(${params.join(', ')}) {`,
        `    return ${method}(${[...params.map((param) => param.split(' ').pop()), 'null'].join(', ')});`,
        '  }',
        '',
      );
    }
  }
  out.push('}');
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

// -------------------------------------------------------------------------------------------- C#

function csharpType(kind: Kind): string {
  switch (kind.type) {
    case 'string':
      return 'string';
    case 'integer':
      return 'long';
    case 'number':
      return 'double';
    case 'boolean':
      return 'bool';
    case 'object':
      return 'JsonObject';
    case 'array':
      return kind.items.type === 'string' ? 'IEnumerable<string>' : 'JsonArray';
    default:
      return 'JsonNode';
  }
}
const CSHARP_KEYWORDS = new Set([
  'ref',
  'out',
  'in',
  'base',
  'event',
  'object',
  'string',
  'params',
  'lock',
  'operator',
]);
const csharpArg = (name: string) => {
  const value = camel(name);
  return CSHARP_KEYWORDS.has(value) ? `@${value}` : value;
};
const csharpDoc = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function csharpOperations(operations: ClientOperation[]): string {
  const out: string[] = [
    '// <auto-generated/>',
    ...HEADER.split('\n').map((line) => `// ${line}`),
    '#nullable enable',
    '',
    'using System.Collections.Generic;',
    'using System.Text.Json.Nodes;',
    'using System.Threading;',
    'using System.Threading.Tasks;',
    '',
    'namespace Slotlock;',
    '',
    'public sealed partial class SlotlockClient',
    '{',
    '    /// <summary>Every operation, by name: its method, path, path parameters and query parameters.</summary>',
    '    internal static readonly IReadOnlyDictionary<string, Operation> Operations = new Dictionary<string, Operation>',
    '    {',
  ];
  for (const operation of operations) {
    const list = (names: string[]) => `[${names.map((name) => `"${name}"`).join(', ')}]`;
    out.push(
      `        ["${operation.id}"] = new("${operation.method}", "${operation.path}", ${list(
        operation.pathParams.map(({ name }) => name),
      )}, ${list(operation.query.map(({ name }) => name))}),`,
    );
  }
  out.push('    };', '');
  for (const operation of operations) {
    const { path, required, optional } = argumentsOf(operation);
    const params = [
      ...path.map((p) => `string ${csharpArg(p.name)}`),
      ...required.map((p) => `${csharpType(p.kind)}${p.nullable ? '?' : ''} ${csharpArg(p.name)}`),
      ...optional.map(
        (p) =>
          `Optional<${csharpType(p.kind)}${p.nullable ? '?' : ''}> ${csharpArg(p.name)} = default`,
      ),
      'CancellationToken cancellationToken = default',
    ];
    out.push(`    /// <summary>${csharpDoc(operation.summary)}.</summary>`, '    /// <remarks>');
    out.push(...wrap(csharpDoc(operation.description), '    /// '));
    out.push('    /// </remarks>');
    for (const p of [...path, ...required, ...optional]) {
      const note = !p.required && p.nullable ? ' Null clears it; leave it out to keep it.' : '';
      out.push(
        ...wrap(
          `<param name="${camel(p.name)}">${csharpDoc(p.description || p.name)}${note}</param>`,
          '    /// ',
        ),
      );
    }
    out.push('    /// <param name="cancellationToken">Cancels the request.</param>');
    out.push('    /// <returns>The response body.</returns>');
    out.push(
      '    /// <exception cref="SlotlockException">The server refused the call.</exception>',
    );
    out.push(`    public Task<JsonObject> ${pascal(operation.name)}Async(`);
    params.forEach((param, index) =>
      out.push(`        ${param}${index === params.length - 1 ? ')' : ','}`),
    );
    out.push('    {', '        var values = new JsonObject();');
    for (const p of [...path, ...required])
      out.push(`        values["${p.name}"] = Json.ToNode(${csharpArg(p.name)});`);
    for (const p of optional) {
      out.push(
        `        if (${csharpArg(p.name)}.HasValue) values["${p.name}"] = Json.ToNode(${csharpArg(p.name)}.Value);`,
      );
    }
    out.push(
      `        return CallAsync("${operation.id}", values, cancellationToken);`,
      '    }',
      '',
    );
  }
  out.push('}');
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

/** Every generated client file, by its path from the repository root. */
export function generateClients(document: Schema): Map<string, string> {
  const operations = clientOperations(document);
  return new Map([
    ['clients/python/src/slotlock/_operations.py', pythonOperations(operations)],
    ['clients/go/operations.go', goOperations(operations)],
    ['clients/rust/src/operations.rs', rustOperations(operations)],
    [
      'clients/java/src/main/java/io/pylota/slotlock/SlotlockOperations.java',
      javaOperations(operations),
    ],
    ['clients/dotnet/src/Slotlock/SlotlockClient.Operations.g.cs', csharpOperations(operations)],
  ]);
}
