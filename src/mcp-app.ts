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
 *
 * A certain slot (from `slotlock_find_available_slots` or `slotlock_find_next_available`) can be
 * picked: the view sends the host one `ui/message` naming it, in a fixed sentence holding only the
 * resource id and the two instants it checked, so the agent books it through the normal path,
 * where Slotlock asks a person to confirm the write if it is set to. The view itself never calls a
 * tool, and every write tool is visible to the model only.
 */
export const SLOTLOCK_MCP_APP_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Slotlock calendar</title>
  <style>
    :root{color-scheme:light dark;--fb-bg:#fbfbf9;--fb-surface:#ffffff;--fb-sunken:#f3f4f0;--fb-text:#171915;--fb-muted:#5d655b;--fb-faint:#8a9187;--fb-line:#e3e5df;--fb-line-strong:#c9cdc4;--fb-inverse:#171915;--fb-on-inverse:#ffffff;--fb-ring:#2e5bff;--fb-ok:#23855b;--fb-warn:#b7791f;--fb-danger:#9b2c2c}
    @media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--fb-bg:#121411;--fb-surface:#1a1d19;--fb-sunken:#22261f;--fb-text:#eef0ea;--fb-muted:#a9b0a5;--fb-faint:#7d847a;--fb-line:#2c302a;--fb-line-strong:#3d4339;--fb-inverse:#eef0ea;--fb-on-inverse:#121411;--fb-ring:#7d9bff;--fb-ok:#5cc495;--fb-warn:#e0a44a;--fb-danger:#f08a8a}}
    :root[data-theme="dark"]{--fb-bg:#121411;--fb-surface:#1a1d19;--fb-sunken:#22261f;--fb-text:#eef0ea;--fb-muted:#a9b0a5;--fb-faint:#7d847a;--fb-line:#2c302a;--fb-line-strong:#3d4339;--fb-inverse:#eef0ea;--fb-on-inverse:#121411;--fb-ring:#7d9bff;--fb-ok:#5cc495;--fb-warn:#e0a44a;--fb-danger:#f08a8a}
    :root{--bg:var(--color-background-primary,var(--fb-bg));--surface:var(--color-background-secondary,var(--fb-surface));--sunken:var(--color-background-tertiary,var(--fb-sunken));--text:var(--color-text-primary,var(--fb-text));--muted:var(--color-text-secondary,var(--fb-muted));--faint:var(--color-text-tertiary,var(--fb-faint));--line:var(--color-border-primary,var(--fb-line));--line-strong:var(--color-border-secondary,var(--fb-line-strong));--inverse:var(--color-background-inverse,var(--fb-inverse));--on-inverse:var(--color-text-inverse,var(--fb-on-inverse));--ring:var(--color-ring-primary,var(--fb-ring));--ok:var(--color-text-success,var(--fb-ok));--danger:var(--color-text-danger,var(--fb-danger));font-family:var(--font-sans,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif);color:var(--text);background:var(--bg)}
    *{box-sizing:border-box}body{margin:0;min-width:0;background:transparent;-webkit-font-smoothing:antialiased}button,input,textarea{font:inherit;color:inherit}p{margin:0}
    button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
    .shell{display:grid;gap:12px;padding:16px;max-width:760px;margin:0 auto}
    .sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
    .status{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--muted)}.dot{width:7px;height:7px;border-radius:50%;background:var(--fb-warn)}.status[data-ready="true"] .dot{background:var(--ok)}
    /* The picker */
    .picker{display:grid;border:1px solid var(--line);border-radius:16px;background:var(--surface);overflow:hidden}.picker[hidden]{display:none}
    .head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:16px 16px 12px}
    .head h1{margin:0;font-size:var(--font-heading-sm-size,18px);font-weight:var(--font-weight-semibold,600);letter-spacing:-.01em}
    .meta{margin-top:4px;font-size:13px;color:var(--muted);display:flex;flex-wrap:wrap;gap:4px 10px}.meta span+span::before{content:"·";margin-right:10px;color:var(--faint)}
    .clock{display:inline-flex;padding:2px;border-radius:8px;background:var(--sunken);flex:none}.clock button{min-width:40px;padding:4px 8px;border:0;border-radius:6px;background:transparent;font-size:12px;color:var(--muted);cursor:pointer}.clock button[aria-pressed="true"]{background:var(--surface);color:var(--text);box-shadow:0 1px 2px rgba(0,0,0,.08)}
    .days{display:flex;gap:6px;padding:0 16px 12px;overflow-x:auto;scrollbar-width:none;scroll-snap-type:x proximity}.days::-webkit-scrollbar{display:none}.days[hidden]{display:none}
    .day{flex:none;display:grid;justify-items:center;gap:1px;width:56px;padding:8px 0 7px;border:1px solid var(--line);border-radius:12px;background:transparent;cursor:pointer;scroll-snap-align:start;font-variant-numeric:tabular-nums}
    .day small{font-size:11px;color:var(--muted)}.day strong{font-size:17px;font-weight:var(--font-weight-semibold,600);line-height:1.2}.day i{font-style:normal;font-size:10px;color:var(--faint)}
    .day:hover{border-color:var(--line-strong)}.day[aria-pressed="true"]{background:var(--inverse);border-color:var(--inverse);color:var(--on-inverse)}.day[aria-pressed="true"] small,.day[aria-pressed="true"] i{color:inherit;opacity:.75}
    .times{display:grid;gap:14px;padding:14px 16px 16px;border-top:1px solid var(--line)}.times[hidden],.choice[hidden]{display:none}.foot:has(.choice[hidden]){justify-content:flex-end}
    .part h2{margin:0 0 8px;font-size:11px;font-weight:var(--font-weight-medium,500);letter-spacing:.06em;text-transform:uppercase;color:var(--faint)}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px}
    .time{display:grid;justify-items:center;gap:1px;min-height:42px;padding:8px 6px;border:1px solid var(--line-strong);border-radius:10px;background:var(--surface);cursor:pointer;font-variant-numeric:tabular-nums;font-weight:var(--font-weight-medium,500);transition:border-color .12s,background-color .12s}
    .time small{font-size:10px;font-weight:400;color:var(--muted)}.time:hover:not(:disabled){border-color:var(--text)}
    .time[aria-pressed="true"]{background:var(--inverse);border-color:var(--inverse);color:var(--on-inverse)}.time[aria-pressed="true"] small{color:inherit;opacity:.75}.time:disabled{cursor:default}.time:disabled:not([aria-pressed="true"]){opacity:.45}
    .one{display:grid;gap:4px;padding:4px 16px 16px}.one strong{font-size:var(--font-heading-md-size,22px);font-weight:var(--font-weight-semibold,600);letter-spacing:-.01em;font-variant-numeric:tabular-nums}.one span{font-size:14px;color:var(--muted)}.one[hidden]{display:none}
    .foot{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-top:1px solid var(--line);background:var(--sunken)}
    .choice{min-width:0;font-size:13px;color:var(--muted);overflow-wrap:anywhere}.choice b{display:block;color:var(--text);font-weight:var(--font-weight-semibold,600)}
    .book{flex:none;min-height:40px;padding:9px 16px;border:0;border-radius:10px;background:var(--inverse);color:var(--on-inverse);font-weight:var(--font-weight-semibold,600);cursor:pointer}.book:disabled{cursor:default;opacity:.4}.book[data-sent="true"]{opacity:1;background:transparent;color:var(--ok);padding-inline:4px}
    .fallback{display:grid;gap:6px;padding:12px 16px;border-top:1px solid var(--line);font-size:13px;color:var(--muted)}.fallback[hidden]{display:none}.fallback textarea{width:100%;min-height:64px;padding:8px;border:1px solid var(--line-strong);border-radius:8px;background:var(--bg);font:12px/1.5 var(--font-mono,ui-monospace,monospace);resize:vertical}
    /* Every other result */
    .list[hidden]{display:none}.list{display:grid;gap:12px}
    .mast{display:flex;align-items:center;justify-content:space-between;gap:12px}.mast h1{margin:0;font-size:var(--font-heading-sm-size,18px);font-weight:var(--font-weight-semibold,600)}
    .toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.search{flex:1;min-width:min(100%,220px);min-height:38px;padding:8px 12px;border:1px solid var(--line-strong);border-radius:10px;background:var(--surface)}.summary{font-size:13px;color:var(--muted)}
    .panel{min-width:0;border:1px solid var(--line);border-radius:14px;background:var(--surface);overflow:hidden}.items{display:grid;min-width:0}
    .item{display:grid;grid-template-columns:minmax(120px,.85fr) minmax(0,1.5fr) auto;gap:12px;align-items:start;padding:12px 14px;border-bottom:1px solid var(--line)}.item:last-child{border-bottom:0}.item-title{font-weight:var(--font-weight-semibold,600);overflow-wrap:anywhere}.item-detail{min-width:0;color:var(--muted);font-size:13px;line-height:1.45;overflow-wrap:anywhere}.badge{justify-self:end;padding:3px 7px;border:1px solid var(--line);border-radius:6px;font-size:11px;color:var(--muted);white-space:nowrap}.empty{padding:28px 16px;text-align:center;color:var(--muted);font-size:14px}
    details{border-top:1px solid var(--line)}summary{cursor:pointer;padding:10px 14px;color:var(--muted);font-size:12px}pre{margin:0;padding:14px;max-height:260px;overflow:auto;font:12px/1.5 var(--font-mono,ui-monospace,monospace);white-space:pre-wrap;overflow-wrap:anywhere;background:var(--sunken)}
    @media(max-width:520px){.shell{padding:10px}.item{grid-template-columns:1fr}.badge{justify-self:start}.grid{grid-template-columns:repeat(auto-fill,minmax(84px,1fr))}.foot{flex-wrap:wrap}.book{flex:1}}
    @media(prefers-reduced-motion:reduce){.time{transition:none}}
  </style>
