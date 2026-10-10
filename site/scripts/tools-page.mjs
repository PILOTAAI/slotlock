// Renders /docs/tools/ from the registry (scripts/tool-schemas.mjs) and the hand-written notes
// (scripts/tool-notes.mjs). Every table is Markdown, so the page's Markdown twin and llms-full.txt
// carry the same reference an agent reads.
import {
  COMMON_ERRORS,
  CONFIRMATION_ERRORS,
  DETAILS,
  INPUT_NOTES,
  OBJECTS,
  OUTPUT_NOTES,
  REFINEMENTS,
  SUMMARIES,
  TOOL_ERRORS,
} from './tool-notes.mjs';

const format = (n) => n.toLocaleString('en-GB');
/** A table cell: backslashes and pipes escaped (GFM requires it inside code spans too), no line breaks. */
const cell = (text) =>
  text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const code = (text) => `\`${text}\``;

/** GitHub's heading slug, as Starlight builds heading ids. */
const anchor = (text) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');

function objectInfo(ref, fail) {
  const info = OBJECTS[ref];
  if (!info) fail(`the schema uses ${ref}; name it in OBJECTS in scripts/tool-notes.mjs`);
  return info;
}

/**
 * The Type cell: one code span per alternative, joined by `|` outside the code, so a long union
 * wraps between alternatives and never inside `date-time`. Named objects link to their section.
 */
function typeCell(schema, fail) {
  const alternatives = typeAlternatives(schema, fail);
  if (schema.nullable) alternatives.push(code('null'));
  return alternatives.join(' | ');
}

function typeAlternatives(schema, fail) {
  if (schema.kind === 'object') {
    if (!schema.ref) return [code('object')];
    const { name } = objectInfo(schema.ref, fail);
    return [`[${code(name)}](#${anchor(name)})`];
  }
  if (schema.kind === 'array') {
    const items = schema.items;
    if (items.kind === 'object') {
      if (!items.ref) return [code('object[]')];
      const { name } = objectInfo(items.ref, fail);
      return [`[${code(`${name}[]`)}](#${anchor(name)})`];
    }
    const inner = scalarType(items);
    return [code(`${items.kind === 'enum' ? `(${inner})` : inner}[]`)];
  }
  if (schema.kind === 'enum') return schema.values.map((value) => code(JSON.stringify(value)));
  return [code(scalarType(schema))];
}

function scalarType(schema) {
  switch (schema.kind) {
    case 'string':
      return schema.format ?? 'string';
    case 'number':
      return schema.int ? 'integer' : 'number';
    case 'boolean':
      return 'boolean';
    case 'literal':
      return JSON.stringify(schema.value);
    case 'enum':
      return schema.values.map((value) => JSON.stringify(value)).join(' | ');
    default:
      throw new Error(`no scalar type for ${schema.kind}`);
  }
}

/** Bounds in words. Strings and numbers only for inputs; arrays both ways. */
function bounds(schema, role) {
  const { min, max } = schema;
  if (schema.kind === 'array') {
    if (min !== undefined && max !== undefined) return `${format(min)} to ${format(max)} items.`;
    if (max !== undefined) return `Up to ${format(max)} items.`;
    return '';
  }
  if (role !== 'input') return '';
  if (schema.kind === 'string' && !schema.format) {
    if (min !== undefined && max !== undefined)
      return `${format(min)} to ${format(max)} characters.`;
    if (max !== undefined) return `Up to ${format(max)} characters.`;
  }
  if (schema.kind === 'number') {
    if (min !== undefined && max !== undefined) return `${format(min)} to ${format(max)}.`;
    if (min !== undefined) return `At least ${format(min)}.`;
  }
  return '';
}

function refinementNotes(schema, facts, fail) {
  return (schema.refinements ?? []).map((text) => {
    const rule = REFINEMENTS.find((candidate) => candidate.matches(text));
    if (!rule) fail(`no sentence for the rule .refine(${text.slice(0, 60)}…) in tool-notes.mjs`);
    return rule.note(facts);
  });
}

