// The dashboard assistant's words, styles and browser script: how a tool step and a proposed change
// are named, the chat's CSS, and the script that streams a reply into the page. dashboard.ts renders
// the page; this keeps the chat's presentation in one place.

/** How a step reads while it runs, once it has, and when it could not. */
export type SlotlockAssistantStepState = 'run' | 'ok' | 'bad';

const STEP_WORDS: Readonly<Record<string, readonly [string, string, string]>> = Object.freeze({
  slotlock_list_resources: ['Reading resources', 'Read resources', 'read resources'],
  slotlock_get_free_busy: ['Checking free and busy time', 'Checked free and busy time', 'check free and busy time'],
  slotlock_find_next_available: ['Finding the next free time', 'Found the next free time', 'find the next free time'],
  slotlock_find_available_slots: ['Checking availability', 'Checked availability', 'check availability'],
  slotlock_find_available_ranges: ['Finding free ranges', 'Found free ranges', 'find free ranges'],
  slotlock_get_pool_availability: ['Checking the pool', 'Checked the pool', 'check the pool'],
  slotlock_get_event: ['Reading a booking', 'Read a booking', 'read the booking'],
  slotlock_list_events: ['Reading bookings', 'Read bookings', 'read bookings'],
});

/** A tool step in plain words: "Checking availability…", "Checked availability", "Couldn't check availability". */
export function slotlockAssistantStepLabel(name: string, title: string, state: SlotlockAssistantStepState, write = false): string {
  const words = STEP_WORDS[name];
  if (write) {
    if (state === 'run') return 'Preparing a change…';
    if (state === 'ok') return 'Prepared a change for you to approve';
    return "Couldn't prepare the change";
  }
  if (words) return state === 'run' ? `${words[0]}…` : state === 'ok' ? words[1] : `Couldn't ${words[2]}`;
  const lower = title.charAt(0).toLowerCase() + title.slice(1);
  return state === 'run' ? `${title}…` : state === 'ok' ? title : `Couldn't ${lower}`;
}

/** The verb a proposed change's card is approved with, and whether it removes something. */
export function slotlockAssistantActionVerb(operation: string): { verb: string; busy: string; done: string; danger: boolean } {
  switch (operation) {
    case 'slotlock_create_event':
    case 'slotlock_book_pool':
    case 'slotlock_book_together':
      return { verb: 'Book', busy: 'Booking…', done: 'Booked', danger: false };
    case 'slotlock_confirm_slot':
      return { verb: 'Book', busy: 'Booking…', done: 'Booked', danger: false };
    case 'slotlock_reschedule':
      return { verb: 'Move', busy: 'Moving…', done: 'Moved', danger: false };
    case 'slotlock_update_event':
      return { verb: 'Change', busy: 'Changing…', done: 'Changed', danger: false };
    case 'slotlock_cancel':
      return { verb: 'Cancel booking', busy: 'Cancelling…', done: 'Cancelled', danger: true };
    case 'slotlock_delete_event':
      return { verb: 'Delete booking', busy: 'Deleting…', done: 'Deleted', danger: true };
    case 'slotlock_hold_slots':
    case 'slotlock_hold_together':
      return { verb: 'Hold', busy: 'Holding…', done: 'Held', danger: false };
    case 'slotlock_release_slots':
      return { verb: 'Release', busy: 'Releasing…', done: 'Released', danger: true };
    default:
      return { verb: 'Approve', busy: 'Running…', done: 'Done', danger: false };
  }
}

