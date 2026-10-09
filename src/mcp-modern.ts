import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/*
 * MCP 2026-07-28 wire mechanics for the Slotlock agent server: the per-request `_meta` envelope, the
 * Streamable HTTP request headers, the sealed multi-round-trip `requestState`, SSE framing and W3C
 * trace context. Which method does what — authorization, dispatch, results — stays in
 * agent-server.ts, the orchestration owner.
 */

export const MCP_META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
const MCP_META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const MCP_META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';
export const MCP_META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';
export const MCP_META_SUBSCRIPTION_ID = 'io.modelcontextprotocol/subscriptionId';

/** Codes MCP 2026-07-28 allocates (basic §Error Codes). On Streamable HTTP each answers HTTP 400. */
const MCP_HEADER_MISMATCH = -32020;
export const MCP_MISSING_REQUIRED_CLIENT_CAPABILITY = -32021;
const MCP_UNSUPPORTED_PROTOCOL_VERSION = -32022;

/** Methods whose `Mcp-Name` header mirrors `params.name` (or `params.uri` for resources/read). */
const MCP_NAMED_METHODS: ReadonlyMap<string, 'name' | 'uri'> = new Map([
  ['tools/call', 'name'],
  ['prompts/get', 'name'],
  ['resources/read', 'uri'],
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// RFC 9110 field value: visible ASCII, space and horizontal tab. Anything else must arrive in the
// `=?base64?…?=` sentinel (Streamable HTTP §Value Encoding).
const PLAIN_HEADER_VALUE = /^[\x20-\x7E\t]*$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64_SENTINEL_PREFIX = '=?base64?';
const BASE64_SENTINEL_SUFFIX = '?=';

/**
 * The value an `Mcp-Name` (or `Mcp-Param-*`) header stands for, decoded from the Base64 sentinel when
 * used; `null` when it is malformed: bad Base64, invalid UTF-8, or raw characters outside the
 * header-safe set.
 */
function decodeMcpHeaderValue(value: string): string | null {
  if (
    value.length >= BASE64_SENTINEL_PREFIX.length + BASE64_SENTINEL_SUFFIX.length &&
    value.startsWith(BASE64_SENTINEL_PREFIX) &&
    value.endsWith(BASE64_SENTINEL_SUFFIX)
  ) {
    const encoded = value.slice(BASE64_SENTINEL_PREFIX.length, -BASE64_SENTINEL_SUFFIX.length);
    if (!BASE64.test(encoded)) return null;
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(encoded, 'base64'));
    } catch {
      return null;
    }
  }
  return PLAIN_HEADER_VALUE.test(value) ? value : null;
}

/** A 2026-07-28 request's validated `_meta` envelope. */
export interface ModernMcpEnvelope {
  meta: Record<string, unknown>;
  capabilities: Record<string, unknown>;
}

/** A JSON-RPC error a 2026-07-28 request is refused with before any method runs. */
export interface ModernMcpRefusal {
  status: 400;
  code: number;
  message: string;
  data?: Record<string, unknown>;
}

/**
 * Validate a 2026-07-28 request's `_meta` envelope and the HTTP headers that mirror its body, in the
 * specification's order: the required `_meta` fields (-32602, basic §_meta), `MCP-Protocol-Version`
 * against the body (-32020), a revision the server implements (-32022, basic/versioning), then
 * `Mcp-Method` and `Mcp-Name` against the body, the latter after Base64-sentinel decoding (-32020,
 * streamable-http §Server Validation). Every refusal is HTTP 400.
 */
