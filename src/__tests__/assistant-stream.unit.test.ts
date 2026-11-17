// The dashboard assistant's streamed model calls. Each provider's stream is written as its docs show
// one (Anthropic "Streaming messages" and Chat Completions chunk objects, read 2026-11-10), then cut
// into hostile pieces: every byte, the middle of `data:`, the middle of a UTF-8 character, and
// between CR and LF. The last suite streams over a real HTTP connection on loopback.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type SlotlockAssistantModel,
  type SlotlockAssistantTurnEvent,
  callSlotlockAssistantModel,
  runSlotlockAssistantTurn,
  testSlotlockAssistantModel,
} from '../assistant.js';
import { fakeModelBody } from './helpers/fake-model.js';

type Provider = SlotlockAssistantModel['provider'];
type ModelRequest = Parameters<typeof callSlotlockAssistantModel>[0];

const encoder = new TextEncoder();

/** One SSE event: its `event:` name (none for Chat Completions) and its data, JSON unless a string. */
type Sse = [name: string | null, data: unknown];

function sseText(events: readonly Sse[], eol = '\n'): string {
  return events
    .map(([name, data]) => {
      const line = `data: ${typeof data === 'string' ? data : JSON.stringify(data)}${eol}`;
      return `${name === null ? '' : `event: ${name}${eol}`}${line}${eol}`;
    })
    .join('');
}

interface Answer {
  /** Text, in the fragments it streams as. */
  text?: string[];
  /** Tool calls, their arguments in the fragments they stream as. */
  calls?: { id?: string; name: string; json: string[] }[];
}

/** An Anthropic stream, as "Streaming messages" shows one: blocks between start and stop, then message_stop. */
function anthropicEvents(answer: Answer): Sse[] {
  const events: Sse[] = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_1nZdL29xx5MUA1yADyHTEsnR8uuvGzszyY',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'your-model',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 25, output_tokens: 1 },
        },
      },
    ],
  ];
  let index = 0;
  if (answer.text) {
    events.push([
      'content_block_start',
      { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
    ]);
    events.push(['ping', { type: 'ping' }]);
    for (const text of answer.text) {
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text } }]);
    }
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
    index += 1;
  }
  for (const [position, call] of (answer.calls ?? []).entries()) {
    events.push([
      'content_block_start',
      {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: call.id ?? `toolu_0${position}`, name: call.name, input: {} },
      },
    ]);
    for (const partial_json of ['', ...call.json]) {
      events.push([
        'content_block_delta',
        { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } },
      ]);
    }
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
    index += 1;
  }
  events.push([
    'message_delta',
    {
      type: 'message_delta',
      delta: { stop_reason: answer.calls?.length ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { output_tokens: 15 },
    },
  ]);
  events.push(['message_stop', { type: 'message_stop' }]);
  return events;
}

/** A Chat Completions chunk object. */
function chunk(delta: Record<string, unknown>, finish: string | null = null, choices = true): Record<string, unknown> {
  return {
    id: 'chatcmpl-123',
    object: 'chat.completion.chunk',
    created: 1694268190,
    model: 'your-model',
    system_fingerprint: 'fp_44709d6fcb',
    choices: choices ? [{ index: 0, delta, logprobs: null, finish_reason: finish }] : [],
  };
}

/** A Chat Completions stream: a role chunk, content, each call's fragments by index, finish_reason, [DONE]. */
function openaiEvents(answer: Answer): Sse[] {
  const events: Sse[] = [[null, chunk({ role: 'assistant', content: '' })]];
  for (const content of answer.text ?? []) events.push([null, chunk({ content })]);
  for (const [index, call] of (answer.calls ?? []).entries()) {
    // The id, type and name in the first fragment only, as the chunk object's tool_calls allow.
    events.push([
      null,
      chunk({
        tool_calls: [
          {
            index,
            ...(call.id === '' ? {} : { id: call.id ?? `call_0${index}` }),
            type: 'function',
            function: { name: call.name, arguments: '' },
          },
        ],
      }),
    ]);
    for (const fragment of call.json) {
      events.push([null, chunk({ tool_calls: [{ index, function: { arguments: fragment } }] })]);
    }
  }
  events.push([null, chunk({}, answer.calls?.length ? 'tool_calls' : 'stop')]);
  events.push([null, '[DONE]']);
  return events;
}