/** The chat's styles: one centred column, the composer docked under it, quiet steps and cards. */
export const SLOTLOCK_ASSISTANT_CSS = `
.assistant-page { display: grid; }
.assistant { position: relative; display: flex; flex-direction: column; width: min(100%, 720px); margin: 0 auto; min-height: calc(100dvh - 180px); }
.assistant .thread { flex: 1; }
.assistant[data-empty] { justify-content: center; padding-bottom: 12vh; }
.assistant[data-empty] .thread { display: none; }
.assistant[data-empty] .dock { order: 1; position: static; padding: 0; background: none; }
.assistant[data-empty] .assistant-start { order: 2; padding-top: var(--space-3); }
.assistant:not([data-empty]) .assistant-start { display: none; }
.chips { display: flex; flex-wrap: wrap; justify-content: center; gap: var(--space-2); }
.chips form { margin: 0; }
.chip { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 var(--space-3); border-radius: var(--radius-full); border: 1px solid var(--line); background: var(--surface); color: var(--ink-2); font: inherit; font-size: var(--text-md); cursor: pointer; transition: background var(--fast) var(--ease), border-color var(--fast) var(--ease); }
.chip:hover { background: var(--hover); border-color: var(--line-strong); color: var(--ink); }
.thread { list-style: none; margin: 0; padding: var(--space-2) 0 var(--space-6); display: grid; gap: var(--space-6); align-content: start; }
.turn { margin: 0; min-width: 0; }
.turn.mine { justify-self: end; max-width: 80%; }
.bubble { padding: 10px 14px; border-radius: 18px; background: var(--sunken); color: var(--ink); font-size: var(--text-lg); line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.turn.bot { justify-self: stretch; }
.prose { max-width: 68ch; color: var(--ink); font-size: var(--text-lg); line-height: 1.6; overflow-wrap: anywhere; }
.prose > :first-child { margin-top: 0; }
.prose > :last-child { margin-bottom: 0; }
.prose p { margin: 0 0 var(--space-3); color: inherit; }
.prose strong { font-weight: 600; }
.prose h4 { margin: var(--space-4) 0 var(--space-2); font-size: var(--text-lg); font-weight: 600; }
.prose ul, .prose ol { margin: 0 0 var(--space-3); padding-left: 20px; }
.prose li { margin: 4px 0; }
.prose li > ul, .prose li > ol { margin: 4px 0 0; }
.prose a { color: var(--accent); text-underline-offset: 2px; }
.prose code { font: 400 12.5px/1.4 var(--mono); background: var(--sunken); border-radius: 4px; padding: 1px 5px; }
.prose pre { margin: 0 0 var(--space-3); padding: var(--space-3); background: var(--sunken); border: 1px solid var(--line); border-radius: var(--radius); overflow-x: auto; }
.prose pre code { background: none; padding: 0; font-size: 12.5px; }
.prose blockquote { margin: 0 0 var(--space-3); padding-left: var(--space-3); border-left: 2px solid var(--line-strong); color: var(--ink-2); }
.prose hr { border: 0; border-top: 1px solid var(--line); margin: var(--space-4) 0; }
.md-table { overflow-x: auto; margin: 0 0 var(--space-3); }
.md-table table { border-collapse: collapse; font-size: var(--text-md); min-width: 50%; }
.md-table table { width: auto; }
.md-table th { font: 600 var(--text-md)/1.4 var(--font); text-transform: none; letter-spacing: 0; background: none; text-align: left; color: var(--ink-2); padding: 6px 16px 6px 0; border-bottom: 1px solid var(--line); white-space: nowrap; }
.md-table td { padding: 6px 16px 6px 0; border-bottom: 1px solid var(--line-soft); vertical-align: top; }
.md-table tr:last-child td { border-bottom: 0; }
.change details.more { margin: 0; }
.change details.more > summary { cursor: pointer; color: var(--ink-3); font-size: var(--text-sm); list-style: none; }
.change details.more > summary::-webkit-details-marker { display: none; }
.change details.more > summary:hover { color: var(--ink-2); }
.change details.more[open] > summary { margin-bottom: var(--space-2); }
.turn.steps { justify-self: start; }
details.steps > summary { list-style: none; display: inline-flex; align-items: center; gap: 6px; cursor: pointer; color: var(--ink-3); font-size: var(--text-md); padding: 2px 0; }
details.steps > summary::-webkit-details-marker { display: none; }
details.steps > summary::after { content: ""; width: 6px; height: 6px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: rotate(-45deg); transition: transform var(--fast) var(--ease); margin-left: 2px; }
details.steps[open] > summary::after { transform: rotate(45deg); }
details.steps > summary:hover { color: var(--ink-2); }
details.steps.has-bad > summary::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--bad); }
.step-list { list-style: none; margin: var(--space-2) 0 0; padding: 0 0 0 var(--space-3); border-left: 1px solid var(--line); display: grid; gap: 6px; }
.step { display: flex; align-items: baseline; gap: var(--space-2); font-size: var(--text-md); color: var(--ink-2); }
.step::before { content: ""; flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--good); transform: translateY(-1px); }
.step.bad::before { background: var(--bad); }
.step.run::before { background: var(--ink-3); }
.step .why { color: var(--ink-3); font-size: var(--text-sm); }
.live-steps { display: grid; gap: 6px; }
.live-steps .step.run, .thinking { background: linear-gradient(90deg, var(--ink-3) 0%, var(--ink) 50%, var(--ink-3) 100%); background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; animation: assistant-shimmer 1.6s linear infinite; }
.thinking { font-size: var(--text-md); justify-self: start; }
@keyframes assistant-shimmer { from { background-position: 100% 0; } to { background-position: -100% 0; } }
.prose.streaming > :last-child::after { content: ""; display: inline-block; width: 8px; height: 8px; margin-left: 4px; border-radius: 50%; background: var(--ink-3); vertical-align: baseline; animation: assistant-pulse 1s ease-in-out infinite; }
@keyframes assistant-pulse { 50% { opacity: 0.25; } }
.turn.note { color: var(--ink-3); font-size: var(--text-md); }
.turn.error { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: 10px 12px; border: 1px solid var(--bad-line); background: var(--bad-wash); border-radius: var(--radius); font-size: var(--text-md); color: var(--ink); }
.turn.error::before { content: ""; flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--bad); }
.turn.error > span { flex: 1; }
.turn.error form, .turn.note form { margin: 0; }
.text-button { appearance: none; border: 0; background: none; padding: 0; font: inherit; font-size: var(--text-md); color: var(--accent); cursor: pointer; }
.text-button:hover { text-decoration: underline; text-underline-offset: 2px; }
.turn.action { justify-self: start; width: min(100%, 560px); }
.change { padding: var(--space-4) var(--space-5); background: var(--surface); border: 1px solid var(--line-strong); border-radius: var(--radius-lg); display: grid; gap: var(--space-3); }
.change-title { margin: 0; font-size: var(--text-lg); font-weight: 600; color: var(--ink); overflow-wrap: anywhere; }
.change .facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px var(--space-4); margin: 0; font-size: var(--text-md); }
.change .facts dt { color: var(--ink-3); font-size: var(--text-sm); padding-top: 1px; }
.change .facts dd { margin: 0; color: var(--ink); overflow-wrap: anywhere; }
.change .facts dd pre { margin: 0; white-space: pre-wrap; font: 400 12px/1.5 var(--mono); }
.change .facts .was { color: var(--ink-3); text-decoration: line-through; }
.change-buttons { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.change-buttons form { margin: 0; }
.change-buttons button { height: 32px; }
button.danger { background: var(--bad); color: var(--bad-ink); border-color: var(--bad); }
button.danger:hover { filter: brightness(1.08); }
button.ghost { background: transparent; border-color: transparent; color: var(--ink-2); }
button.ghost:hover { background: var(--hover); color: var(--ink); }
.receipt { margin: 0; display: flex; align-items: baseline; gap: var(--space-2); font-size: var(--text-md); color: var(--ink-2); }
.receipt::before { content: ""; flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--ink-3); transform: translateY(-1px); }
.receipt.ok { color: var(--ink); }
.receipt.ok::before { background: var(--good); }
.receipt.bad::before { background: var(--bad); }
.receipt .why { color: var(--ink-3); }
.dock { position: sticky; bottom: 0; padding: var(--space-6) 0 var(--space-6); background: linear-gradient(to bottom, transparent, var(--canvas) 24px); z-index: 2; }
.composer { display: grid; margin: 0; background: var(--surface); border: 1px solid var(--line); border-radius: 16px; transition: border-color var(--fast) var(--ease), box-shadow var(--fast) var(--ease); }
.composer:focus-within { border-color: var(--line-strong); box-shadow: 0 0 0 3px var(--ring); }
.composer textarea { display: block; width: 100%; min-height: 26px; max-height: 200px; resize: none; border: 0; outline: 0; background: transparent; padding: 14px 16px 0; color: var(--ink); font: inherit; font-size: var(--text-lg); line-height: 1.5; box-shadow: none; }
.composer textarea:focus { box-shadow: none; border: 0; }
.composer-bar { display: flex; align-items: center; justify-content: flex-end; gap: var(--space-2); padding: var(--space-2); }
.composer-bar .count { margin-right: auto; padding-left: var(--space-2); font-size: var(--text-sm); color: var(--ink-3); }
.composer-bar .count.over { color: var(--warn); }
.send { display: inline-grid; place-items: center; width: 32px; height: 32px; padding: 0; border-radius: 50%; border: 0; background: var(--button); color: var(--button-ink); cursor: pointer; transition: opacity var(--fast) var(--ease), background var(--fast) var(--ease); }
.send:hover { background: var(--button-hover); }
.send:disabled { opacity: 0.4; cursor: default; }
.send svg { width: 16px; height: 16px; }
.send .stop { display: none; }
.assistant.streaming .send .arrow { display: none; }
.assistant.streaming .send .stop { display: block; }
.jump { position: absolute; left: 50%; transform: translate(-50%, 0); top: -8px; width: 32px; height: 32px; padding: 0; border-radius: 50%; border: 1px solid var(--line); background: var(--surface); color: var(--ink-2); display: grid; place-items: center; cursor: pointer; box-shadow: var(--pop-shadow); }
.jump[hidden] { display: none; }
.new-chat svg { width: 14px; height: 14px; }
.assistant-page[data-empty] .new-chat { display: none; }
@media (prefers-reduced-motion: reduce) {
  .live-steps .step.run, .thinking { animation: none; color: var(--ink-3); background: none; }
  .prose.streaming > :last-child::after { animation: none; }
}
@media (max-width: 760px) {
  .assistant { min-height: calc(100dvh - 140px); }
  .assistant[data-empty] { justify-content: flex-end; padding-bottom: 0; }
  .assistant[data-empty] .assistant-start { order: 1; padding: 0 0 var(--space-3); }
  .assistant[data-empty] .dock { order: 2; position: sticky; padding-bottom: max(12px, env(safe-area-inset-bottom)); }
  .chips { flex-wrap: nowrap; justify-content: flex-start; overflow-x: auto; max-width: 100%; padding-bottom: 2px; scrollbar-width: none; }
  .chips::-webkit-scrollbar { display: none; }
  .chip { flex: none; }
  .turn.mine { max-width: 88%; }
  .md-table table { display: table; }
  .md-table thead { display: table-header-group; }
  .md-table tbody { display: table-row-group; }
  .md-table tr { display: table-row; padding: 0; border: 0; }
  .md-table th, .md-table td { display: table-cell; padding: 6px 12px 6px 0; }
  .md-table td { border-bottom: 1px solid var(--line-soft); }
  .composer textarea { font-size: 16px; }
  .dock { padding-bottom: max(12px, env(safe-area-inset-bottom)); }
  .change { padding: var(--space-4); }
  .change .facts { grid-template-columns: minmax(0, 1fr); gap: 2px; }
  .change .facts dd { margin-bottom: var(--space-2); }
  .change-buttons form { flex: 1; }
  .change-buttons button { width: 100%; height: 40px; }
}
`;

