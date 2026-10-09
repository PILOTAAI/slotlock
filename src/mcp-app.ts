/** Stable MCP Apps extension identifiers from SEP-1865 (2026-01-26). */
export const SLOTLOCK_MCP_APPS_EXTENSION = 'io.modelcontextprotocol/ui';
export const SLOTLOCK_MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';
export const SLOTLOCK_MCP_APP_RESOURCE_URI = 'ui://slotlock/calendar';

/** True only when the host declares the stable extension's required HTML MIME capability. */
export function clientSupportsSlotlockMcpApp(capabilities: unknown): boolean {
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities))
    return false;
  const extensions = (capabilities as Record<string, unknown>).extensions;
  if (!extensions || typeof extensions !== 'object' || Array.isArray(extensions)) return false;
  const settings = (extensions as Record<string, unknown>)[SLOTLOCK_MCP_APPS_EXTENSION];
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return false;
  const mimeTypes = (settings as Record<string, unknown>).mimeTypes;
  return Array.isArray(mimeTypes) && mimeTypes.includes(SLOTLOCK_MCP_APP_MIME_TYPE);
}

/**
 * A static, network-dark calendar view. Dynamic calendar data arrives only through the host's
 * `ui/notifications/tool-result` channel; the template contains no tenant or event data and uses
 * textContent for every untrusted value. Keeping this as reviewed source instead of generated UI
 * also lets MCP hosts inspect and cache the exact resource before rendering it.
 */
