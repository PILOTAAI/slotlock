// Reads the agent tools' Zod schemas and examples out of src/agent-server.ts as text, without
// running it: the site is its own npm project and has neither the package's dependencies nor its
// build. scripts/sync-content.mjs renders what this returns as /docs/tools/.
//
// It parses only the subset of TypeScript the registry uses: identifiers, numbers, strings, object
// and array literals, spreads, member calls and `*`. A `.refine(…)` keeps its source text and is
// not parsed. Anything else, and any Zod method this file does not know, fails the build, so a new
// construct in the registry is looked at rather than rendered wrong.

class Lexer {
  constructor(source, position) {
    this.source = source;
    this.position = position;
    this.buffer = null;
  }

  peek() {
    if (!this.buffer) this.buffer = this.read();
    return this.buffer;
  }

  next() {
    const token = this.peek();
    this.buffer = null;
    return token;
  }

  read() {
    const src = this.source;
    for (;;) {
      while (this.position < src.length && /\s/.test(src[this.position])) this.position += 1;
      if (src.startsWith('//', this.position)) {
        const end = src.indexOf('\n', this.position);
        this.position = end < 0 ? src.length : end;
        continue;
      }
      if (src.startsWith('/*', this.position)) {
        this.position = src.indexOf('*/', this.position) + 2;
        continue;
      }
      break;
    }
    const start = this.position;
    if (start >= src.length) return { t: 'eof', start };
    const c = src[start];
    if (c === "'" || c === '"') {
      let value = '';
      let i = start + 1;
      while (src[i] !== c) {
        if (i >= src.length) throw new Error('unterminated string');
        if (src[i] === '\\') {
          const escaped = src[i + 1];
          value += { n: '\n', t: '\t' }[escaped] ?? escaped;
          i += 2;
        } else {
          value += src[i];
          i += 1;
        }
      }
      this.position = i + 1;
      return { t: 'str', v: value, start };
    }
    const number = /^[0-9][0-9_]*(?:\.[0-9_]+)?/.exec(src.slice(start, start + 40));
    if (number) {
      this.position += number[0].length;
      return { t: 'num', v: Number(number[0].replace(/_/g, '')), start };
    }
    const identifier = /^[A-Za-z_$][\w$]*/.exec(src.slice(start, start + 200));
    if (identifier) {
      this.position += identifier[0].length;
      return { t: 'id', v: identifier[0], start };
    }
    for (const punctuation of ['...', '===', '!==', '=>', '>=', '<=', '&&', '||', '??']) {
      if (src.startsWith(punctuation, start)) {
        this.position += punctuation.length;
        return { t: 'p', v: punctuation, start };
      }
    }
    this.position += 1;
    return { t: 'p', v: c, start };
  }
}

function expect(lexer, value) {
  const token = lexer.next();
  if (token.v !== value) {
    throw new Error(`expected "${value}" but found "${token.v}" at ${token.start}`);
  }
  return token;
}

/** One expression of the subset; stops before `,`, `;`, `)`, `]` or `}` at its own depth. */
function parseExpression(lexer) {
  const terms = [parsePostfix(lexer)];
  while (lexer.peek().v === '*') {
    lexer.next();
    terms.push(parsePostfix(lexer));
  }
  return terms.length === 1 ? terms[0] : { type: 'mul', terms };
}

function parsePrimary(lexer) {
  const token = lexer.next();
  if (token.t === 'num') return { type: 'value', value: token.v };
  if (token.t === 'str') return { type: 'value', value: token.v };
  if (token.t === 'id') {
    if (token.v === 'true' || token.v === 'false')
      return { type: 'value', value: token.v === 'true' };
    if (token.v === 'null') return { type: 'value', value: null };
    return { type: 'id', name: token.v };
  }
  if (token.v === '{') {
    const entries = [];
    while (lexer.peek().v !== '}') {
      if (lexer.peek().v === '...') {
        lexer.next();
        entries.push({ spread: parseExpression(lexer) });
      } else {
        const key = lexer.next();
        if (key.t !== 'id' && key.t !== 'str') throw new Error(`bad object key at ${key.start}`);
        expect(lexer, ':');
        entries.push({ key: key.v, value: parseExpression(lexer) });
      }
      if (lexer.peek().v === ',') lexer.next();
    }
    expect(lexer, '}');
    return { type: 'object', entries };
  }
  if (token.v === '[') {
    const items = [];
    while (lexer.peek().v !== ']') {
      items.push(parseExpression(lexer));
      if (lexer.peek().v === ',') lexer.next();
    }
    expect(lexer, ']');
    return { type: 'array', items };
  }
  throw new Error(`unsupported syntax "${token.v}" at ${token.start}`);
}

function parsePostfix(lexer) {
  let node = parsePrimary(lexer);
  for (;;) {
    const token = lexer.peek();
    if (token.v === '.') {
      lexer.next();
      const name = lexer.next();
      if (name.t !== 'id') throw new Error(`expected a member name at ${name.start}`);
      node = { type: 'member', object: node, name: name.v };
    } else if (token.v === '(') {
      const open = lexer.next();
      if (node.type === 'member' && node.name === 'refine') {
        // Keep the predicate's source; it is a function, not data.
        let depth = 1;
        let close = open;
        while (depth > 0) {
          close = lexer.next();
          if (close.t === 'eof') throw new Error('unbalanced refine(…)');
          if (close.v === '(') depth += 1;
          if (close.v === ')') depth -= 1;
        }
        const text = lexer.source.slice(open.start + 1, close.start).trim();
        node = { type: 'call', callee: node, args: [], text };
      } else {
        const args = [];
        while (lexer.peek().v !== ')') {
          args.push(parseExpression(lexer));
          if (lexer.peek().v === ',') lexer.next();
        }
        expect(lexer, ')');
        node = { type: 'call', callee: node, args };
      }
    } else {
      return node;
    }
  }
}

