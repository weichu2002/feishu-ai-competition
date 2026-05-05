import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { larkCliJson } from '../src/lark-cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const flowmateRoot = resolve(__dirname, '..');
const assistantEntry = resolve(__dirname, 'assistant-entry.js');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function runAssistant(args) {
  const stdout = execFileSync(process.execPath, [assistantEntry, ...args], {
    cwd: flowmateRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180000
  });
  return JSON.parse(stdout.trim() || '{}');
}

async function getRecord(recordId) {
  return await larkCliJson([
    'base',
    '+record-get',
    '--base-token', config.feishu.appToken,
    '--table-id', config.feishu.tableId,
    '--record-id', recordId
  ]);
}

async function recordExists(recordId) {
  try {
    await getRecord(recordId);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const marker = `[FlowMate核心自测 ${stamp}]`;
  let recordId = '';

  try {
    const auto = runAssistant([
      'auto',
      '--text', `${marker} 我明天下午前完成核心闭环验证`,
      '--requester-name', '张艺航',
      '--requester-openid', 'ou_f6a2032768953df1c08ea6b4b2d7b306',
      '--source-type', 'chat',
      '--source-title', 'FlowMate 核心自测',
      '--source-message-id', `om_flowmate_core_${stamp}`,
      '--source-chat-id', 'oc_flowmate_core_test',
      '--raw-message-text', `${marker} 我明天下午前完成核心闭环验证`,
      '--conversation-summary', '核心自测上下文摘要',
      '--conversation-context', '[前文] A: 准备做核心闭环验证\n[目标] 张艺航: 我明天下午前完成核心闭环验证\n[后文] B: 等待验证结果'
    ]);

    assert(auto.ok === true, 'auto command failed');
    assert(auto.syncState === 'synced', `auto syncState was ${auto.syncState}`);
    const syncResult = auto.sync?.results?.[0] || {};
    recordId = syncResult.bitable?.recordId || '';
    assert(recordId, 'missing bitable record id');
    assert(syncResult.task?.taskId, 'missing task id');
    assert(syncResult.calendar?.eventId, 'missing calendar event id');

    const created = await getRecord(recordId);
    const createdJson = JSON.stringify(created.data?.record || {});
    assert(createdJson.includes('核心自测上下文摘要'), 'context summary was not written to Bitable');
    assert(createdJson.includes('[前文] A: 准备做核心闭环验证'), 'conversation context was not written to Bitable');

    const delayed = runAssistant(['commitment-manage', '--action', 'update', '--target', marker, '--deadline-text', '明天下午']);
    assert(delayed.ok === true, `delay command failed: ${delayed.userFacingHint || delayed.error || ''}`);
    assert(delayed.updated?.taskUpdated === true, 'delay did not update task');
    assert(delayed.updated?.calendarUpdated === true, 'delay did not update calendar');

    const done = runAssistant(['commitment-manage', '--action', 'update', '--target', marker, '--status', 'done']);
    assert(done.ok === true, `done command failed: ${done.userFacingHint || done.error || ''}`);
    assert(done.updated?.bitableUpdated === true, 'done did not update Bitable');
    assert(done.updated?.taskUpdated === true, 'done did not update task');

    const completed = await getRecord(recordId);
    const completedJson = JSON.stringify(completed.data?.record || {});
    assert(completedJson.includes('已完成'), 'Bitable status was not updated to done');

    const undo = runAssistant(['undo-latest']);
    assert(undo.ok === true, `undo failed: ${undo.userFacingHint || undo.error || ''}`);
    assert(undo.undone?.[0]?.bitableRemoved === true, 'undo did not delete Bitable record');
    assert(undo.undone?.[0]?.taskRemoved === true, 'undo did not delete task');
    assert(undo.undone?.[0]?.calendarRemoved === true, 'undo did not delete calendar event');

    const stillExists = await recordExists(recordId);
    assert(stillExists === false, 'Bitable record still exists after undo');

    console.log(JSON.stringify({
      ok: true,
      action: 'self-test-flowmate-core',
      marker,
      verified: [
        'auto extraction',
        'Bitable write',
        'task create/update/delete',
        'calendar create/update/delete',
        'context persistence',
        'deadline update',
        'done update',
        'undo cleanup'
      ]
    }, null, 2));
  } catch (error) {
    if (recordId) {
      try {
        runAssistant(['undo-latest']);
      } catch {
        try {
          runAssistant(['commitment-manage', '--action', 'delete', '--target', marker]);
        } catch {
          // Keep the original failure visible; cleanup failure is secondary.
        }
      }
    }

    console.error(JSON.stringify({
      ok: false,
      action: 'self-test-flowmate-core',
      error: error.message,
      recordId
    }, null, 2));
    process.exit(1);
  }
}

await main();