const streamOf = (provider: Provider, answer: Answer, eol = '\n') =>
  sseText(provider === 'anthropic' ? anthropicEvents(answer) : openaiEvents(answer), eol);

/** Bytes cut before each index the predicate names. */
const cutWhere =
  (cut: (bytes: Uint8Array, index: number) => boolean) =>
  (bytes: Uint8Array): Uint8Array[] => {
    const pieces: Uint8Array[] = [];
    let start = 0;
    for (let index = 1; index < bytes.length; index += 1) {
      if (cut(bytes, index)) {
        pieces.push(bytes.slice(start, index));
        start = index;
      }
    }
    pieces.push(bytes.slice(start));
    return pieces;
  };

const isData = (bytes: Uint8Array, index: number) =>
  String.fromCharCode(...bytes.slice(index, index + 5)) === 'data:';

/** The ways a stream arrives: whole, and cut where a naive reader breaks. */
const SPLITS: [string, (bytes: Uint8Array) => Uint8Array[]][] = [
  ['whole', (bytes) => [bytes]],
  ['every byte', cutWhere(() => true)],
  // `da` | `ta: {...`
  ['mid-data:', cutWhere((bytes, index) => index >= 2 && isData(bytes, index - 2))],
  // After each lead byte of a multibyte character, and again before its last byte.
  [
    'mid-UTF-8',
    cutWhere(
      (bytes, index) =>
        ((bytes[index - 1] as number) & 0xc0) === 0xc0 ||
        (((bytes[index] as number) & 0xc0) === 0x80 && ((bytes[index + 1] as number) & 0xc0) !== 0x80),
    ),
  ],
  // `\r` | `\n`: one line ending, not two.
  ['between CR and LF', cutWhere((bytes, index) => bytes[index - 1] === 0x0d)],
];

function bodyOf(
  pieces: readonly Uint8Array[],
  signal?: AbortSignal | null,
  stallAfter?: number,
): ReadableStream<Uint8Array> {
  let next = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (stallAfter !== undefined && next >= stallAfter) {
        // A connection that stays open: only an abort ends it, as undici errors the body.
        return new Promise<void>((resolve) => {
          const fail = () => {
            controller.error(new DOMException('This operation was aborted', 'AbortError'));
            resolve();
          };
          if (signal?.aborted) fail();
          else signal?.addEventListener('abort', fail, { once: true });
        });
      }
      const piece = pieces[next];
      next += 1;
      if (piece === undefined) controller.close();
      else controller.enqueue(piece);
      return undefined;
    },
  });
}

interface Sent {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
  raw: string;
}

/** A `fetch` that answers each call with the next response, recording what was sent. */
function fakeFetch(...answers: ((init: RequestInit) => Response)[]) {
  const sent: Sent[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const raw = String(init.body);
    sent.push({ url: String(input), headers: new Headers(init.headers), body: JSON.parse(raw), raw });
    const answer = answers.length > 1 ? answers.shift() : answers[0];
    if (!answer) throw new Error('no answer scripted');
    return answer(init);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, sent, mock: fetch };
}

const SSE_HEADERS = { 'content-type': 'text/event-stream; charset=utf-8' };

const sse =
  (text: string, split: (bytes: Uint8Array) => Uint8Array[] = (bytes) => [bytes], stallAfter?: number) =>
  (init: RequestInit) =>
    new Response(bodyOf(split(encoder.encode(text)), init.signal, stallAfter), { headers: SSE_HEADERS });

const MODELS: Record<Provider, SlotlockAssistantModel> = {
  anthropic: {
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'your-model',
    apiKey: 'sk-ant-test',
  },
  openai: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'your-model', apiKey: 'sk-test' },
};

