// Hosted Slotlock's public status (PROD-4): scripts/status-probe.sh checks the API's /healthz and the
// dashboard from GitHub's runners and keeps one `status` issue open per part that is down.
// curl and gh are stand-ins: curl answers each URL from STUB_<API|DASHBOARD>_CODE and _BODY, gh
// keeps its issues in a JSON file.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const hasJq = spawnSync('jq', ['--version']).status === 0;
const scratch: string[] = [];
afterAll(() => {
  for (const path of scratch) rmSync(path, { recursive: true, force: true });
});

interface Issue {
  number: number;
  title: string;
  state: 'open' | 'closed';
}

function probe(
  answers: { api?: [string, string]; dashboard?: [string, string] },
  issues: Issue[] = [],
) {
  const dir = mkdtempSync(join(tmpdir(), 'slotlock-status-'));
  scratch.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(dir, 'issues.json'), JSON.stringify(issues));
  // curl --output FILE --write-out '%{http_code}' URL; code 000 means no answer (curl exits 7).
  writeFileSync(
    join(bin, 'curl'),
    `#!/bin/sh
echo "$*" >> "${dir}/curl.log"
for a; do url=$a; done
while [ "$#" -gt 0 ]; do [ "$1" = --output ] && out=$2; shift; done
case $url in
*/healthz) code=$STUB_API_CODE body=$STUB_API_BODY ;;
*) code=$STUB_DASHBOARD_CODE body=$STUB_DASHBOARD_BODY ;;
esac
printf '%s' "$body" > "$out"
[ "$code" = 000 ] && { echo "curl: (7) Failed to connect" >&2; exit 7; }
printf '%s' "$code"
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh
echo "$*" >> "${dir}/gh.log"
store="${dir}/issues.json"
case "$1 $2" in
"issue list") jq '[.[] | select(.state == "open") | {number, title}]' "$store" ;;
"label create") ;;
"issue create")
  while [ "$#" -gt 0 ]; do [ "$1" = --title ] && title=$2; shift; done
  jq --arg title "$title" '. + [{number: (length + 100), title: $title, state: "open"}]' "$store" > "$store.new" && mv "$store.new" "$store" ;;
"issue close") jq --argjson n "$3" 'map(if .number == $n then .state = "closed" else . end)' "$store" > "$store.new" && mv "$store.new" "$store" ;;
*) echo "unexpected gh $*" >&2; exit 9 ;;
esac
`,
    { mode: 0o755 },
  );
  const ready: [string, string] = [
    '200',
    '{"status":"ready","version":"0.3.0","checks":["database"]}',
  ];
  const [apiCode, apiBody] = answers.api ?? ready;
  const [dashboardCode, dashboardBody] = answers.dashboard ?? ['200', '<!doctype html>'];
  const result = spawnSync('sh', [join(root, 'scripts', 'status-probe.sh')], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      GITHUB_REPOSITORY: 'PILOTAAI/slotlock',
      SLOTLOCK_STATUS_RETRY_SECONDS: '0',
      STUB_API_CODE: apiCode,
      STUB_API_BODY: apiBody,
      STUB_DASHBOARD_CODE: dashboardCode,
      STUB_DASHBOARD_BODY: dashboardBody,
    },
  });
  const log = (name: string) => {
    try {
      return readFileSync(join(dir, name), 'utf8');
    } catch {
      return '';
    }
  };
  const after = JSON.parse(readFileSync(join(dir, 'issues.json'), 'utf8')) as Issue[];
  return { ...result, log, issues: after };
}

describe.skipIf(!hasJq)('scripts/status-probe.sh', () => {
  it('checks the API health and the dashboard, and opens nothing while both are up', () => {
    const result = probe({});
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.log('curl.log')).toContain('https://slotlock-api.pylota.io/healthz');
    expect(result.log('curl.log')).toContain('https://app.slotlock.pylota.io/dashboard');
    expect(result.issues).toEqual([]);
    expect(result.log('gh.log')).not.toContain('issue create');
  });

  it('opens one issue for a part that fails three checks, and none twice', () => {
    const down = probe({
      api: ['503', '{"status":"not_ready","checks":["database_unreachable"]}'],
    });
    expect(down.status, down.stderr).toBe(0);
    expect(down.log('curl.log').match(/healthz/g)).toHaveLength(3);
    expect(down.issues).toEqual([
      { number: 100, title: 'Hosted Slotlock API is down', state: 'open' },
    ]);
    expect(down.log('gh.log')).toMatch(
      /issue create --repo PILOTAAI\/slotlock --label status --title Hosted Slotlock API is down --body .*HTTP 503/,
    );
    // Still down at the next run: the open issue stands, nothing new.
    const again = probe({ api: ['000', ''] }, down.issues);
    expect(again.issues).toEqual(down.issues);
    expect(again.stdout).toContain(
      'api: down (https://slotlock-api.pylota.io/healthz: no answer: curl: (7) Failed to connect)',
    );
  });

  it('counts a 200 that is not ready as down', () => {
    const result = probe({ api: ['200', '{"status":"not_ready"}'] });
    expect(result.issues.map(({ title }) => title)).toEqual(['Hosted Slotlock API is down']);
  });

  it('closes the issue once the part answers again, leaving the other part alone', () => {
    const open: Issue[] = [
      { number: 7, title: 'Hosted Slotlock API is down', state: 'open' },
      { number: 8, title: 'Hosted Slotlock dashboard is down', state: 'open' },
    ];
    const result = probe({ dashboard: ['502', 'Bad gateway'] }, open);
    expect(result.status, result.stderr).toBe(0);
    expect(result.issues).toEqual([
      { number: 7, title: 'Hosted Slotlock API is down', state: 'closed' },
      { number: 8, title: 'Hosted Slotlock dashboard is down', state: 'open' },
    ]);
    expect(result.log('gh.log')).toContain(
      'issue close 7 --repo PILOTAAI/slotlock --comment Up again',
    );
  });
});

describe('the status workflow', () => {
  it('runs the probe on a schedule only once the owner turns it on, with issues: write alone', () => {
    const workflow = readFileSync(join(root, '.github', 'workflows', 'status.yml'), 'utf8');
    expect(workflow).toMatch(/schedule:\n\s+- cron: '7-59\/10 \* \* \* \*'/);
    expect(workflow).toContain("if: vars.SLOTLOCK_STATUS_PROBE == 'on'");
    expect(workflow).toMatch(/^permissions: \{\}$/m);
    expect(workflow).toMatch(/permissions:\n\s+contents: read\n\s+issues: write\n/);
    expect(workflow).toContain('run: scripts/status-probe.sh');
  });
});
