import { spawnSync } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const teamEntry = resolve(root, 'scripts', 'team-entry.js');

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function runJson(label, args, { timeout = 600000 } = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    env: {
      ...process.env,
      LARKSUITE_CLI_CONFIG_DIR: process.env.LARKSUITE_CLI_CONFIG_DIR || resolve(process.env.USERPROFILE || process.env.HOME || root, '.lark-cli')
    }
  });

  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();
  if (result.status !== 0) {
    throw new Error(`${label} failed with code ${result.status}\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`);
  }
  if (!stdout) return { ok: true };
  try {
    return JSON.parse(stdout);
  } catch {
    const lines = stdout.split(/\r?\n/u).filter(Boolean);
    return JSON.parse(lines.at(-1));
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const args = parseArgs(process.argv.slice(2));
const minuteToken = args['minute-token'] || args.minuteToken || process.env.FLOWMATE_DEMO_MINUTE_TOKEN || 'obcnb2q4nap98l5ny5as2n11';
const sourceId = args.id || 'demo-real-minutes';
const sourceName = args.name || 'FlowMate 真实飞书妙记 Demo';
const question = args.question || '这次真实飞书妙记里谁要做什么？请给证据来源。';

assert(minuteToken, 'Missing minute token. Pass --minute-token <token> or set FLOWMATE_DEMO_MINUTE_TOKEN.');

const source = runJson('add real minutes source', [
  teamEntry,
  'source-add',
  '--type',
  'minutes',
  '--id',
  sourceId,
  '--name',
  sourceName,
  '--minute-token',
  minuteToken,
  '--force',
  'true'
]);
assert(source.ok === true, 'failed to add minutes source');

const scan = runJson('scan real minutes source', [
  teamEntry,
  'scan-once'
], { timeout: 900000 });
assert(scan.ok === true, 'team scan did not return ok');

const dashboard = runJson('refresh dashboard', [
  teamEntry,
  'dashboard-refresh'
], { timeout: 360000 });
assert(dashboard.ok === true, 'dashboard refresh failed');

const qa = runJson('knowledge qa for real minutes', [
  teamEntry,
  'qa',
  '--question',
  question
], { timeout: 300000 });
assert(qa.ok === true, 'knowledge QA failed');

console.log(JSON.stringify({
  ok: true,
  action: 'self-test-real-minutes-source',
  minuteToken,
  sourceId,
  sourceName,
  source,
  scan: {
    processedSourceCount: scan.processedSourceCount,
    syncedCount: scan.syncedCount,
    skippedCount: scan.skippedCount,
    failedCount: scan.failedCount,
    results: scan.results
  },
  dashboard: {
    metricCount: dashboard.metrics?.length || 0,
    dashboardId: dashboard.dashboard?.dashboardId || '',
    dashboardBlockCount: dashboard.dashboard?.dashboardBlocks?.blockCount || 0
  },
  qa: {
    question,
    answer: qa.answer || qa.userFacingHint || '',
    evidenceCount: qa.evidence?.length || 0,
    evidence: qa.evidence || []
  },
  userFacingHint: [
    `真实妙记来源已配置：${sourceName} (${sourceId})`,
    `本轮扫描同步：${scan.syncedCount || 0} 条`,
    `证据问答命中：${qa.evidence?.length || 0} 条证据`,
    '注意：这个 Demo 不会自动清理来源和记录，方便你继续问证据问题。'
  ].join('\n')
}, null, 2));