function request(provider: Provider, fetch: typeof globalThis.fetch, extra: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: MODELS[provider],
    system: 'Be brief.',
    entries: [{ role: 'user', text: 'What can we book?' }],
    tools: [{ name: 'slotlock_list_resources', description: 'List resources.', inputSchema: { type: 'object' } }],
    fetch,
    signal: AbortSignal.timeout(5_000),
    ...extra,
  };
}

const TEXT = ['Grüße aus ', '東京', ' 🚗 — ', 'one vehicle.'];
const CALL = { name: 'slotlock_list_resources', json: ['{"lim', 'it": 2', ', "note": "caf', 'é 🚗"}'] };

describe.each(['anthropic', 'openai'] as const)('a streamed model call over %s', (provider) => {
  it.each(SPLITS)('calls onText with each text delta in order, cut %s', async (_name, split) => {
    const { fetch, sent } = fakeFetch(sse(streamOf(provider, { text: TEXT }, '\r\n'), split));
    const deltas: string[] = [];
    const turn = await callSlotlockAssistantModel(request(provider, fetch, { onText: (delta) => deltas.push(delta) }));
    expect(deltas).toEqual(TEXT);
    expect(turn).toEqual({ text: TEXT.join(''), calls: [] });
    // It asked for a stream.
    expect(sent[0]?.body.stream).toBe(true);
    expect(sent[0]?.headers.get('accept')).toBe('text/event-stream');
  });

  it.each(SPLITS)('assembles a tool call from argument fragments, cut %s', async (_name, split) => {
    const { fetch } = fakeFetch(sse(streamOf(provider, { text: ['Checking.'], calls: [CALL] }), split));
    const deltas: string[] = [];
    const turn = await callSlotlockAssistantModel(request(provider, fetch, { onText: (delta) => deltas.push(delta) }));
    expect(turn).toEqual({
      text: 'Checking.',
      calls: [
        {
          id: provider === 'anthropic' ? 'toolu_00' : 'call_00',
          name: 'slotlock_list_resources',
          input: { limit: 2, note: 'café 🚗' },
        },
      ],
    });
    expect(deltas.join('')).toBe('Checking.');
  });

  it('answers a call with no argument fragments with {}, and one whose arguments do not parse with null', async () => {
    const { fetch } = fakeFetch(
      sse(
        streamOf(provider, {
          calls: [
            { id: 'a1', name: 'slotlock_list_resources', json: [] },
            { id: 'b2', name: 'slotlock_list_events', json: ['{"resource_id": '] },
          ],
        }),
      ),
    );
    const turn = await callSlotlockAssistantModel(request(provider, fetch, { onText: () => undefined }));
    expect(turn.calls).toEqual([
      { id: 'a1', name: 'slotlock_list_resources', input: {} },
      { id: 'b2', name: 'slotlock_list_events', input: null },
    ]);
  });

  it('reads a JSON answer to a stream request as today, and emits its text once', async () => {
    const json = fakeModelBody(provider, {
      text: 'Hello from a server that ignores stream.',
      calls: [{ name: 'slotlock_list_resources', input: { limit: 1 } }],
    });
    const { fetch, sent } = fakeFetch(() => Response.json(json));
    const deltas: string[] = [];
    const turn = await callSlotlockAssistantModel(request(provider, fetch, { onText: (delta) => deltas.push(delta) }));
    expect(sent[0]?.body.stream).toBe(true);
    expect(deltas).toEqual(['Hello from a server that ignores stream.']);
    expect(turn.text).toBe('Hello from a server that ignores stream.');
    expect(turn.calls).toHaveLength(1);
    expect(turn.calls[0]).toMatchObject({ name: 'slotlock_list_resources', input: { limit: 1 } });
  });

  it('is a bad answer when the stream ends without its terminal event', async () => {
    const events = provider === 'anthropic' ? anthropicEvents({ text: ['Half'] }) : openaiEvents({ text: ['Half'] });
    // Anthropic without message_stop; Chat Completions without finish_reason or [DONE].
    const cut = events.slice(0, provider === 'anthropic' ? -1 : -2);
    const deltas: string[] = [];
    const { fetch } = fakeFetch(sse(sseText(cut)));
    await expect(
      callSlotlockAssistantModel(request(provider, fetch, { onText: (delta) => deltas.push(delta) })),
    ).rejects.toMatchObject({ name: 'SlotlockAssistantProviderError', reason: 'bad_answer' });
    expect(deltas).toEqual(['Half']);
    // The event that completes it, without the blank line that ends it, is not an event (WHATWG:
    // discarded at EOF). For Chat Completions that is the finish_reason chunk, [DONE] never sent.
    const unended = sseText(provider === 'anthropic' ? events : events.slice(0, -1)).replace(/\n\n$/, '\n');
    await expect(
      callSlotlockAssistantModel(request(provider, fakeFeed(unended), { onText: () => undefined })),
    ).rejects.toMatchObject({ reason: 'bad_answer' });
  });

  it('is a bad answer past the response byte bound', async () => {
    const big = Array.from({ length: 1_100 }, () => 'x'.repeat(1_000));
    const { fetch } = fakeFetch(sse(streamOf(provider, { text: big }), (bytes) => {
      const pieces: Uint8Array[] = [];
      for (let start = 0; start < bytes.length; start += 16_384) pieces.push(bytes.slice(start, start + 16_384));
      return pieces;
    }));
    const deltas: string[] = [];
    await expect(
      callSlotlockAssistantModel(request(provider, fetch, { onText: (delta) => deltas.push(delta) })),
    ).rejects.toMatchObject({ reason: 'bad_answer' });
    // What streamed before stays within the text bound.
    expect(deltas.join('').length).toBe(8_000);
  });

  it('keeps the streamed text within the text bound, as the answer is', async () => {
    const long = Array.from({ length: 20 }, (_, index) => String.fromCharCode(97 + index).repeat(1_000));
    const { fetch } = fakeFetch(sse(streamOf(provider, { text: long })));
    const deltas: string[] = [];
    const turn = await callSlotlockAssistantModel(request(provider, fetch, { onText: (delta) => deltas.push(delta) }));
    expect(turn.text).toBe(long.join('').slice(0, 8_000));
    expect(deltas.join('')).toBe(turn.text);
  });

  it('is a timeout when the call is aborted mid-stream', async () => {
    const controller = new AbortController();
    const answer = { text: ['One', 'Two'] };
    const events = provider === 'anthropic' ? anthropicEvents(answer) : openaiEvents(answer);
    const pieces = events.map((event) => encoder.encode(sseText([event])));
    // The connection stalls after "One" until it is aborted.
    const firstText = provider === 'anthropic' ? 4 : 2;
    const { fetch } = fakeFetch(
      (init) => new Response(bodyOf(pieces, init.signal, firstText), { headers: SSE_HEADERS }),
    );
    const deltas: string[] = [];
    const call = callSlotlockAssistantModel(
      request(provider, fetch, {
        signal: controller.signal,
        onText: (delta) => {
          deltas.push(delta);
          controller.abort();
        },
      }),
    );
    await expect(call).rejects.toMatchObject({ reason: 'timeout' });
    expect(deltas).toEqual(['One']);
  });

  it('stops at once when aborted, even with the whole stream in hand and a body that ignores the abort', async () => {
    const controller = new AbortController();
    const text = streamOf(provider, { text: ['One', 'Two', 'Three'], calls: [CALL] });
    const fetch = (async () =>
      new Response(bodyOf([encoder.encode(text)], null, 1), {
        headers: SSE_HEADERS,
      })) as unknown as typeof globalThis.fetch;
    const deltas: string[] = [];
    await expect(
      callSlotlockAssistantModel(
        request(provider, fetch, {
          signal: controller.signal,
          onText: (delta) => {
            deltas.push(delta);
            controller.abort();
          },
        }),
      ),
    ).rejects.toMatchObject({ reason: 'timeout' });
    expect(deltas).toEqual(['One']);
  });

  it('without onText, asks for and reads one JSON answer as before', async () => {
    const json = fakeModelBody(provider, { text: 'Plain.' });
    const { fetch, sent } = fakeFetch(() => Response.json(json));
    const turn = await callSlotlockAssistantModel(request(provider, fetch));
    expect(turn).toEqual({ text: 'Plain.', calls: [] });
    expect(sent[0]?.body).not.toHaveProperty('stream');
    expect(sent[0]?.headers.get('accept')).toBe('application/json');
    // The connection test never streams.
    const tested = fakeFetch(() =>
      Response.json(fakeModelBody(provider, { calls: [{ name: 'slotlock_list_resources', input: {} }] })),
    );
    const passed = await testSlotlockAssistantModel({ model: MODELS[provider], fetch: tested.fetch, timeoutMs: 5_000 });
    expect(passed).toBe(true);
    expect(tested.sent[0]?.body).not.toHaveProperty('stream');
    expect(tested.sent[0]?.headers.get('accept')).toBe('application/json');
  });
});