/**
 * The browser side of the chat, appended to app.js: Enter sends, the box grows, a write chip fills
 * the box instead of sending, and a reply streams in from `<root>/assistant/stream` (newline-
 * delimited JSON: text deltas, steps, then the turn as the server renders it). Without it the
 * page still works: every form posts and the page reloads at the latest message.
 * `markdownSource` is renderSlotlockMarkdown's source, so a reply renders as it will once stored.
 */
export function slotlockAssistantScript(markdownSource: string): string {
  return `
(function () {
  var page = document.querySelector('[data-assistant]');
  if (!page || typeof fetch !== 'function' || typeof TextDecoder !== 'function') return;
  var __name = function (fn) { return fn; };
  var renderMarkdown = (${markdownSource});
  var form = page.querySelector('form.composer');
  var box = form ? form.querySelector('textarea') : null;
  var send = form ? form.querySelector('button.send') : null;
  var thread = page.querySelector('ol.thread');
  var jump = page.querySelector('button.jump');
  var count = form ? form.querySelector('.count') : null;
  var shell = document.querySelector('.assistant-page');
  if (!form || !box || !send || !thread) return;
  var max = Number(box.getAttribute('maxlength')) || 2000;
  // Two rows without script; one that grows with it.
  box.setAttribute('rows', '1');
  var busy = null;

  function grow() {
    box.style.height = 'auto';
    box.style.height = Math.min(box.scrollHeight, 200) + 'px';
  }
  function update() {
    if (!busy) send.disabled = box.value.trim() === '';
    if (count) {
      var left = box.value.length;
      count.hidden = left < max - 200;
      count.textContent = left + ' / ' + max;
      count.classList.toggle('over', left >= max);
    }
  }
  function nearBottom() {
    return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 80;
  }
  function follow(was) {
    if (was) window.scrollTo(0, document.documentElement.scrollHeight);
    else if (jump) jump.hidden = false;
  }
  if (jump) {
    jump.addEventListener('click', function () {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
      jump.hidden = true;
    });
    window.addEventListener('scroll', function () { if (nearBottom()) jump.hidden = true; }, { passive: true });
  }
  function item(className) {
    var li = document.createElement('li');
    li.className = 'turn ' + className;
    thread.appendChild(li);
    return li;
  }
  function setOnce(value) {
    if (!value) return;
    var field = form.querySelector('input[name="once"]');
    if (field) field.value = value;
  }
  function stopped(reason) {
    page.classList.remove('streaming');
    send.setAttribute('aria-label', 'Send');
    busy = null;
    update();
  }

  box.addEventListener('input', function () { grow(); update(); });
  box.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!busy && box.value.trim() !== '') form.requestSubmit();
  });
  for (var chip of page.querySelectorAll('button[data-fill]')) {
    chip.addEventListener('click', function (event) {
      event.preventDefault();
      box.value = this.getAttribute('data-fill') || '';
      grow();
      update();
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    });
  }
  for (var decide of document.querySelectorAll('.change-buttons form')) {
    decide.addEventListener('submit', function () {
      var buttons = this.closest('.change-buttons').querySelectorAll('button');
      for (var b of buttons) b.disabled = true;
      var own = this.querySelector('button');
      if (own && own.getAttribute('data-busy')) own.textContent = own.getAttribute('data-busy');
    });
  }

  send.addEventListener('click', function (event) {
    if (!busy) return;
    event.preventDefault();
    busy.abort();
  });

  form.addEventListener('submit', function (event) {
    var text = box.value.trim();
    if (busy || text === '') { event.preventDefault(); return; }
    event.preventDefault();
    var controller = new AbortController();
    busy = controller;
    var body = new URLSearchParams(new FormData(form));
    body.set('message', text);
    if (page.hasAttribute('data-empty')) {
      page.removeAttribute('data-empty');
      if (shell) shell.removeAttribute('data-empty');
    }
    page.classList.add('streaming');
    send.disabled = false;
    send.setAttribute('aria-label', 'Stop');
    var was = true;
    var mine = item('mine');
    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    mine.appendChild(bubble);
    box.value = '';
    box.setAttribute('placeholder', 'Reply…');
    grow();
    var added = [mine];
    var thinking = item('note thinking');
    thinking.textContent = 'Thinking';
    added.push(thinking);
    var prose = null;
    var proseText = '';
    var steps = null;
    var stepNodes = {};
    var frame = 0;
    follow(was);
    function draw() {
      frame = 0;
      if (prose) prose.innerHTML = renderMarkdown(proseText);
    }
    function clearThinking() {
      if (thinking && thinking.parentNode) thinking.parentNode.removeChild(thinking);
      thinking = null;
    }
    function onEvent(e) {
      was = nearBottom();
      if (e.t === 'text') {
        clearThinking();
        if (!prose) {
          var li = item('bot');
          added.push(li);
          prose = document.createElement('div');
          prose.className = 'prose streaming';
          li.appendChild(prose);
          proseText = '';
          steps = null;
        }
        proseText += e.d;
        if (!frame) frame = requestAnimationFrame(draw);
      } else if (e.t === 'step') {
        clearThinking();
        if (prose) { if (frame) { cancelAnimationFrame(frame); draw(); } prose.classList.remove('streaming'); prose = null; }
        if (!steps) {
          var holder = item('steps');
          added.push(holder);
          steps = document.createElement('div');
          steps.className = 'live-steps';
          holder.appendChild(steps);
        }
        var node = stepNodes[e.id];
        if (!node) {
          node = document.createElement('div');
          stepNodes[e.id] = node;
          steps.appendChild(node);
        }
        node.className = 'step ' + e.s;
        node.textContent = e.label;
      } else if (e.t === 'done' || e.t === 'error') {
        clearThinking();
        if (frame) cancelAnimationFrame(frame);
        for (var n of added) if (n.parentNode) n.parentNode.removeChild(n);
        added = [];
        thread.insertAdjacentHTML('beforeend', e.html || '');
        setOnce(e.once);
      }
      follow(was);
    }
    fetch(page.getAttribute('data-stream'), {
      method: 'POST',
      body: body,
      headers: { accept: 'application/x-ndjson' },
      credentials: 'same-origin',
      signal: controller.signal,
    }).then(function (response) {
      var type = response.headers.get('content-type') || '';
      if (!response.body || type.indexOf('application/x-ndjson') !== 0) {
        location.assign(page.getAttribute('data-page') + '#latest');
        location.reload();
        return;
      }
      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      function pump() {
        return reader.read().then(function (chunk) {
          if (chunk.done) {
            if (buffer.trim()) onEvent(JSON.parse(buffer));
            stopped();
            return;
          }
          buffer += decoder.decode(chunk.value, { stream: true });
          var lines = buffer.split('\\n');
          buffer = lines.pop() || '';
          for (var line of lines) if (line.trim()) onEvent(JSON.parse(line));
          return pump();
        });
      }
      return pump();
    }).catch(function () {
      clearThinking();
      if (controller.signal.aborted) {
        if (prose) prose.classList.remove('streaming');
        var note = item('note');
        note.textContent = 'Stopped';
        stopped();
        // The server keeps what it had; the page it renders next has a fresh form.
        setTimeout(function () { location.assign(page.getAttribute('data-page') + '#latest'); location.reload(); }, 900);
        return;
      }
      for (var n of added) if (n.parentNode && n !== mine) n.parentNode.removeChild(n);
      if (mine.parentNode) mine.parentNode.removeChild(mine);
      box.value = text;
      grow();
      var fail = item('error');
      var why = document.createElement('span');
      why.textContent = "Couldn't send. Check the connection and try again.";
      fail.appendChild(why);
      stopped();
    });
  });
  grow();
  update();
  if (location.hash === '#latest' || !page.hasAttribute('data-empty')) window.scrollTo(0, document.documentElement.scrollHeight);
})();
`;
}