export function checkModernMcpRequest(args: {
  headers: Headers;
  method: string;
  params: unknown;
  modernVersions: readonly string[];
  supportedVersions: readonly string[];
}): { ok: true; envelope: ModernMcpEnvelope } | ({ ok: false } & ModernMcpRefusal) {
  const invalid = (message: string) => ({ ok: false, status: 400, code: -32602, message }) as const;
  const mismatch = (message: string) =>
    ({ ok: false, status: 400, code: MCP_HEADER_MISMATCH, message }) as const;
  const meta = isRecord(args.params) && isRecord(args.params._meta) ? args.params._meta : null;
  const version = meta?.[MCP_META_PROTOCOL_VERSION];
  if (!meta || typeof version !== 'string') {
    return invalid(`Missing required _meta field ${MCP_META_PROTOCOL_VERSION}`);
  }
  if (args.headers.get('mcp-protocol-version') !== version) {
    return mismatch(
      `Header mismatch: MCP-Protocol-Version does not match ${MCP_META_PROTOCOL_VERSION}`,
    );
  }
  if (!args.modernVersions.includes(version)) {
    return {
      ok: false,
      status: 400,
      code: MCP_UNSUPPORTED_PROTOCOL_VERSION,
      message: 'Unsupported protocol version',
      data: { supported: [...args.supportedVersions], requested: version },
    };
  }
  const capabilities = meta[MCP_META_CLIENT_CAPABILITIES];
  if (!isRecord(capabilities)) {
    return invalid(`Missing required _meta field ${MCP_META_CLIENT_CAPABILITIES}`);
  }
  const clientInfo = meta[MCP_META_CLIENT_INFO];
  if (
    clientInfo !== undefined &&
    !(
      isRecord(clientInfo) &&
      typeof clientInfo.name === 'string' &&
      typeof clientInfo.version === 'string'
    )
  ) {
    return invalid(`Invalid _meta field ${MCP_META_CLIENT_INFO}`);
  }
  if (args.headers.get('mcp-method') !== args.method) {
    return mismatch('Header mismatch: Mcp-Method does not match method');
  }
  const nameField = MCP_NAMED_METHODS.get(args.method);
  if (nameField) {
    const header = args.headers.get('mcp-name');
    const decoded = header === null ? null : decodeMcpHeaderValue(header);
    const bodyValue = isRecord(args.params) ? args.params[nameField] : undefined;
    if (decoded === null || typeof bodyValue !== 'string' || decoded !== bodyValue) {
      return mismatch(`Header mismatch: Mcp-Name does not match params.${nameField}`);
    }
  }
  return { ok: true, envelope: { meta, capabilities } };
}

/** Deterministic JSON: object keys sorted at every depth, so equal values digest equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const STATE_VERSION = 'v1';
const STATE_MAC_CONTEXT = 'slotlock.mcp.request-state.v1';
const PRINCIPAL_TAG_CONTEXT = 'slotlock.mcp.principal.v1';
const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** Longest `requestState` accepted back from a client; a sealed Slotlock state is a few hundred bytes. */
const MAX_REQUEST_STATE_LENGTH = 2_048;
const MIN_STATE_SECRET_BYTES = 32;

/** Validate and copy the HMAC keys that seal `requestState`: 1-8 keys of at least 32 bytes each. */
export function stateSecrets(secrets: readonly (string | Uint8Array)[]): Buffer[] {
  if (secrets.length === 0 || secrets.length > 8) {
    throw new Error('Slotlock agent server confirmation.secrets must hold 1-8 keys');
  }
  return secrets.map((secret) => {
    const key = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : Buffer.from(secret);
    if (key.byteLength < MIN_STATE_SECRET_BYTES) {
      throw new Error(
        `Slotlock agent server confirmation.secrets keys must be at least ${MIN_STATE_SECRET_BYTES} bytes`,
      );
    }
    return key;
  });
}

/**
 * Seal a JSON payload for a client to carry and echo: `v1.<payload>.<HMAC-SHA256>`, both base64url.
 * It is integrity-protected, not encrypted, so it must never hold anything the client may not see.
 */
export function sealRequestState(key: Buffer, payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = createHmac('sha256', key).update(`${STATE_MAC_CONTEXT}.${body}`).digest('base64url');
  return `${STATE_VERSION}.${body}.${mac}`;
}

/**
 * The payload of a state this server sealed with any of `keys`, and the key that verified it; `null`
 * for anything else. The MAC is checked in constant time before the payload is parsed.
 */