/** A fetch answering every call with this SSE text. */
function fakeFeed(text: string): typeof globalThis.fetch {
  return fakeFetch(sse(text)).fetch;
}

describe('the Anthropic stream', () => {
  it.each(SPLITS)(
    'skips comments, ping, id, retry and unknown events; joins data lines; drops a BOM; any line end; cut %s',
    async (_name, split) => {
      const text = [
        '\uFEFF: a comment\r',
        'retry: 3000\n',
        'id: 7\r\n',
        sseText(anthropicEvents({ text: ['Hi'] }).slice(0, 2), '\r'),
        'event: a_new_event_type\ndata: {"type": "a_new_event_type", "detail": 1}\n\n',
        // One event over two data lines, each ended by CRLF: read as two line ends, it is two events.
        'event: content_block_delta\r\n',
        'data: {"type": "content_block_delta",\r\n',
        'data: "index": 0, "delta": {"type": "text_delta", "text": " there"}}\r\n',
        ':\r\n',
        '\r\n',
        sseText(anthropicEvents({ text: ['Hi'] }).slice(3)),
      ].join('');
      const deltas: string[] = [];
      const turn = await callSlotlockAssistantModel(
        request('anthropic', fakeFetch(sse(text, split)).fetch, { onText: (delta) => deltas.push(delta) }),
      );
      expect(deltas).toEqual([' there', 'Hi']);
      expect(turn.text).toBe(' thereHi');
    },
  );

  it.each([
    ['overloaded_error', 'unavailable'],
    ['rate_limit_error', 'rate_limited'],
    ['authentication_error', 'refused_key'],
    ['timeout_error', 'timeout'],
    ['api_error', 'unavailable'],
    ['a_new_error_type', 'unavailable'],
  ])('maps an error event of type %s to %s', async (type, reason) => {
    const events = anthropicEvents({ text: ['Partly'] });
    const text = sseText([
      ...events.slice(0, 4),
      ['error', { type: 'error', error: { type, message: 'Overloaded sk-ant-test' } }],
      ...events.slice(4),
    ]);
    const call = callSlotlockAssistantModel(request('anthropic', fakeFeed(text), { onText: () => undefined }));
    await expect(call).rejects.toMatchObject({ name: 'SlotlockAssistantProviderError', reason });
    await expect(call).rejects.not.toHaveProperty('message', expect.stringContaining('sk-ant-test'));
  });

  it('maps an error event whose data is not JSON to unavailable', async () => {
    const text = `${sseText(anthropicEvents({}).slice(0, 1))}event: error\r\ndata: upstream went away\r\n\r\n`;
    await expect(
      callSlotlockAssistantModel(request('anthropic', fakeFeed(text), { onText: () => undefined })),
    ).rejects.toMatchObject({ reason: 'unavailable' });
  });
});

