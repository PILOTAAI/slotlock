// Progressive enhancement only: the page is complete without it.

const THEME_KEY = 'starlight-theme';
type Choice = 'system' | 'light' | 'dark';

function readChoice(): Choice {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

function applyChoice(choice: Choice): void {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
  try {
    // Starlight stores '' for "follow the system".
    localStorage.setItem(THEME_KEY, choice === 'system' ? '' : choice);
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
  for (const label of document.querySelectorAll<HTMLElement>('[data-theme-label]')) {
    label.textContent = `Theme: ${choice}`;
  }
}

const toggle = document.querySelector<HTMLButtonElement>('[data-theme-toggle]');
if (toggle) {
  const order: Choice[] = ['system', 'light', 'dark'];
  let choice = readChoice();
  applyChoice(choice);
  toggle.hidden = false;
  toggle.addEventListener('click', () => {
    choice = order[(order.indexOf(choice) + 1) % order.length] ?? 'system';
    applyChoice(choice);
  });
}

async function copy(button: HTMLButtonElement, text: string): Promise<void> {
  const label = button.querySelector('span');
  try {
    await navigator.clipboard.writeText(text);
    if (label) label.textContent = 'Copied';
  } catch {
    if (label) label.textContent = 'Select and copy';
  }
  window.setTimeout(() => {
    if (label) label.textContent = 'Copy';
  }, 1600);
}

if (navigator.clipboard) {
  const install = document.querySelector<HTMLButtonElement>('[data-copy-install]');
  if (install) {
    install.hidden = false;
    install.addEventListener('click', () => {
      const target = document.querySelector<HTMLInputElement>('input[name="install"]:checked');
      const id = target?.id.replace('install-', '') ?? 'source';
      const command = document.getElementById(`cmd-${id}`)?.textContent?.trim() ?? '';
      void copy(install, command);
    });
  }

  const tab = document.querySelector<HTMLButtonElement>('[data-copy-tab]');
  if (tab) {
    tab.hidden = false;
    tab.addEventListener('click', () => {
      const checked = document.querySelector<HTMLInputElement>('input[name="dev"]:checked');
      const panel = checked?.id.replace('dev-', '') ?? 'mcp';
      const text = document.querySelector(`[data-panel="${panel}"]`)?.textContent ?? '';
      void copy(tab, text.trim());
    });
  }
}
