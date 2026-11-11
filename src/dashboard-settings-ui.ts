// The dashboard Settings pages' styles: a section list beside one column of cards, label-left rows,
// provider tiles, and the assistant's status card. dashboard.ts renders the pages.

export const SLOTLOCK_SETTINGS_CSS = `
.settings { display: grid; grid-template-columns: 176px minmax(0, 640px); gap: var(--space-8); align-items: start; }
.subnav { display: grid; gap: 2px; position: sticky; top: var(--space-6); }
.subnav a { display: flex; align-items: center; gap: var(--space-2); height: 32px; padding: 0 var(--space-3); border-radius: var(--radius-sm); color: var(--ink-2); font-size: 14px; text-decoration: none; }
.subnav a:hover { background: var(--hover); color: var(--ink); }
.subnav a[aria-current="page"] { background: var(--surface); color: var(--ink); font-weight: 500; box-shadow: inset 0 0 0 1px var(--line); }
.subnav .nav-dot { width: 6px; height: 6px; border-radius: 50%; margin-left: auto; background: var(--good); }
.settings-body { display: grid; gap: var(--space-6); min-width: 0; }
.settings-body > .notice { margin: 0; }
.card-head { margin: 0 0 calc(var(--space-2) - var(--space-6)); font-size: 13px; font-weight: 600; color: var(--ink-3); }
.set-card { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; margin: 0; }
.row { display: grid; grid-template-columns: minmax(120px, 160px) minmax(0, 1fr); gap: var(--space-4); align-items: center; min-height: 56px; padding: 12px 20px; border-top: 1px solid var(--line-soft); }
.row.stack { grid-template-columns: minmax(0, 1fr); gap: var(--space-3); align-items: start; padding-top: 16px; padding-bottom: 16px; }
.row:first-child { border-top: 0; }
.row-label { font-size: 14px; font-weight: 500; color: var(--ink); }
.row-value { font-size: 14px; color: var(--ink); min-width: 0; overflow-wrap: anywhere; }
.row-value.muted { color: var(--ink-2); }
.row input:not([type="radio"]):not([type="checkbox"]), .row select { width: 100%; }
.mono { font-family: var(--mono); font-size: 13px; }
.card-foot { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); padding: 12px 20px; border-top: 1px solid var(--line); background: color-mix(in srgb, var(--surface) 70%, var(--canvas)); }
.card-foot .fine { margin: 0; }
.card-foot .primary { flex: none; }
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
.key-set { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.key-set code { background: none; padding: 0; color: var(--ink-2); letter-spacing: 0.04em; }
.key-set details { display: contents; }
.key-set details > summary { list-style: none; cursor: pointer; color: var(--accent); font-size: 13px; }
.key-set details > summary::-webkit-details-marker { display: none; }
.key-set details[open] > summary { display: none; }
.key-set details[open] input { flex-basis: 100%; }
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
  .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .status-head { grid-template-columns: 32px minmax(0, 1fr) auto; padding: 14px 16px; }
  .status-head form { grid-column: 1 / -1; }
  .card-foot { flex-direction: column; align-items: stretch; padding: 12px 16px; }
  .card-foot .primary { height: 44px; }
}
`;