describe('the Chat Completions stream', () => {
  it('assembles tool calls by index across interleaved chunks, id and name in the first fragment only', async () => {
    const tool = (index: number, rest: Record<string, unknown>) => chunk({ tool_calls: [{ index, ...rest }] });
    const text = sseText([
      [null, chunk({ role: 'assistant', content: null })],
      [null, tool(0, { id: 'call_a', type: 'function', function: { name: 'slotlock_list_resources', arguments: '' } })],
      [null, tool(1, { type: 'function', function: { name: 'slotlock_list_events', arguments: '{"resource' } })],
      [null, tool(0, { function: { arguments: '{"limit"' } })],
      [null, tool(1, { function: { arguments: '_id": "r1"}' } })],
      [null, tool(0, { function: { arguments: ': 3}' } })],
      [null, chunk({}, 'tool_calls')],
      // The usage chunk stream_options adds: choices empty.
      [null, { ...chunk({}, null, false), usage: { prompt_tokens: 9, completion_tokens: 12, total_tokens: 21 } }],
      [null, '[DONE]'],
    ]);
    const turn = await callSlotlockAssistantModel(request('openai', fakeFeed(text), { onText: () => undefined }));
    expect(turn).toEqual({
      text: '',
      calls: [
        { id: 'call_a', name: 'slotlock_list_resources', input: { limit: 3 } },
        // No id from the server: one is made from its index, as readOpenai does.
        { id: 'call_1', name: 'slotlock_list_events', input: { resource_id: 'r1' } },
      ],
    });
  });

  it('is complete at finish_reason without [DONE], and stops reading at [DONE]', async () => {
    const finished = sseText(openaiEvents({ text: ['Done'] }).slice(0, -1));
    expect(
      await callSlotlockAssistantModel(request('openai', fakeFeed(finished), { onText: () => undefined })),
    ).toEqual({ text: 'Done', calls: [] });
    // Anything after [DONE] is not read.
    const late = 'data: {"choices": [{"index": 0, "delta": {"content": "late"}}]}\n\n';
    const after = `${sseText(openaiEvents({ text: ['Done'] }))}${late}`;
    expect(
      await callSlotlockAssistantModel(request('openai', fakeFeed(after), { onText: () => undefined })),
    ).toEqual({ text: 'Done', calls: [] });
  });

  it('maps an error object in the stream to unavailable', async () => {
    const text = sseText([
      [null, chunk({ content: 'Par' })],
      [null, { error: { message: 'The server had an error', type: 'server_error' } }],
    ]);
    await expect(
      callSlotlockAssistantModel(request('openai', fakeFeed(text), { onText: () => undefined })),
    ).rejects.toMatchObject({ reason: 'unavailable' });
  });
});