/**
 * Field rows of an object schema. Unnamed nested objects are flattened as `parent[].child`;
 * named ones link to their section.
 */
function rows({ schema, role, notes, keys, prefix = '', used, fail }) {
  const out = [];
  for (const field of schema.fields) {
    const path = `${prefix}${field.name}`;
    const key = keys.find((candidate) => notes[candidate(path)] !== undefined)?.(path);
    if (key) used.add(key);
    const parts = [];
    if (role === 'input') parts.push(field.schema.optional ? 'Optional.' : 'Required.');
    if (key) parts.push(notes[key]);
    const limit = bounds(field.schema, role);
    if (limit) parts.push(limit);
    if (field.schema.default !== undefined) {
      parts.push(`Default ${code(JSON.stringify(field.schema.default))}.`);
    }
    out.push(
      `| ${code(path)} | ${cell(typeCell(field.schema, fail))} | ${cell(parts.join(' '))} |`,
    );
    const nested = field.schema.kind === 'array' ? field.schema.items : field.schema;
    if (nested.kind === 'object' && !nested.ref) {
      const childPrefix = field.schema.kind === 'array' ? `${path}[].` : `${path}.`;
      out.push(...rows({ schema: nested, role, notes, keys, prefix: childPrefix, used, fail }));
    }
  }
  return out;
}

const TABLE_HEAD = ['| Field | Type | Notes |', '| --- | --- | --- |'];

function collectRefs(schema, into) {
  if (schema.kind === 'object') {
    if (schema.ref && !into.has(schema.ref) && OBJECTS[schema.ref]) into.set(schema.ref, schema);
    for (const field of schema.fields) collectRefs(field.schema, into);
  } else if (schema.kind === 'array') {
    collectRefs(schema.items, into);
  }
}

function access(risk) {
  if (risk.readOnly) return 'Read-only';
  return risk.destructive ? 'Write, destructive' : 'Write';
}

