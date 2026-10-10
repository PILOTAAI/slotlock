import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import {
  type SlotlockAgentCalendarBackend,
  type SlotlockAgentServerOptions,
  createSlotlockAgentServer,
} from '../agent-server.js';
import { SLOTLOCK_MCP_APP_HTML } from '../mcp-app.js';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom') as {
  JSDOM: new (
    html: string,
    options: { runScripts: 'dangerously'; url: string },
  ) => {
    window: {
      MessageEvent: new (type: string, init: { data: unknown; source: unknown }) => unknown;
      dispatchEvent(event: unknown): boolean;
      document: {
        querySelector(selector: string): { textContent: string | null } | null;
      };
      close(): void;
    };
  };
};

const unused = async () => ({});

function calendarServer(
  backend: Partial<SlotlockAgentCalendarBackend>,
  options: Partial<SlotlockAgentServerOptions> = {},
) {
  return createSlotlockAgentServer({
    publicBaseUrl: 'http://localhost/slotlock',
    allowInsecureLocalhost: true,
    backend: {
      listResources: unused,
      getFreeBusy: unused,
      findNextAvailable: unused,
      createEvent: unused,
      getEvent: unused,
      listEvents: unused,
      updateEvent: unused,
      deleteEvent: unused,
      ...backend,
    },
    authenticate: async () => ({ subject: 'attacker', tenantRef: 'tenant-a' }),
    authorize: async () => true,
    health: async () => ({ ready: true, checks: [] }),
    ...options,
  });
}

async function callTool(
  server: ReturnType<typeof createSlotlockAgentServer>,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await server.fetch(
    new Request('http://localhost/slotlock/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': '2025-11-25',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    }),
  );
  return ((await response.json()) as { result: Record<string, unknown> }).result;
}

/** Hand one real tools/call result to the App the way an MCP Apps host does, then read the view. */
function renderInApp(result: Record<string, unknown>) {
  const dom = new JSDOM(SLOTLOCK_MCP_APP_HTML, {
    runScripts: 'dangerously',
    url: 'https://mcp-host.example',
  });
  try {
    dom.window.dispatchEvent(
      new dom.window.MessageEvent('message', {
        data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result },
        source: dom.window,
      }),
    );
    const text = (selector: string) => dom.window.document.querySelector(selector)?.textContent;
    return {
      title: text('.item-title'),
      detail: text('.item-detail'),
      badge: text('.badge'),
      status: text('#statusText'),
    };
  } finally {
    dom.window.close();
  }
}

it('does not present incomplete coverage as a next available interval', async () => {
  const server = calendarServer({
    findNextAvailable: async () => ({
      resource_id: null,
      start: null,
      end: null,
      coverage: {
        start: '2026-09-20T09:00:00.000Z',
        end: '2026-09-20T17:00:00.000Z',
        certainty: 'uncertain',
        reason: 'coverage_incomplete',
      },
    }),
  });
  const result = await callTool(server, 'slotlock_find_next_available', {
    resource_ids: ['vehicle-1'],
    start: '2026-09-20T09:00:00.000Z',
    end: '2026-09-20T17:00:00.000Z',
    duration_minutes: 60,
  });

  expect(renderInApp(result)).toMatchObject({
    title: 'Availability unproven',
    detail: 'coverage incomplete',
    badge: 'uncertain',
  });
});

// A refused call carries no structuredContent (MCP clients validate it against the tool's
// outputSchema), so the App reads the refusal from the text content.
it('shows the error code of a refused call', async () => {
  const server = calendarServer({}, { authorize: async () => false });
  const result = await callTool(server, 'slotlock_get_free_busy', {
    resource_ids: ['vehicle-1'],
    start: '2026-09-20T09:00:00.000Z',
    end: '2026-09-20T17:00:00.000Z',
  });
  expect(result).toMatchObject({ isError: true });
  expect(result).not.toHaveProperty('structuredContent');

  expect(renderInApp(result)).toMatchObject({
    title: 'forbidden',
    badge: 'Error',
    status: 'Request refused',
  });
});