const TOOLS_READ = 'slotlock_list_resources';
const TOOLS_WRITE = 'slotlock_create_event';

function turnOptions(
  provider: Provider,
  fetch: typeof globalThis.fetch,
  extra: Partial<Parameters<typeof runSlotlockAssistantTurn>[0]> = {},
): Parameters<typeof runSlotlockAssistantTurn>[0] {
  return {
    model: MODELS[provider],
    system: 'Be brief.',
    entries: [{ role: 'user', text: 'What can we book?' }],
    fetch,
    timeoutMs: 5_000,
    turnTimeoutMs: 10_000,
    read: async () => ({ ok: true, data: { resources: [] } }),
    propose: async () => ({ ok: true, actionId: 'action-1' }),
    ...extra,
  };
}

describe.each(['anthropic', 'openai'] as const)('a streamed turn over %s', (provider) => {
  it('announces each text delta, then each call before it runs and its result after, in order', async () => {
    const log: unknown[] = [];
    const { fetch } = fakeFetch(
      sse(
        streamOf(provider, {
          text: ['Let me ', 'check.'],
          calls: [
            // Not an id the loop keeps: it is given call_0_0.
            { id: 'bad id!', name: TOOLS_READ, json: ['{}'] },
            { id: 'u2', name: 'slotlock_erase_everything', json: ['{}'] },
            { id: 'w3', name: TOOLS_WRITE, json: ['{"title": "Ana"}'] },
          ],
        }),
        cutWhere(() => true),
      ),
      sse(streamOf(provider, { text: ['One ', 'resource.'] })),
    );
    const result = await runSlotlockAssistantTurn(
      turnOptions(provider, fetch, {
        onEvent: (event) => log.push(event),
        read: async (operation) => {
          log.push(`read ${operation}`);
          return { ok: true, data: { resources: [] } };
        },
        propose: async (operation) => {
          log.push(`propose ${operation}`);
          return { ok: true, actionId: 'action-1' };
        },
      }),
    );
    const texts = (from: number, to: number) =>
      (log.slice(from, to) as SlotlockAssistantTurnEvent[])
        .map((event) => (event.type === 'text' ? event.delta : '?'))
        .join('');
    const isA = (type: string) => (entry: unknown) => (entry as SlotlockAssistantTurnEvent).type === type;
    const firstCall = log.findIndex(isA('call'));
    expect(texts(0, firstCall)).toBe('Let me check.');
    const lastResult = log.length - 1 - [...log].reverse().findIndex(isA('result'));
    expect(log.slice(firstCall, lastResult + 1)).toEqual([
      { type: 'call', id: 'call_0_0', name: TOOLS_READ, use: 'read' },
      `read ${TOOLS_READ}`,
      { type: 'result', id: 'call_0_0', name: TOOLS_READ, ok: true },
      { type: 'call', id: 'u2', name: 'slotlock_erase_everything', use: 'unknown' },
      { type: 'result', id: 'u2', name: 'slotlock_erase_everything', ok: false },
      { type: 'call', id: 'w3', name: TOOLS_WRITE, use: 'write' },
      `propose ${TOOLS_WRITE}`,
      { type: 'result', id: 'w3', name: TOOLS_WRITE, ok: true, actionId: 'action-1' },
    ]);
    expect(texts(lastResult + 1, log.length)).toBe('One resource.');
    // The same entries a turn without events adds.
    expect(result.failure).toBeUndefined();
    expect(result.added.map((entry) => entry.role)).toEqual(['assistant', 'tool', 'assistant']);
    expect(result.added[0]).toMatchObject({
      text: 'Let me check.',
      calls: [{ id: 'call_0_0' }, { id: 'u2' }, { id: 'w3' }],
    });
    expect(result.added[1]).toMatchObject({
      results: [
        { id: 'call_0_0', error: false },
        { id: 'u2', error: true, content: JSON.stringify({ error: { code: 'tool_not_available' } }) },
        { id: 'w3', error: false, action: 'action-1' },
      ],
    });
    expect(result.added[2]).toEqual({ role: 'assistant', text: 'One resource.', calls: [] });
  });
});

