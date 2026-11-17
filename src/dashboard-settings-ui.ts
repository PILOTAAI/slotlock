// The dashboard Settings pages' styles: a section list beside the page's width of cards, each a
// header (title and what it is for), rows of a label with its hint beside the control, and a foot for
// the card's action (as Vercel's and Supabase's settings are); provider tiles; the assistant's status
// card. dashboard.ts renders the pages.

export const SLOTLOCK_SETTINGS_CSS = `
.settings { display: grid; grid-template-columns: 188px minmax(0, 1fr); gap: var(--space-8) 40px; align-items: start; }
.subnav { display: grid; gap: 2px; position: sticky; top: var(--space-6); }
.subnav a { display: flex; align-items: center; gap: var(--space-2); height: 32px; padding: 0 var(--space-3); border-radius: var(--radius-sm); color: var(--ink-2); font-size: 14px; text-decoration: none; }
.subnav a:hover { background: var(--hover); color: var(--ink); }
.subnav a[aria-current="page"] { background: var(--surface); color: var(--ink); font-weight: 500; box-shadow: inset 0 0 0 1px var(--line); }
.subnav .nav-dot { width: 6px; height: 6px; border-radius: 50%; margin-left: auto; background: var(--good); }
/* Every section takes the page's width, up to a line length forms still read well at. */
.settings-body { display: grid; gap: var(--space-4); min-width: 0; max-width: 1080px; }
.settings-body > .notice { margin: 0; }
/* A section's title and its one-line lead, then its cards. */
.settings-body > h2 { margin: var(--space-6) 0 0; font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
.settings-body > h2:first-child, .settings-body > .notice + h2 { margin-top: 0; }
.settings-body > h2 + p { margin: calc(-1 * var(--space-2)) 0 0; font-size: 14px; color: var(--ink-3); }
.settings-body > h3 { margin: var(--space-2) 0 0; font: 600 14px/1.4 var(--font); color: var(--ink); text-transform: none; letter-spacing: 0; }
.settings-body > p { margin: 0; }
.section-head { display: grid; gap: 4px; }
.section-head h2, .section-head .fine { margin: 0; }
.plan-note { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); margin: 0; padding: 12px 16px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); font-size: 14px; color: var(--ink-2); }
.plan-note strong { color: var(--ink); font-weight: 600; }
.plan-note.full { border-color: color-mix(in srgb, var(--warn, #b45309) 40%, var(--line)); }
.plan-note .button { flex: none; height: 32px; }
.invite-card { display: grid; gap: var(--space-2); margin: 0; padding: 16px 20px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); }
.invite-card > label { margin: 0; color: var(--ink); }
.invite-row { display: flex; gap: var(--space-2); }
.invite-row input { flex: 1 1 auto; min-width: 0; }
.invite-row select { flex: none; width: auto; }
.invite-row button { flex: none; }
.invite-card .fine { margin: 0; }
.people-block { display: grid; gap: var(--space-2); }
.list-head { display: flex; align-items: center; gap: var(--space-2); margin: 0; font-size: 13px; font-weight: 600; color: var(--ink-3); }
.list-head .count { display: inline-grid; place-items: center; min-width: 20px; height: 20px; padding: 0 6px; border-radius: var(--radius-full); background: var(--sunken); font-size: 12px; color: var(--ink-2); }
.people { margin: 0; padding: 0; list-style: none; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); }
.person { display: grid; grid-template-columns: 32px minmax(0, 1fr) auto auto; align-items: center; gap: var(--space-3) var(--space-4); min-height: 64px; padding: 12px 16px; border-top: 1px solid var(--line-soft); }
.person:first-child { border-top: 0; }
.avatar { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 50%; background: var(--sunken); box-shadow: inset 0 0 0 1px var(--line); font-size: 13px; font-weight: 600; color: var(--ink-2); }
.avatar.invited { background: transparent; box-shadow: inset 0 0 0 1px var(--line-strong); color: var(--ink-3); }
.who { display: grid; gap: 2px; min-width: 0; }
.who .name { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 14px; font-weight: 500; color: var(--ink); overflow-wrap: anywhere; }
.who .meta { font-size: 13px; color: var(--ink-3); white-space: normal; overflow: visible; overflow-wrap: anywhere; }
.tag { display: inline-flex; align-items: center; flex: none; height: 18px; padding: 0 6px; border-radius: var(--radius-full); background: var(--sunken); font-size: 11px; font-weight: 500; color: var(--ink-2); }
.person .role form.inline { display: flex; gap: 6px; align-items: center; }
.person .role select { width: auto; height: 32px; }
.person .role button { height: 32px; }
.role-name { font-size: 13px; color: var(--ink-2); }
.person-actions { display: flex; align-items: center; justify-content: flex-end; gap: 6px; }
.person-actions.spans { grid-column: 3 / -1; }
.person-actions form.inline { display: flex; gap: 6px; align-items: center; }
.person-actions select { width: auto; height: 32px; }
.person-actions button { height: 32px; }
.card-head { margin: 0 0 calc(var(--space-2) - var(--space-6)); font-size: 13px; font-weight: 600; color: var(--ink-3); }
.set-card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-lg); box-shadow: var(--card-shadow); overflow: hidden; margin: 0; }
/* A card's own header: what the card is, and what it is for. */
.panel-head { display: grid; gap: 4px; padding: 18px 20px; }
.panel-head + .row, .panel-head + form > .row:first-of-type, .panel-head + .panel-body, .panel-head + .table { border-top: 1px solid var(--line-soft); }
.panel-head h3 { margin: 0; font: 600 15px/1.4 var(--font); color: var(--ink); text-transform: none; letter-spacing: -0.01em; }
.panel-head p { margin: 0; font-size: 13.5px; color: var(--ink-3); }
.panel-body { display: grid; gap: var(--space-3); padding: 16px 20px; }
.panel-body p { margin: 0; }
.set-card > .table, .set-card > form > .table { margin: 0; border: 0; border-radius: 0; box-shadow: none; }
/* What cannot be undone: a red hairline, and its action in a red-washed foot. */
.set-card.danger { border-color: var(--bad-line); }
.set-card.danger .card-foot { border-top-color: var(--bad-line); background: color-mix(in srgb, var(--bad-wash) 60%, var(--surface)); }
/* A label, with its hint under it, beside the control: two fifths and three fifths of the card. */
.row { display: grid; grid-template-columns: minmax(160px, 2fr) minmax(0, 3fr); gap: var(--space-2) var(--space-6); align-items: center; min-height: 60px; padding: 14px 20px; border-top: 1px solid var(--line-soft); }
fieldset.row { margin: 0; min-width: 0; border-width: 1px 0 0; border-style: solid; border-color: var(--line-soft); }
.row-hint { display: block; margin-top: 2px; font-size: 13px; font-weight: 400; color: var(--ink-3); }
.choices-inline { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-5); }
.choices-inline .choice { margin: 0; }
.row.stack { grid-template-columns: minmax(0, 1fr); gap: var(--space-3); align-items: start; padding-top: 16px; padding-bottom: 16px; }
.row:first-child, form.set-card > .row:first-of-type, .set-card > form:first-child > .row:first-of-type { border-top: 0; }
.row-label { font-size: 14px; font-weight: 500; color: var(--ink); }
.row-value { font-size: 14px; color: var(--ink); min-width: 0; overflow-wrap: anywhere; }
.row-value.muted { color: var(--ink-2); }
.row input:not([type="radio"]):not([type="checkbox"]), .row select { width: 100%; }
.mono { font-family: var(--mono); font-size: 13px; }
.card-foot { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); padding: 12px 20px; border-top: 1px solid var(--line); background: color-mix(in srgb, var(--surface) 70%, var(--canvas)); }
.card-foot .fine { margin: 0; }
.card-foot .primary { flex: none; }
.card-foot > :last-child:is(button, form) { margin-left: auto; }
.status-head { display: grid; grid-template-columns: 32px minmax(0, 1fr) auto auto; gap: var(--space-3); align-items: center; padding: 16px 20px; }
.status-head form { margin: 0; }
.mono-tile { display: grid; place-items: center; width: 32px; height: 32px; border-radius: var(--radius); background: var(--sunken); border: 1px solid var(--line); color: var(--ink); font-weight: 600; font-size: 14px; }
.status-name { display: grid; gap: 2px; min-width: 0; }
.status-name strong { font-size: 15px; font-weight: 600; color: var(--ink); }
.status-name code { color: var(--ink-3); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; background: none; padding: 0; }
.badge { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 8px; border-radius: var(--radius-full); font-size: 12px; font-weight: 500; color: var(--ink-2); background: var(--sunken); white-space: nowrap; }
.badge::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--ink-3); }
.badge.ok { color: var(--good); background: color-mix(in srgb, var(--good) 14%, transparent); }
.badge.ok::before { background: var(--good); }
.badge.bad { color: var(--bad); background: color-mix(in srgb, var(--bad) 14%, transparent); }
.badge.bad::before { background: var(--bad); }
.status-card .notice { margin: 0; border-radius: 0; border-width: 1px 0 0; box-shadow: none; font-size: 13px; padding: 10px 20px; }
.status-card .notice.done { color: var(--ink); }
.tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--space-2); }
.tile { position: relative; display: flex; align-items: center; gap: var(--space-2); height: 40px; padding: 0 10px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); font-size: 14px; color: var(--ink); cursor: pointer; transition: border-color var(--fast) var(--ease), background var(--fast) var(--ease); }
.tile:hover { background: var(--hover); }
.tile input { position: absolute; opacity: 0; pointer-events: none; }
.tile .tile-mark { display: grid; place-items: center; flex: none; width: 20px; height: 20px; border-radius: 5px; background: var(--sunken); color: var(--ink-2); font-size: 11px; font-weight: 600; }
.tile:has(input:checked) { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.tile:has(input:checked) .tile-mark { background: var(--accent); color: var(--surface); }
.tile:has(input:focus-visible) { box-shadow: 0 0 0 3px var(--ring); }
.provider-form:not(:has(input[name="preset"][value="custom"]:checked)) .custom-only { display: none; }
.segmented { justify-self: start; display: inline-flex; padding: 2px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--sunken); gap: 2px; }
.segmented label { position: relative; display: inline-flex; align-items: center; height: 30px; padding: 0 12px; border-radius: 6px; font-size: 13px; color: var(--ink-2); cursor: pointer; }
.segmented input { position: absolute; opacity: 0; pointer-events: none; }
.segmented label:has(input:checked) { background: var(--surface); color: var(--ink); box-shadow: 0 0 0 1px var(--line); }
.field-with-button { display: flex; gap: var(--space-2); align-items: center; }
.field-with-button input { flex: 1; min-width: 0; }
.field-with-button button { flex: none; }
.row .field-with-button select { flex: none; width: auto; }
.key-set { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.key-set code { background: none; padding: 0; color: var(--ink-2); letter-spacing: 0.04em; }
.key-set details { display: contents; }
.key-set details > summary { list-style: none; cursor: pointer; color: var(--accent); font-size: 13px; }
.key-set details > summary::-webkit-details-marker { display: none; }
.key-set details[open] > summary { display: none; }
.key-set details[open] input { flex-basis: 100%; }
/* Single sign-on (Identity): the issuer row names what the chosen provider takes, and Google
   Workspace, whose issuer is fixed, has none. */
.sso-form .for-entra { display: none; }
.sso-form:has(#sso-kind option[value="entra"]:checked) .for-entra { display: inline; }
.sso-form:has(#sso-kind option[value="entra"]:checked) .for-issuer { display: none; }
.sso-form:has(#sso-kind option[value="google_workspace"]:checked) .sso-issuer { display: none; }
.row .choice { margin: 0; }
.row .unit-input { max-width: 180px; }
.row-value > form.inline:has(select) { display: flex; gap: var(--space-2); align-items: center; }
.row-value > form.inline:has(select) button { flex: none; }
.danger-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); padding: 14px 20px; }
.danger-row strong { font-size: 14px; font-weight: 500; color: var(--ink); }
.danger-row details.act > summary { color: var(--bad); }
@media (max-width: 760px) {
  .settings { grid-template-columns: minmax(0, 1fr); gap: var(--space-4); }
  .subnav { position: static; display: flex; overflow-x: auto; gap: 0; border-bottom: 1px solid var(--line); scrollbar-width: none; }
  .subnav::-webkit-scrollbar { display: none; }
  .subnav a { height: 40px; border-radius: 0; flex: none; }
  .subnav a[aria-current="page"] { background: none; box-shadow: inset 0 -2px 0 var(--accent); }
  .row { grid-template-columns: minmax(0, 1fr); gap: var(--space-2); padding: 12px 16px; }
  .panel-head, .panel-body { padding-left: 16px; padding-right: 16px; }
  .person { grid-template-columns: 32px minmax(0, 1fr); }
  .person .role, .person-actions, .person-actions.spans { grid-column: 2; justify-content: flex-start; flex-wrap: wrap; }
  .invite-row { flex-wrap: wrap; }
  .row .field-with-button:has(select) { flex-wrap: wrap; }
  .row .field-with-button:has(select) input { flex-basis: 100%; }
  .invite-row input { flex-basis: 100%; }
  .plan-note { flex-direction: column; align-items: flex-start; }
  .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .status-head { grid-template-columns: 32px minmax(0, 1fr) auto; padding: 14px 16px; }
  .status-head form { grid-column: 1 / -1; }
  .card-foot { flex-direction: column; align-items: stretch; padding: 12px 16px; }
  .card-foot .primary { height: 44px; }
  .card-foot > :last-child:is(button, form) { margin-left: 0; }
}
`;
