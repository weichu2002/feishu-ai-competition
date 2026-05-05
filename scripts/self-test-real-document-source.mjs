import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const larkCliRunner = resolve(root, 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js');
const teamEntry = resolve(root, 'scripts', 'team-entry.js');
const assistantEntry = resolve(root, 'scripts', 'assistant-entry.js');

function runJson(label, command, args, { timeout = 300000, allowFail = false } = {}) {
  const result = spawnSync(command, args, {
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
    if (allowFail) {
      return { ok: false, label, status: result.status, stdout, stderr };
    }
    throw new Error(`${label} failed with code ${result.status}\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`);
  }

  if (!stdout) {
    return { ok: true };
  }

  try {
    return JSON.parse(stdout);
  } catch {
    const lines = stdout.split(/\r?\n/u).filter(Boolean);
    return JSON.parse(lines[lines.length - 1]);
  }
}

function findValue(target, keys) {
  if (!target || typeof target !== 'object') {
    return '';
  }
  for (const key of keys) {
    if (typeof target[key] === 'string' && target[key]) {
      return target[key];
    }
  }
  for (const value of Object.values(target)) {
    const found = findValue(value, keys);
    if (found) {
      return found;
    }
  }
  return '';
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

if (!existsSync(larkCliRunner)) {
  throw new Error(`Missing local lark-cli runner: ${larkCliRunner}`);
}

const stamp = new Date().toISOString().replace(/[-:.TZ]/gu, '').slice(0, 14);
const marker = `[FlowMate真实文档固定来源自测 ${stamp}]`;
const title = `FlowMate 真实文档固定来源自测 ${stamp}`;
const markdown = [
  '# FlowMate 真实文档固定来源自测',
  '',
  `张艺航 ${marker} 我明天下午前完成固定文档来源端到端验证。`,
  '',
  '这份文档由自动化脚本创建，验证后会自动清理。'
].join('\n');

let docToken = '';
let sourceId = `real-doc-${stamp}`;
const cleanup = [];

try {
  const createdDoc = runJson('create real Feishu document', process.execPath, [
    larkCliRunner,
    'docs',
    '+create',
    '--as',
    'user',
    '--title',
    title,
    '--markdown',
    markdown
  ]);
  docToken = findValue(createdDoc, ['doc_id', 'document_id', 'documentId', 'doc_token', 'file_token', 'token']);
  assert(docToken, `created document but cannot find token: ${JSON.stringify(createdDoc).slice(0, 800)}`);
  cleanup.push({ type: 'doc', token: docToken });

  const source = runJson('add real document source', process.execPath, [
    teamEntry,
    'source-add',
    '--type',
    'document',
    '--id',
    sourceId,
    '--doc',
    docToken,
    '--name',
    title,
    '--force',
    'true'
  ]);
  assert(source.ok === true && source.source?.id === sourceId, 'failed to add document source');
  cleanup.push({ type: 'source', id: sourceId });

  const scan = runJson('scan real document source', process.execPath, [
    teamEntry,
    'scan-once'
  ], { timeout: 600000 });
  assert(scan.ok === true, 'team scan did not return ok');
  assert((scan.syncedCount || 0) >= 1, `expected at least one synced item, got ${scan.syncedCount}`);

  const dashboard = runJson('refresh dashboard after real document source', process.execPath, [
    teamEntry,
    'dashboard-refresh'
  ], { timeout: 300000 });
  assert(dashboard.ok === true && dashboard.dashboard?.dashboardBlocks?.blockCount >= 7, 'dashboard blocks were not refreshed');

  console.log(JSON.stringify({
    ok: true,
    marker,
    docToken,
    sourceId,
    syncedCount: scan.syncedCount,
    processedSourceCount: scan.processedSourceCount,
    dashboardBlockCount: dashboard.dashboard.dashboardBlocks.blockCount,
    dashboardId: dashboard.dashboard.dashboardId
  }, null, 2));
} finally {
  try {
    runJson('cleanup team commitment fixture', process.execPath, [
      assistantEntry,
      'commitment-manage',
      '--action',
      'delete',
      '--target',
      marker,
      '--operation-scope',
      'team'
    ], { timeout: 300000, allowFail: true });
  } catch {
    // Keep the original failure visible.
  }

  for (const item of cleanup.reverse()) {
    if (item.type === 'source') {
      runJson('cleanup team source fixture', process.execPath, [
        teamEntry,
        'source-remove',
        '--id',
        item.id
      ], { timeout: 120000, allowFail: true });
    }
    if (item.type === 'doc') {
      for (const fileType of ['docx', 'doc']) {
        const deleted = runJson('cleanup temporary Feishu document', process.execPath, [
          larkCliRunner,
          'drive',
          '+delete',
          '--as',
          'user',
          '--file-token',
          item.token,
          '--type',
          fileType,
          '--yes'
        ], { timeout: 120000, allowFail: true });
        if (deleted.ok !== false) {
          break;
        }
      }
    }
  }
}