describe('Stop (the member aborts the turn)', () => {
  it('aborts the model call mid-stream and keeps what streamed, with no call and a note', async () => {
    const stop = new AbortController();
    const events: SlotlockAssistantTurnEvent[] = [];
    const read = vi.fn(async () => ({ ok: true as const, data: {} }));
    const { fetch, mock } = fakeFetch(
      sse(streamOf('anthropic', { text: ['Let me ', 'check.'], calls: [CALL] }), cutWhere(() => true)),
    );
    const result = await runSlotlockAssistantTurn(
      turnOptions('anthropic', fetch, {
        signal: stop.signal,
        read,
        onEvent: (event) => {
          events.push(event);
          if (event.type === 'text') stop.abort();
        },
      }),
    );
    expect(events).toEqual([{ type: 'text', delta: 'Let me ' }]);
    expect(result).toEqual({
      added: [
        { role: 'assistant', text: 'Let me ', calls: [] },
        { role: 'note', text: 'Stopped.' },
      ],
    });
    expect(read).not.toHaveBeenCalled();
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('runs no further tool once stopped, answers the calls left as stopped, and calls the model no more', async () => {
    const stop = new AbortController();
    const events: SlotlockAssistantTurnEvent[] = [];
    const read = vi.fn(async () => {
      stop.abort();
      return { ok: true as const, data: { resources: [] } };
    });
    const { fetch, mock } = fakeFetch(
      sse(
        streamOf('anthropic', {
          calls: [
            { id: 'r1', name: TOOLS_READ, json: ['{}'] },
            { id: 'r2', name: TOOLS_READ, json: ['{}'] },
          ],
        }),
      ),
      sse(streamOf('anthropic', { text: ['Never.'] })),
    );
    const result = await runSlotlockAssistantTurn(
      turnOptions('anthropic', fetch, { signal: stop.signal, read, onEvent: (event) => events.push(event) }),
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      { type: 'call', id: 'r1', name: TOOLS_READ, use: 'read' },
      { type: 'result', id: 'r1', name: TOOLS_READ, ok: true },
    ]);
    expect(result.failure).toBeUndefined();
    expect(result.added).toEqual([
      {
        role: 'assistant',
        text: '',
        calls: [
          { id: 'r1', name: TOOLS_READ, input: {} },
          { id: 'r2', name: TOOLS_READ, input: {} },
        ],
      },
      {
        role: 'tool',
        results: [
          { id: 'r1', name: TOOLS_READ, content: JSON.stringify({ resources: [] }), error: false },
          { id: 'r2', name: TOOLS_READ, content: JSON.stringify({ error: { code: 'stopped' } }), error: true },
        ],
      },
      { role: 'note', text: 'Stopped.' },
    ]);
  });

  it('calls no model when stopped before it starts, and stops a call that does not stream', async () => {
    const stop = new AbortController();
    stop.abort();
    const { fetch, mock } = fakeFetch(sse(streamOf('anthropic', { text: ['Never.'] })));
    expect(await runSlotlockAssistantTurn(turnOptions('anthropic', fetch, { signal: stop.signal }))).toEqual({
      added: [{ role: 'note', text: 'Stopped.' }],
    });
    expect(mock).not.toHaveBeenCalled();

    // No onEvent: one JSON answer, aborted while it waits.
    const later = new AbortController();
    const hanging = (async (_input: unknown, init: RequestInit = {}) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        setTimeout(() => later.abort(), 10);
      })) as unknown as typeof globalThis.fetch;
    expect(await runSlotlockAssistantTurn(turnOptions('anthropic', hanging, { signal: later.signal }))).toEqual({
      added: [{ role: 'note', text: 'Stopped.' }],
    });
  });
});

