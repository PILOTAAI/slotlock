// A model provider on a loopback port that speaks either the Anthropic Messages API or OpenAI-
// compatible chat completions, answering from a script: each request takes the next answer (the
// last one repeats). It records what the dashboard sent, headers included, so a test can check the
// format, the key and what the model was shown.
import { type IncomingHttpHeaders, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeModelFormat = 'anthropic' | 'openai';

export interface FakeModelCall {
  name: string;
  input: Record<string, unknown>;
}

/** One scripted answer: text and tool calls, or an HTTP failure with a body. */
export type FakeModelAnswer =
  | { text?: string; calls?: FakeModelCall[] }
  | { status: number; body: string }
  | ((
      request: FakeModelRequest,
    ) =>
      | { text?: string; calls?: FakeModelCall[] }
      | Promise<{ text?: string; calls?: FakeModelCall[] }>);

export interface FakeModelRequest {
  path: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

export interface FakeModel {
  /** The base URL to configure: `<origin>` for Anthropic, `<origin>/v1` for OpenAI-compatible. */
  baseUrl: string;
  requests: FakeModelRequest[];
  script(...answers: FakeModelAnswer[]): void;
  close(): Promise<void>;
}

let callCount = 0;

/** The provider's JSON for an answer, as the format's SDK types describe a response. */
export function fakeModelBody(
  format: FakeModelFormat,
  answer: { text?: string; calls?: FakeModelCall[] },
): Record<string, unknown> {
  const calls = answer.calls ?? [];
  if (format === 'anthropic') {
    return {
      id: `msg_${(callCount += 1)}`,
      type: 'message',
      role: 'assistant',
      model: 'your-model',
      content: [
        ...(answer.text ? [{ type: 'text', text: answer.text }] : []),
        ...calls.map((call) => ({
          type: 'tool_use',
          id: `toolu_${(callCount += 1)}`,
          name: call.name,
          input: call.input,
        })),
      ],
      stop_reason: calls.length > 0 ? 'tool_use' : 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  }
  return {
    id: `chatcmpl-${(callCount += 1)}`,
    object: 'chat.completion',
    created: 0,
    model: 'your-model',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: answer.text ?? null,
          ...(calls.length > 0
            ? {
                tool_calls: calls.map((call) => ({
                  id: `call_${(callCount += 1)}`,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.input) },
                })),
              }
            : {}),
        },
        finish_reason: calls.length > 0 ? 'tool_calls' : 'stop',
      },
    ],
  };
}

export async function startFakeModel(format: FakeModelFormat): Promise<FakeModel> {
  const requests: FakeModelRequest[] = [];
  let answers: FakeModelAnswer[] = [{ text: 'Hello.' }];
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', async () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      } catch {
        // Recorded as empty.
      }
      const request = { path: incoming.url ?? '', headers: incoming.headers, body };
      requests.push(request);
      const expected = format === 'anthropic' ? '/v1/messages' : '/v1/chat/completions';
      if (request.path !== expected) {
        outgoing.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
        return;
      }
      const answer = answers.length > 1 ? (answers.shift() as FakeModelAnswer) : (answers[0] as FakeModelAnswer);
      if (typeof answer !== 'function' && 'status' in answer) {
        outgoing.writeHead(answer.status, { 'content-type': 'application/json' }).end(answer.body);
        return;
      }
      const resolved = typeof answer === 'function' ? await answer(request) : answer;
      outgoing
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(fakeModelBody(format, resolved)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    baseUrl: format === 'anthropic' ? origin : `${origin}/v1`,
    requests,
    script(...next) {
      answers = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The tool results the dashboard last sent the model, as `{ name or id: parsed content }` text. */
export function toolResultsSent(format: FakeModelFormat, request: FakeModelRequest | undefined): string[] {
  const messages = (request?.body.messages ?? []) as Array<Record<string, unknown>>;
  if (format === 'openai') {
    return messages.filter((message) => message.role === 'tool').map((message) => String(message.content));
  }
  return messages.flatMap((message) =>
    Array.isArray(message.content)
      ? (message.content as Array<Record<string, unknown>>)
          .filter((block) => block.type === 'tool_result')
          .map((block) => String(block.content))
      : [],
  );
}

/** The tool names offered in a request. */
export function toolsOffered(format: FakeModelFormat, request: FakeModelRequest | undefined): string[] {
  const tools = (request?.body.tools ?? []) as Array<Record<string, unknown>>;
  return tools.map((tool) =>
    format === 'anthropic' ? String(tool.name) : String((tool.function as Record<string, unknown>).name),
  );
}