export function openRequestState(
  keys: readonly Buffer[],
  state: unknown,
): { payload: Record<string, unknown>; key: Buffer } | null {
  if (typeof state !== 'string' || state.length > MAX_REQUEST_STATE_LENGTH) return null;
  const [version, body, mac, ...rest] = state.split('.');
  if (
    version !== STATE_VERSION ||
    rest.length > 0 ||
    !body ||
    !mac ||
    !BASE64URL.test(body) ||
    !BASE64URL.test(mac)
  ) {
    return null;
  }
  const given = Buffer.from(mac, 'base64url');
  for (const key of keys) {
    const expected = createHmac('sha256', key).update(`${STATE_MAC_CONTEXT}.${body}`).digest();
    if (given.length === expected.length && timingSafeEqual(given, expected)) {
      try {
        const payload: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        return isRecord(payload) ? { payload, key } : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** A keyed tag of the principal: binds sealed state to one identity without revealing it. */
export function principalTag(
  key: Buffer,
  principal: { subject: string; tenantRef: string },
): string {
  return createHmac('sha256', key)
    .update(`${PRINCIPAL_TAG_CONTEXT}\0${principal.subject}\0${principal.tenantRef}`)
    .digest('base64url');
}

const encoder = new TextEncoder();

/** One JSON-RPC message as an SSE `message` event, with no `id`: these streams are not resumable. */
function sseEvent(message: unknown): Uint8Array {
  return encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
}

/** An SSE comment line: keeps intermediaries from closing a quiet stream; clients ignore it. */
const SSE_KEEP_ALIVE = encoder.encode(':\n\n');

/** Messages a reader may leave unread before the stream counts it as gone. */
const MAX_UNREAD_EVENTS = 256;

/** A server-to-client SSE response stream of JSON-RPC messages. */
export interface McpEventStream {
  readonly response: Response;
  /** Queue one JSON-RPC message; `false` once the stream is closed. */
  send(message: unknown): boolean;
  /** Queue a keep-alive comment; `false` once the stream is closed. */
  keepAlive(): boolean;
  /** Whether the reader has left more than a bounded number of events unread. */
  lagging(): boolean;
  close(): void;
}

/**
 * An SSE response (streamable-http §Receiving Messages): never cached, not buffered by a reverse
 * proxy (`X-Accel-Buffering: no`). `onCancel` runs once when the reader goes away first — the client
 * closed the stream, which on HTTP is how it cancels the request.
 */
export function openMcpEventStream(onCancel: () => void): McpEventStream {
  let open = true;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(started) {
      controller = started;
    },
    cancel() {
      if (!open) return;
      open = false;
      onCancel();
    },
  });
  const enqueue = (chunk: Uint8Array): boolean => {
    if (!open || !controller) return false;
    try {
      controller.enqueue(chunk);
      return true;
    } catch {
      open = false;
      return false;
    }
  };
  return {
    response: new Response(stream, {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/event-stream',
        'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff',
      },
    }),
    send: (message) => enqueue(sseEvent(message)),
    keepAlive: () => enqueue(SSE_KEEP_ALIVE),
    // The default queuing strategy counts chunks, so a negative desired size is unread events.
    lagging: () => open && (controller?.desiredSize ?? 0) < -MAX_UNREAD_EVENTS,
    close() {
      if (!open) return;
      open = false;
      try {
        controller?.close();
      } catch {
        // Already errored or cancelled: nothing left to close.
      }
    },
  };
}

/** W3C Trace Context (and Baggage) a request carried, validated; handed to the backend as is. */
export interface SlotlockTraceContext {
  traceparent: string;
  tracestate?: string;
  baggage?: string;
}

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-[\x21-\x7E]*)?$/;
const PRINTABLE = /^[\x20-\x7E]*$/;

function validTraceparent(value: string): boolean {
  const match = TRACEPARENT.exec(value);
  if (!match) return false;
  const [, version, traceId, parentId, , future] = match;
  return (
    version !== 'ff' &&
    (version !== '00' || future === undefined) &&
    traceId !== '0'.repeat(32) &&
    parentId !== '0'.repeat(16)
  );
}

/**
 * Trace context from the request's `_meta` (MCP reserves `traceparent`, `tracestate` and `baggage`
 * there) or, when `_meta` has none, from the HTTP headers of the same names. One source only, never
 * a mix; an invalid `traceparent` discards the context, and an invalid `tracestate` or `baggage` is
 * dropped on its own (W3C Trace Context §3.3, Baggage §3.3).
 */
export function traceContextFrom(
  meta: Record<string, unknown> | undefined,
  headers: Headers,
): SlotlockTraceContext | undefined {
  const fromMeta = typeof meta?.traceparent === 'string';
  const read = (key: 'traceparent' | 'tracestate' | 'baggage'): string | undefined => {
    const value = fromMeta ? meta?.[key] : headers.get(key);
    return typeof value === 'string' ? value.trim() : undefined;
  };
  const traceparent = read('traceparent');
  if (traceparent === undefined || !validTraceparent(traceparent)) return undefined;
  const context: SlotlockTraceContext = { traceparent };
  const tracestate = read('tracestate');
  if (
    tracestate !== undefined &&
    tracestate.length <= 512 &&
    PRINTABLE.test(tracestate) &&
    tracestate.split(',').length <= 32
  ) {
    context.tracestate = tracestate;
  }
  const baggage = read('baggage');
  if (
    baggage !== undefined &&
    baggage.length <= 8_192 &&
    PRINTABLE.test(baggage) &&
    baggage.split(',').length <= 180
  ) {
    context.baggage = baggage;
  }
  return context;
}