describe('a stream over a real HTTP connection', () => {
  let server: Server;
  let baseUrl: string;
  let firstSeen: () => void = () => undefined;
  const pieces = (provider: Provider) => {
    const text = streamOf(provider, { text: ['Streaming ', 'as it ', 'arrives.'] });
    // Everything up to and including the first delta, then the rest.
    const cut = text.indexOf('as it');
    const firstEnd = text.lastIndexOf('\n\n', cut) + 2;
    return [text.slice(0, firstEnd), text.slice(firstEnd)];
  };

  beforeAll(async () => {
    server = createServer((incoming, outgoing) => {
      incoming.resume();
      incoming.on('end', () => {
        const provider: Provider = incoming.url === '/v1/messages' ? 'anthropic' : 'openai';
        const [head, tail] = pieces(provider);
        outgoing.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        outgoing.write(head);
        // The rest only once the client has shown the first delta: a reader that waits for the
        // whole body never gets it.
        const seen = new Promise<void>((resolve) => {
          firstSeen = resolve;
        });
        void seen.then(() => outgoing.end(tail));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );

  it.each(['anthropic', 'openai'] as const)('delivers each %s delta before the body ends', async (provider) => {
    const deltas: string[] = [];
    const turn = await callSlotlockAssistantModel(
      request(provider, globalThis.fetch, {
        model: { ...MODELS[provider], baseUrl: provider === 'anthropic' ? baseUrl : `${baseUrl}/v1` },
        onText: (delta) => {
          deltas.push(delta);
          firstSeen();
        },
      }),
    );
    expect(deltas).toEqual(['Streaming ', 'as it ', 'arrives.']);
    expect(turn.text).toBe('Streaming as it arrives.');
  });

  it('is a timeout when aborted mid-stream through fetch', async () => {
    const controller = new AbortController();
    const deltas: string[] = [];
    await expect(
      callSlotlockAssistantModel(
        request('anthropic', globalThis.fetch, {
          model: { ...MODELS.anthropic, baseUrl },
          signal: controller.signal,
          onText: (delta) => {
            deltas.push(delta);
            controller.abort();
          },
        }),
      ),
    ).rejects.toMatchObject({ reason: 'timeout' });
    expect(deltas).toEqual(['Streaming ']);
    firstSeen();
  });
});