export function renderToolsPage({ operations, facts, sources, fail }) {
  const names = operations.map((operation) => operation.name);
  for (const [label, map] of [
    ['SUMMARIES', SUMMARIES],
    ['DETAILS', DETAILS],
    ['TOOL_ERRORS', TOOL_ERRORS],
  ]) {
    for (const name of Object.keys(map)) {
      if (!names.includes(name))
        fail(`${label} in tool-notes.mjs names ${name}, which is not a tool`);
    }
  }
  for (const name of names) {
    if (!SUMMARIES[name]) fail(`${name} has no summary in tool-notes.mjs`);
    if (!TOOL_ERRORS[name]) fail(`${name} has no TOOL_ERRORS entry in tool-notes.mjs`);
  }
  // A documented code must be a code the server or the store can produce.
  const allCodes = [...COMMON_ERRORS, ...CONFIRMATION_ERRORS, ...Object.values(TOOL_ERRORS).flat()];
  for (const errorCode of new Set(allCodes)) {
    if (!sources.some((text) => text.includes(`'${errorCode}'`))) {
      fail(`error code ${errorCode} in tool-notes.mjs is not a code in src/`);
    }
  }

  const usedInput = new Set();
  const usedOutput = new Set();
  const objects = new Map();
  const inputKeys = (tool) => [(path) => `${tool}.${path}`, (path) => path];
  const outputKeys = inputKeys;

  const overview = [
    '| Tool | Access | What it does |',
    '| --- | --- | --- |',
    ...operations.map(
      (operation) =>
        `| [${code(operation.name)}](#${anchor(operation.name)}) | ${access(operation.risk)} | ${cell(SUMMARIES[operation.name])} |`,
    ),
  ].join('\n');

  const details = operations
    .map((operation) => {
      collectRefs(operation.input, objects);
      collectRefs(operation.output, objects);
      const riskWords = [access(operation.risk), operation.risk.idempotent ? 'idempotent' : '']
        .filter(Boolean)
        .join(', ');
      const errors = TOOL_ERRORS[operation.name];
      const writes = !operation.risk.readOnly;
      const errorLines = [
        errors.length > 0
          ? `Besides the [codes any tool can return](#error-codes): ${errors.map(code).join(', ')}.`
          : 'Only the [codes any tool can return](#error-codes).',
        ...(writes
          ? [
              `When the server asks a person to confirm this tool: ${CONFIRMATION_ERRORS.map(code).join(', ')} ([confirmation before writes](/docs/security/#confirmation-before-writes)).`,
            ]
          : []),
      ];
      const inputRules = refinementNotes(operation.input, facts, fail);
      return [
        `## ${code(operation.name)}`,
        SUMMARIES[operation.name],
        `${riskWords}. Listed in \`tools/list\` as **${operation.title}**, described to the model as “${operation.description}”`,
        ...(DETAILS[operation.name] ? [DETAILS[operation.name]] : []),
        '### Input',
        [
          ...TABLE_HEAD,
          ...rows({
            schema: operation.input,
            role: 'input',
            notes: INPUT_NOTES,
            keys: inputKeys(operation.name),
            used: usedInput,
            fail,
          }),
        ].join('\n'),
        ...(inputRules.length > 0 ? [inputRules.join(' ')] : []),
        '### Output',
        [
          ...TABLE_HEAD,
          ...rows({
            schema: operation.output,
            role: 'output',
            notes: OUTPUT_NOTES,
            keys: outputKeys(operation.name),
            used: usedOutput,
            fail,
          }),
        ].join('\n'),
        '### Errors',
        errorLines.join(' '),
        '### Example arguments',
        `\`\`\`json\n${JSON.stringify(operation.example, null, 2)}\n\`\`\``,
      ].join('\n\n');
    })
    .join('\n\n');

  // Nested named objects (an Event's attendees) are collected as their parents are rendered.
  const rendered = [];
  const queue = Object.keys(OBJECTS).filter((ref) => objects.has(ref));
  const seen = new Set();
  while (queue.length > 0) {
    const ref = queue.shift();
    if (seen.has(ref)) continue;
    seen.add(ref);
    const schema = objects.get(ref);
    const info = OBJECTS[ref];
    const nested = new Map();
    for (const field of schema.fields) collectRefs(field.schema, nested);
    for (const [child, childSchema] of nested) {
      if (!objects.has(child)) {
        objects.set(child, childSchema);
        queue.push(child);
      }
    }
    const notes = info.role === 'input' ? INPUT_NOTES : OUTPUT_NOTES;
    const used = info.role === 'input' ? usedInput : usedOutput;
    const rules = refinementNotes(schema, facts, fail);
    rendered.push(
      [
        `### ${info.name}`,
        [
          ...TABLE_HEAD,
          ...rows({
            schema,
            role: info.role,
            notes,
            keys: [(path) => `${ref}.${path}`],
            used,
            fail,
          }),
        ].join('\n'),
        ...(rules.length > 0 ? [rules.join(' ')] : []),
      ].join('\n\n'),
    );
  }
  for (const ref of Object.keys(OBJECTS)) {
    if (!seen.has(ref)) fail(`OBJECTS in tool-notes.mjs names ${ref}, which no tool uses`);
  }
  for (const [label, notes, used] of [
    ['INPUT_NOTES', INPUT_NOTES, usedInput],
    ['OUTPUT_NOTES', OUTPUT_NOTES, usedOutput],
  ]) {
    for (const key of Object.keys(notes)) {
      if (!used.has(key)) fail(`${label}.${key} in tool-notes.mjs matches no field; update it`);
    }
  }

  const common = COMMON_ERRORS.map(code);
  return {
    overview,
    details,
    objects: rendered.join('\n\n'),
    /** "`a`, `b` and `c`", for the Error codes section's first sentence. */
    commonErrors: `${common.slice(0, -1).join(', ')} and ${common.at(-1)}`,
  };
}