/**
 * The parsed source: top-level `const` declarations resolve lazily by name, and `external` supplies
 * numbers that live in other files (the store's horizon and event limits).
 */
export function createSourceReader(source, external = {}) {
  const cache = new Map();
  function declaration(name) {
    if (cache.has(name)) return cache.get(name);
    const match = new RegExp(`^(?:export )?const ${name}(?:: [^=]+)? = `, 'm').exec(source);
    if (!match) throw new Error(`no top-level const ${name} in src/agent-server.ts`);
    const node = parseExpression(new Lexer(source, match.index + match[0].length));
    cache.set(name, node);
    return node;
  }

  function number(node) {
    if (node.type === 'value' && typeof node.value === 'number') return node.value;
    if (node.type === 'mul') return node.terms.map(number).reduce((a, b) => a * b, 1);
    if (node.type === 'id') {
      if (typeof external[node.name] === 'number') return external[node.name];
      return number(declaration(node.name));
    }
    throw new Error(`not a number: ${JSON.stringify(node).slice(0, 80)}`);
  }

  /** A JSON value: literals, arrays, objects with spreads, constants, and `[…].join(sep)`. */
  function value(node) {
    switch (node.type) {
      case 'value':
        return node.value;
      case 'id':
        return value(declaration(node.name));
      case 'mul':
        return number(node);
      case 'array':
        return node.items.map(value);
      case 'object': {
        const out = {};
        for (const entry of node.entries) {
          if (entry.spread) Object.assign(out, value(entry.spread));
          else out[entry.key] = value(entry.value);
        }
        return out;
      }
      case 'call':
        if (node.callee.type === 'member' && node.callee.name === 'join') {
          return value(node.callee.object).join(value(node.args[0]));
        }
        throw new Error(`cannot evaluate a call to ${node.callee.name}`);
      default:
        throw new Error(`cannot evaluate ${node.type}`);
    }
  }

  const BASE = new Set(['string', 'number', 'boolean', 'literal', 'enum', 'array', 'object']);

  /** A Zod expression as a plain description: kind, bounds, flags, fields, and the const it came from. */
  function schema(node) {
    if (node.type === 'id') {
      const described = schema(declaration(node.name));
      return described.kind === 'object' && !described.ref
        ? { ...described, ref: node.name }
        : described;
    }
    if (node.type !== 'call' || node.callee.type !== 'member') {
      throw new Error(`not a Zod schema: ${JSON.stringify(node).slice(0, 80)}`);
    }
    const { object, name } = node.callee;
    if (object.type === 'id' && object.name === 'z') {
      if (!BASE.has(name)) throw new Error(`unsupported Zod type z.${name}()`);
      switch (name) {
        case 'literal':
          return { kind: 'literal', value: value(node.args[0]) };
        case 'enum':
          return { kind: 'enum', values: value(node.args[0]) };
        case 'array':
          return { kind: 'array', items: schema(node.args[0]) };
        case 'object':
          return {
            kind: 'object',
            fields: node.args[0].entries.map((entry) => ({
              name: entry.key,
              schema: schema(entry.value),
            })),
          };
        default:
          return { kind: name };
      }
    }
    const inner = schema(object);
    switch (name) {
      case 'min':
        return { ...inner, min: number(node.args[0]) };
      case 'max':
        return { ...inner, max: number(node.args[0]) };
      case 'int':
        return { ...inner, int: true };
      case 'positive':
        return { ...inner, min: 1 };
      case 'nonnegative':
        return { ...inner, min: 0 };
      case 'optional':
        return { ...inner, optional: true };
      case 'nullable':
        return { ...inner, nullable: true };
      case 'default':
        return { ...inner, optional: true, default: value(node.args[0]) };
      case 'email':
        return { ...inner, format: 'email' };
      case 'datetime':
        return { ...inner, format: 'date-time' };
      case 'refine':
        return { ...inner, refinements: [...(inner.refinements ?? []), node.text] };
      case 'trim':
      case 'strict':
      case 'passthrough':
        return inner;
      default:
        throw new Error(`unsupported Zod method .${name}()`);
    }
  }

  return { declaration, number, value, schema };
}

/**
 * The operations in registry order: name, title, description, risk, input and output schemas, and
 * the example arguments the A2A agent card publishes.
 */
export function readOperations(source, external) {
  const reader = createSourceReader(source, external);
  const registry = reader.declaration('OPERATION_DEFINITIONS');
  if (registry.type !== 'array') throw new Error('OPERATION_DEFINITIONS is not an array literal');
  const operations = registry.items.map((item) => {
    const field = (key) => {
      const entry = item.entries.find((candidate) => candidate.key === key);
      if (!entry) throw new Error(`an operation has no ${key}`);
      return entry.value;
    };
    return {
      name: reader.value(field('name')),
      title: reader.value(field('title')),
      description: reader.value(field('description')),
      risk: reader.value(field('risk')),
      input: reader.schema(field('input')),
      output: reader.schema(field('output')),
      example: reader.value(field('example')),
    };
  });
  return { operations, reader };
}