</head>
<body>
  <main class="shell">
    <section class="picker" id="picker" aria-labelledby="pickTitle" hidden>
      <div class="head">
        <div><h1 id="pickTitle">Pick a time</h1><p class="meta" id="pickMeta"></p></div>
        <div class="clock" role="group" aria-label="Clock"><button type="button" id="h12" aria-pressed="false">12h</button><button type="button" id="h24" aria-pressed="false">24h</button></div>
      </div>
      <div class="days" id="days" role="group" aria-label="Day"></div>
      <div class="one" id="one" hidden></div>
      <div class="times" id="times"></div>
      <div class="foot">
        <p class="choice" id="choice" aria-live="polite">No time picked</p>
        <button type="button" class="book" id="book" disabled>Book this time</button>
      </div>
      <div class="fallback" id="fallback" hidden><p>Your host did not pass the choice on. Send this to your agent:</p><textarea id="fallbackText" readonly></textarea></div>
    </section>
    <section class="list" id="list">
      <header class="mast"><h1>Slotlock calendar</h1><p class="status" id="status" data-ready="false" role="status"><span class="dot" aria-hidden="true"></span><span id="statusText">Connecting to host</span></p></header>
      <div class="toolbar">
        <label class="sr" for="filter">Filter this result</label><input id="filter" class="search" type="search" autocomplete="off" placeholder="Filter by resource, event or time">
        <p class="summary" id="summary" aria-live="polite">Waiting for a calendar result.</p>
      </div>
      <div class="panel">
        <div class="items" id="items"><p class="empty">Ask your agent to list resources, inspect free-busy, find a slot, or list events.</p></div>
        <details><summary>Structured result</summary><pre id="raw">No result yet.</pre></details>
      </div>
    </section>
  </main>
  <script>
    (() => {
      'use strict';
      const state = { data: null, query: '', requestId: 1, nextId: 2, timeZone: undefined, locale: undefined, hour12: undefined, day: null, chosen: null, sent: false, pending: {}, size: '' };
      const $ = (id) => document.getElementById(id);
      const status = $('status'), statusText = $('statusText'), items = $('items'), summary = $('summary'), raw = $('raw'), filter = $('filter');
      const picker = $('picker'), list = $('list'), days = $('days'), times = $('times'), one = $('one'), choice = $('choice'), book = $('book'), pickMeta = $('pickMeta'), fallback = $('fallback'), fallbackText = $('fallbackText'), h12 = $('h12'), h24 = $('h24');
      const safeText = (value) => value === null || value === undefined ? '—' : String(value);
      const post = (message) => window.parent.postMessage(message, '*');
      const setStatus = (text, ready) => { statusText.textContent = text; status.dataset.ready = ready ? 'true' : 'false'; };
      const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };
      const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };

      // The host's look: its standard theme variables (only these names, as plain values) and its theme.
      const THEME_KEYS = /^--(color-(background|text|border|ring)-[a-z]+|font-(sans|mono)|font-weight-[a-z]+|font-(text|heading)-[a-z]+-size)$/;
      const applyHost = (context) => {
        if (!context || typeof context !== 'object') return;
        if (context.theme === 'light' || context.theme === 'dark') document.documentElement.dataset.theme = context.theme;
        const variables = context.styles && context.styles.variables;
        if (variables && typeof variables === 'object') {
          Object.entries(variables).forEach(([key, value]) => {
            if (THEME_KEYS.test(key) && typeof value === 'string' && value.length <= 200 && !/url\\(|expression|[;{}<>]/i.test(value)) document.documentElement.style.setProperty(key, value);
          });
        }
        if (typeof context.timeZone === 'string') state.timeZone = context.timeZone;
        if (typeof context.locale === 'string') state.locale = context.locale;
      };

      // Only what the view has checked goes into the message a person sends: an id of plain
      // characters and two instants it parsed itself, never a title or any other server text.
      const SAFE_ID = /^[A-Za-z0-9._:-]{1,200}$/;
      const instant = (value) => { const time = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(time) ? new Date(time) : null; };
      const pickable = (slot) => {
        if (!slot || typeof slot.resource_id !== 'string' || !SAFE_ID.test(slot.resource_id)) return null;
        const start = instant(slot.start); const end = instant(slot.end);
        return start && end && end > start ? { resource_id: slot.resource_id, start, end } : null;
      };
      const slotsOf = (data) => {
        if (!data || typeof data !== 'object' || data.error || data.coverage?.certainty !== 'certain') return [];
        const listed = Array.isArray(data.slots) ? data.slots : 'start' in data ? [data] : [];
        return listed.map(pickable).filter(Boolean);
      };

      const fmt = (date, options) => {
        const zone = state.timeZone ? { timeZone: state.timeZone } : {};
        try { return new Intl.DateTimeFormat(state.locale, { ...options, ...zone }).format(date); }
        catch { return new Intl.DateTimeFormat(undefined, options).format(date); }
      };
      const prefers12 = () => { try { const cycle = new Intl.DateTimeFormat(state.locale, { hour: 'numeric' }).resolvedOptions().hourCycle; return cycle === 'h11' || cycle === 'h12'; } catch { return false; } };
      const hour12 = () => state.hour12 === undefined ? prefers12() : state.hour12;
      const dayKey = (date) => fmt(date, { year: 'numeric', month: '2-digit', day: '2-digit' });
      const dayLabel = (date) => fmt(date, { weekday: 'short', day: 'numeric', month: 'short' });
      const timeLabel = (date) => fmt(date, { hour: hour12() ? 'numeric' : '2-digit', minute: '2-digit', hour12: hour12() });
      // The hour as a number in any locale: German formats it as "10 Uhr", so read the hour part.
      const hourOf = (date) => {
        const zone = state.timeZone ? { timeZone: state.timeZone } : {};
        let parts;
        try { parts = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', ...zone }).formatToParts(date); }
        catch { parts = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23' }).formatToParts(date); }
        return Number(parts.find((part) => part.type === 'hour')?.value) % 24;
      };
      const minutes = (slot) => Math.round((slot.end - slot.start) / 60000);
      const lengthLabel = (total) => total < 60 ? total + ' min' : Math.floor(total / 60) + ' h' + (total % 60 ? ' ' + (total % 60) + ' min' : '');
      const sentence = (slot) => 'Book the slot I picked: resource ' + slot.resource_id + ', from ' + slot.start.toISOString() + ' to ' + slot.end.toISOString() + ' (' + dayLabel(slot.start) + ', ' + timeLabel(slot.start) + ' to ' + timeLabel(slot.end) + (state.timeZone ? ' ' + state.timeZone : '') + ').';

      const renderPicker = (slots) => {
        const resources = [...new Set(slots.map((slot) => slot.resource_id))];
        const lengths = new Set(slots.map(minutes));
        clear(pickMeta);
        if (lengths.size === 1) pickMeta.append(el('span', '', lengthLabel(minutes(slots[0]))));
        if (resources.length > 1) pickMeta.append(el('span', '', resources.length + ' resources'));
        pickMeta.append(el('span', '', state.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local time'));
        h12.setAttribute('aria-pressed', String(hour12())); h24.setAttribute('aria-pressed', String(!hour12()));
        const byDay = new Map();
        slots.forEach((slot) => { const key = dayKey(slot.start); if (!byDay.has(key)) byDay.set(key, []); byDay.get(key).push(slot); });
        if (!byDay.has(state.day)) state.day = byDay.keys().next().value;
        const single = slots.length === 1;
        $('pickTitle').textContent = single ? 'Next available' : 'Pick a time';
        clear(days); clear(times); clear(one);
        days.hidden = single || byDay.size < 2;
        one.hidden = !single;
        times.hidden = single;
        if (single) {
          if (!state.chosen) state.chosen = slots[0];
          one.append(el('strong', '', timeLabel(slots[0].start) + '–' + timeLabel(slots[0].end)), el('span', '', fmt(slots[0].start, { weekday: 'long', day: 'numeric', month: 'long' })));
        } else {
          byDay.forEach((daySlots, key) => {
            const first = daySlots[0].start;
            const button = el('button', 'day');
            button.type = 'button';
            button.setAttribute('aria-pressed', String(key === state.day));
            button.setAttribute('aria-label', dayLabel(first) + ', ' + daySlots.length + (daySlots.length === 1 ? ' time' : ' times'));
            button.append(el('small', '', fmt(first, { weekday: 'short' })), el('strong', '', fmt(first, { day: 'numeric' })), el('i', '', fmt(first, { month: 'short' })));
            button.addEventListener('click', () => { state.day = key; render(); });
            days.append(button);
          });
          const parts = [['Morning', (h) => h < 12], ['Afternoon', (h) => h >= 12 && h < 17], ['Evening', (h) => h >= 17]];
          const daySlots = byDay.get(state.day) || [];
          parts.forEach(([name, test]) => {
            const inPart = daySlots.filter((slot) => test(hourOf(slot.start)));
            if (inPart.length === 0) return;
            const part = el('section', 'part'); const grid = el('div', 'grid');
            part.append(el('h2', '', name), grid);
            inPart.forEach((slot) => {
              const button = el('button', 'time', timeLabel(slot.start));
              button.type = 'button';
              const isChosen = state.chosen && state.chosen.resource_id === slot.resource_id && +state.chosen.start === +slot.start;
              button.setAttribute('aria-pressed', String(Boolean(isChosen)));
              button.setAttribute('aria-label', dayLabel(slot.start) + ', ' + timeLabel(slot.start) + ' to ' + timeLabel(slot.end) + (resources.length > 1 ? ', resource ' + (resources.indexOf(slot.resource_id) + 1) : ''));
              if (resources.length > 1) button.append(el('small', '', 'Resource ' + (resources.indexOf(slot.resource_id) + 1)));
              else if (lengths.size > 1) button.append(el('small', '', lengthLabel(minutes(slot))));
              button.disabled = state.sent;
              button.addEventListener('click', () => { state.chosen = slot; fallback.hidden = true; render(); });
              grid.append(button);
            });
            times.append(part);
          });
        }
        clear(choice);
        choice.hidden = single;
        if (state.chosen) {
          choice.append(el('b', '', dayLabel(state.chosen.start) + ', ' + timeLabel(state.chosen.start) + '–' + timeLabel(state.chosen.end)));
          if (resources.length > 1) choice.append(document.createTextNode('Resource ' + (resources.indexOf(state.chosen.resource_id) + 1)));
        } else choice.textContent = 'No time picked';
        book.disabled = !state.chosen || state.sent;
        book.dataset.sent = String(state.sent);
        book.textContent = state.sent ? '✓ Sent to your agent' : 'Book this time';
      };
      book.addEventListener('click', () => {
        if (!state.chosen || state.sent) return;
        state.sent = true;
        fallback.hidden = true;
        const text = sentence(state.chosen);
        const id = state.nextId++;
        state.pending[id] = text;
        setStatus('Sent to your agent', true);
        post({ jsonrpc: '2.0', id, method: 'ui/message', params: { role: 'user', content: { type: 'text', text } } });
        render();
      });
      h12.addEventListener('click', () => { state.hour12 = true; render(); });
      h24.addEventListener('click', () => { state.hour12 = false; render(); });

      const reportSize = () => {
        const root = document.documentElement;
        const size = { width: Math.ceil(root.scrollWidth), height: Math.ceil(root.scrollHeight) };
        const key = size.width + 'x' + size.height;
        if (key === state.size) return;
        state.size = key;
        post({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: size });
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
        if (Array.isArray(data.slots)) {
          if (data.coverage?.certainty !== 'certain') return [{ title: 'Availability unproven', detail: 'Required calendar coverage is incomplete.', badge: data.coverage?.certainty || 'uncertain' }];
          return data.slots.length === 0 ? [{ title: 'No free time', detail: 'Nothing of that length is free in the window.', badge: 'certain' }] : data.slots.map((slot) => ({ title: slot.resource_id, detail: intervalText(slot), badge: 'free' }));
        }
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
      const line = (title, detail, badge) => {
        const row = el('article', 'item');
        row.append(el('div', 'item-title', safeText(title)), el('div', 'item-detail', safeText(detail)), el('div', 'badge', safeText(badge)));
        return row;
      };
      const render = () => {
        const slots = slotsOf(state.data);
        picker.hidden = slots.length === 0;
        list.hidden = slots.length > 0;
        if (slots.length > 0) { renderPicker(slots); reportSize(); return; }
        clear(items);
        const rows = flatten(state.data).filter((entry) => (entry.title + ' ' + entry.detail + ' ' + entry.badge).toLowerCase().includes(state.query));
        if (rows.length === 0) items.append(el('p', 'empty', state.data ? 'No rows match this filter.' : 'Waiting for a calendar result.'));
        else rows.forEach((entry) => items.append(line(entry.title, entry.detail, entry.badge)));
        summary.textContent = rows.length === 1 ? '1 calendar row' : rows.length + ' calendar rows';
        raw.textContent = state.data ? JSON.stringify(state.data, null, 2) : 'No result yet.';
        reportSize();
      };
      filter.addEventListener('input', () => { state.query = filter.value.trim().toLowerCase(); render(); });
      window.addEventListener('message', (event) => {
        if (event.source !== window.parent) return;
        const message = event.data;
        if (!message || message.jsonrpc !== '2.0') return;
        if (message.id === state.requestId && message.result) {
          applyHost(message.result.hostContext);
          post({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
          setStatus('Connected', true);
          render();
          return;
        }
        if (message.id in state.pending) {
          const text = state.pending[message.id];
          delete state.pending[message.id];
          if (message.error) {
            // Refused or unsupported: the person can still send it, and pick again.
            state.sent = false;
            fallbackText.value = text;
            fallback.hidden = false;
            setStatus('Not sent', false);
            render();
          }
          return;
        }
        if (message.method === 'ui/notifications/tool-result') {
          const result = message.params || {};
          state.data = result.structuredContent || (result.isError ? refusalOf(result.content) : null);
          state.chosen = null; state.sent = false; state.day = null;
          fallback.hidden = true;
          setStatus(result.isError ? 'Request refused' : 'Result current', !result.isError);
          render();
        }
        if (message.method === 'ui/notifications/host-context-changed') { applyHost(message.params); render(); }
      });
      if (typeof ResizeObserver === 'function') new ResizeObserver(reportSize).observe(document.documentElement);
      post({ jsonrpc: '2.0', id: state.requestId, method: 'ui/initialize', params: { appInfo: { name: 'slotlock-calendar', version: '1.1.0' }, appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] }, protocolVersion: '2026-01-26' } });
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