export const SLOTLOCK_MCP_APP_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Slotlock calendar</title>
  <style>
    :root{color-scheme:light dark;font-family:var(--font-sans,ui-sans-serif,system-ui,sans-serif);background:var(--color-background-primary,#f5f5f0);color:var(--color-text-primary,#171915)}
    *{box-sizing:border-box}body{margin:0;min-width:0;background:transparent}button,input{font:inherit}
    .shell{display:grid;gap:14px;padding:16px;max-width:1000px;margin:0 auto}
    .mast{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:2px 2px 10px;border-bottom:1px solid var(--color-border-primary,#d7d9d2)}
    .eyebrow{margin:0 0 5px;font-size:11px;line-height:1.2;letter-spacing:.12em;text-transform:uppercase;color:var(--color-text-secondary,#667064)}
    h1{margin:0;font-size:clamp(22px,4vw,32px);line-height:1;letter-spacing:-.045em}p{margin:0}.status{display:inline-flex;align-items:center;gap:7px;min-height:30px;padding:6px 10px;border:1px solid var(--color-border-primary,#d7d9d2);border-radius:999px;font-size:12px;color:var(--color-text-secondary,#667064);background:var(--color-background-secondary,#fff)}
    .dot{width:7px;height:7px;border-radius:50%;background:#b7791f}.status[data-ready="true"] .dot{background:#23855b}
    .toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.search{min-width:min(100%,280px);min-height:42px;padding:9px 12px;border:1px solid var(--color-border-primary,#c9cdc4);border-radius:9px;background:var(--color-background-secondary,#fff);color:inherit}.search:focus-visible{outline:3px solid color-mix(in srgb,var(--color-ring-primary,#2e5bff) 42%,transparent);outline-offset:2px}
    .summary{color:var(--color-text-secondary,#667064);font-size:13px}.panel{min-width:0;border:1px solid var(--color-border-primary,#d7d9d2);border-radius:12px;background:var(--color-background-secondary,#fff);overflow:hidden}.panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 14px;border-bottom:1px solid var(--color-border-primary,#e1e3dd)}h2{margin:0;font-size:14px;letter-spacing:-.01em}.items{display:grid;min-width:0}.item{display:grid;grid-template-columns:minmax(130px,.85fr) minmax(0,1.5fr) auto;gap:12px;align-items:start;padding:13px 14px;border-bottom:1px solid var(--color-border-primary,#eceee8)}.item:last-child{border-bottom:0}.item-title{font-weight:650;overflow-wrap:anywhere}.item-detail{min-width:0;color:var(--color-text-secondary,#596157);font-size:13px;line-height:1.45;overflow-wrap:anywhere}.badge{justify-self:end;padding:4px 7px;border:1px solid var(--color-border-primary,#d7d9d2);border-radius:6px;font-size:11px;color:var(--color-text-secondary,#596157);white-space:nowrap}.empty{padding:30px 16px;text-align:center;color:var(--color-text-secondary,#667064);font-size:14px}.error{color:var(--color-text-danger,#9b2c2c)}
    details{border-top:1px solid var(--color-border-primary,#e1e3dd)}summary{cursor:pointer;padding:11px 14px;color:var(--color-text-secondary,#667064);font-size:12px}pre{margin:0;padding:14px;max-height:260px;overflow:auto;font:12px/1.5 var(--font-mono,ui-monospace,monospace);white-space:pre-wrap;overflow-wrap:anywhere;background:var(--color-background-tertiary,#f6f7f3)}
    @media(max-width:600px){.shell{padding:12px}.mast{align-items:stretch;flex-direction:column}.status{align-self:flex-start}.item{grid-template-columns:1fr}.badge{justify-self:start}.search{width:100%;font-size:16px}}
    @media(prefers-reduced-motion:no-preference){.dot{transition:background-color .18s ease}.item{animation:reveal .16s ease-out both}@keyframes reveal{from{opacity:.5;transform:translateY(3px)}to{opacity:1;transform:none}}}
  </style>
</head>
<body>
  <main class="shell">
    <header class="mast">
      <div><p class="eyebrow">Resource-first scheduling</p><h1>Slotlock calendar</h1></div>
      <div class="status" id="status" data-ready="false" role="status"><span class="dot" aria-hidden="true"></span><span id="statusText">Connecting to host</span></div>
    </header>
    <div class="toolbar">
      <label><span class="eyebrow">Filter this result</span><input id="filter" class="search" type="search" autocomplete="off" placeholder="Resource, event or time"></label>
      <p class="summary" id="summary" aria-live="polite">Waiting for a calendar result.</p>
    </div>
    <section class="panel" aria-labelledby="resultHeading">
      <div class="panel-head"><h2 id="resultHeading">Calendar result</h2></div>
      <div class="items" id="items"><p class="empty">Ask your agent to list resources, inspect free-busy, find a slot, or list events.</p></div>
      <details><summary>Structured result</summary><pre id="raw">No result yet.</pre></details>
    </section>
  </main>
  <script>
    (() => {
      'use strict';
      const state = { data: null, query: '', requestId: 1 };
      const status = document.getElementById('status');
      const statusText = document.getElementById('statusText');
      const items = document.getElementById('items');
      const summary = document.getElementById('summary');
      const raw = document.getElementById('raw');
      const filter = document.getElementById('filter');
      const safeText = (value) => value === null || value === undefined ? '—' : String(value);
      const post = (message) => window.parent.postMessage(message, '*');
      const setStatus = (text, ready) => { statusText.textContent = text; status.dataset.ready = ready ? 'true' : 'false'; };
      const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };
      const line = (title, detail, badge) => {
        const row = document.createElement('article'); row.className = 'item';
        const heading = document.createElement('div'); heading.className = 'item-title'; heading.textContent = safeText(title);
        const body = document.createElement('div'); body.className = 'item-detail'; body.textContent = safeText(detail);
        const mark = document.createElement('div'); mark.className = 'badge'; mark.textContent = safeText(badge);
        row.append(heading, body, mark); return row;
      };
      const intervalText = (entry) => [entry.start || entry.starts_at, entry.end || entry.ends_at].filter(Boolean).join(' → ');
      // A refused call carries no structuredContent (hosts validate it against the tool's
      // outputSchema); its text content is {"error":{"code":…}}.
      const refusalOf = (content) => {
        const text = Array.isArray(content) ? content.find((part) => part && part.type === 'text')?.text : undefined;
        try {
          const parsed = JSON.parse(text);
          if (parsed && parsed.error && typeof parsed.error === 'object') return { error: parsed.error };
        } catch {}
        return { error: { code: 'request_refused' } };
      };
      const flatten = (data) => {
        if (!data || typeof data !== 'object') return [];
        if (data.error) return [{ title: data.error.code || 'Unable to load', detail: 'The calendar server refused this request.', badge: 'Error' }];
        if (Array.isArray(data.resources)) return data.resources.flatMap((resource) => {
          if (Array.isArray(resource.busy)) return resource.busy.map((busy) => ({ title: resource.resource_id, detail: intervalText(busy), badge: resource.coverage?.certainty || 'busy' }));
          return [{ title: resource.external_ref || resource.id || resource.resource_id, detail: resource.timezone || 'Calendar resource', badge: resource.coverage?.certainty || 'resource' }];
        });
        if (Array.isArray(data.events)) return data.events.map((event) => ({ title: event.title || event.id, detail: intervalText(event), badge: event.status || event.transparency || 'event' }));
        if (data.event && typeof data.event === 'object') return [{ title: data.event.title || data.event.id, detail: intervalText(data.event), badge: data.event.status || 'event' }];
        if ('start' in data || 'end' in data) {
          const coverage = data.coverage && typeof data.coverage === 'object' ? data.coverage : null;
          const certainty = coverage?.certainty;
          const completeInterval = typeof data.start === 'string' && typeof data.end === 'string';
          if (certainty !== 'certain' || !completeInterval) {
            const reason = typeof coverage?.reason === 'string' ? coverage.reason.replaceAll('_', ' ') : 'Required calendar coverage is incomplete.';
            return [{ title: 'Availability unproven', detail: reason, badge: certainty || 'uncertain' }];
          }
          return [{ title: data.resource_id || 'Next available', detail: intervalText(data), badge: certainty }];
        }
        return Object.entries(data).slice(0, 100).map(([key, value]) => ({ title: key, detail: typeof value === 'object' ? JSON.stringify(value) : safeText(value), badge: 'value' }));
      };
      const render = () => {
        clear(items);
        const rows = flatten(state.data).filter((entry) => (entry.title + ' ' + entry.detail + ' ' + entry.badge).toLowerCase().includes(state.query));
        if (rows.length === 0) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = state.data ? 'No rows match this filter.' : 'Waiting for a calendar result.'; items.append(empty); }
        else rows.forEach((entry) => items.append(line(entry.title, entry.detail, entry.badge)));
        summary.textContent = rows.length === 1 ? '1 calendar row' : rows.length + ' calendar rows';
        raw.textContent = state.data ? JSON.stringify(state.data, null, 2) : 'No result yet.';
      };
      filter.addEventListener('input', () => { state.query = filter.value.trim().toLowerCase(); render(); });
      window.addEventListener('message', (event) => {
        if (event.source !== window.parent) return;
        const message = event.data;
        if (!message || message.jsonrpc !== '2.0') return;
        if (message.id === state.requestId && message.result) {
          post({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
          setStatus('Connected', true);
          return;
        }
        if (message.method === 'ui/notifications/tool-result') {
          const result = message.params || {};
          state.data = result.structuredContent || (result.isError ? refusalOf(result.content) : null);
          setStatus(result.isError ? 'Request refused' : 'Result current', !result.isError);
          render();
        }
        if (message.method === 'ui/notifications/host-context-changed' && message.params?.theme) document.documentElement.dataset.theme = message.params.theme;
      });
      post({ jsonrpc: '2.0', id: state.requestId, method: 'ui/initialize', params: { appInfo: { name: 'slotlock-calendar', version: '1.0.0' }, appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] }, protocolVersion: '2026-01-26' } });
    })();
  </script>
</body>
</html>`;

export const SLOTLOCK_MCP_APP_RESOURCE = Object.freeze({
  uri: SLOTLOCK_MCP_APP_RESOURCE_URI,
  name: 'Slotlock calendar',
  description: 'Inspect resource availability and calendar results inside an MCP host.',
  mimeType: SLOTLOCK_MCP_APP_MIME_TYPE,
  _meta: {
    ui: {
      csp: {
        connectDomains: [] as string[],
        resourceDomains: [] as string[],
        frameDomains: [] as string[],
        baseUriDomains: [] as string[],
      },
      prefersBorder: true,
    },
  },
});
