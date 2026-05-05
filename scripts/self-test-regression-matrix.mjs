import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const flowmateRoot = resolve(__dirname, '..');
const assistantEntry = resolve(__dirname, 'assistant-entry.js');
const teamEntry = resolve(__dirname, 'team-entry.js');
const coreSelfTest = resolve(__dirname, 'self-test-flowmate-core.mjs');
const liveFeishuTest = resolve(__dirname, 'self-test-live-feishu-message.mjs');
const serviceScript = resolve(__dirname, 'flowmate-service.js');

function runNode(args, options = {}) {
  const stdout = execFileSync(process.execPath, args, {
    cwd: flowmateRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeout || 240000,
    env: {
      ...process.env,
      ...(options.env || {})
    }
  });
  return stdout.trim();
}

function runJson(label, args, options = {}) {
  let output = '';
  try {
    output = runNode(args, options);
  } catch (error) {
    throw new Error(`${label} failed: ${error.message}`);
  }
  try {
    return JSON.parse(output || '{}');
  } catch (error) {
    const start = output.lastIndexOf('\n{');
    const candidate = start >= 0 ? output.slice(start + 1) : '';
    if (candidate) {
      try {
        return JSON.parse(candidate);
      } catch {
        // Fall through to the original parse error.
      }
    }
    throw new Error(`${label} did not return JSON: ${error.message}\n${output.slice(0, 800)}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const steps = [];
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const teamMarkers = [];

  const larkOutput = runNode([resolve(__dirname, 'check-lark.js')]);
  assert(/All checks passed|✅ All checks passed/u.test(larkOutput), 'lark-cli health check failed');
  steps.push({ name: 'lark-cli auth/object layer', ok: true });

  const monitor = runJson('monitor-status', [assistantEntry, 'monitor-status']);
  assert(monitor.ok === true, 'monitor-status failed');
  steps.push({
    name: 'personal monitor status',
    ok: true,
    state: monitor.monitorState,
    watcherHealthy: Boolean(monitor.watcher?.healthy)
  });

  const chat = runJson('model chat', [
    assistantEntry,
    'chat',
    '--text',
    '[FlowMate回归矩阵] 用一句自然中文确认你在线，不要输出内部标记。'
  ]);
  assert(chat.ok === true && typeof chat.replyText === 'string' && chat.replyText.trim(), 'model chat failed');
  assert(!/NO_REPLY|<\/arg_value>|\[\[reply_to_current\]\]/iu.test(chat.replyText), 'model chat leaked internal marker');
  steps.push({ name: 'model Q&A sanitization', ok: true, replyText: chat.replyText });

  const core = runJson('self-test:core', [coreSelfTest], { timeout: 360000 });
  assert(core.ok === true, 'core self-test failed');
  steps.push({ name: 'personal Bitable/task/calendar core loop', ok: true, verified: core.verified });

  const teamEnsure = runJson('team:ensure', [teamEntry, 'ensure'], { timeout: 360000 });
  assert(teamEnsure.ok === true && teamEnsure.table?.tableId, 'team ensure failed');
  assert((teamEnsure.dashboardBlocks?.blockCount || 0) >= 7, 'team dashboard blocks were not ensured');
  steps.push({
    name: 'team table/views/dashboard',
    ok: true,
    tableId: teamEnsure.table.tableId,
    metricsTableId: teamEnsure.metricsTable?.tableId || '',
    dashboardBlockCount: teamEnsure.dashboardBlocks?.blockCount || 0
  });

  const members = runJson('team:member-list', [teamEntry, 'member-list']);
  assert(members.ok === true, 'team member list failed');
  steps.push({ name: 'team member mapping command', ok: true, memberCount: members.memberCount });

  const sources = runJson('team:source-list', [teamEntry, 'source-list']);
  assert(sources.ok === true, 'team source list failed');
  steps.push({ name: 'team source management command', ok: true, sourceCount: sources.sourceCount });

  const syncStatus = runJson('team:sync-status', [teamEntry, 'sync-statuses'], { timeout: 240000 });
  assert(syncStatus.ok === true, 'team status sync failed');
  steps.push({ name: 'team linked status sync', ok: true, updatedCount: syncStatus.updatedCount });

  const dashboard = runJson('team:dashboard', [teamEntry, 'dashboard-refresh'], { timeout: 360000 });
  assert(dashboard.ok === true && dashboard.metricCount >= 6, 'team dashboard metrics failed');
  assert((dashboard.dashboard?.dashboardBlocks?.blockCount || 0) >= 7, 'team dashboard block refresh failed');
  steps.push({
    name: 'team dashboard metrics and visual blocks',
    ok: true,
    metricCount: dashboard.metricCount,
    dashboardBlockCount: dashboard.dashboard?.dashboardBlocks?.blockCount || 0
  });

  const eventSubscription = runJson('team task event subscription', [teamEntry, 'subscribe-events'], { timeout: 120000 });
  assert(eventSubscription.ok === true && eventSubscription.subscription?.data?.ok === true, 'team task event subscription failed');
  steps.push({ name: 'team task event subscription', ok: true });

  const warnings = runJson('team:warn', [teamEntry, 'warn'], { timeout: 240000 });
  assert(warnings.ok === true, 'team warning build failed');
  steps.push({
    name: 'team due/overdue/blocked warning',
    ok: true,
    warningCount: warnings.warningCount
  });

  try {
    const unassignedMarker = `[FlowMate团队重分派自测 ${stamp}]`;
    teamMarkers.push(unassignedMarker);
    const unassigned = runJson('team unassigned fixture', [
      assistantEntry,
      'auto',
      '--text',
      `${unassignedMarker} 王测试明天下午前完成重分派闭环验证`,
      '--requester-name',
      '张艺航',
      '--requester-openid',
      'ou_f6a2032768953df1c08ea6b4b2d7b306',
      '--source-type',
      'chat',
      '--source-title',
      'FlowMate 团队重分派自测',
      '--source-message-id',
      `om_team_reassign_${stamp}`,
      '--source-chat-id',
      'oc_team_regression_test',
      '--raw-message-text',
      `${unassignedMarker} 王测试明天下午前完成重分派闭环验证`,
      '--conversation-summary',
      '团队重分派自测上下文',
      '--conversation-context',
      '王测试: 明天下午前完成重分派闭环验证',
      '--operation-scope',
      'team'
    ], { timeout: 300000 });
    assert(unassigned.ok === true && unassigned.syncState === 'synced', 'team unassigned fixture failed');

    const reassign = runJson('team reassign', [
      teamEntry,
      'reassign',
      '--target',
      '重分派闭环验证',
      '--name',
      '张艺航',
      '--open-id',
      'ou_f6a2032768953df1c08ea6b4b2d7b306',
      '--aliases',
      '我,张艺航,zyh'
    ], { timeout: 300000 });
    assert(reassign.ok === true && reassign.notified === true, 'team reassign failed');
    steps.push({ name: 'team unassigned owner confirmation/reassign', ok: true, notified: reassign.notified });

    const minutesMarker = `[FlowMate会议纪要自测 ${stamp}]`;
    teamMarkers.push(minutesMarker);
    const minutes = runJson('minutes end-to-end fixture', [
      assistantEntry,
      'extract-and-sync',
      '--text',
      `会议纪要\n张艺航: ${minutesMarker} 我明天下午前完成会议纪要端到端验证`,
      '--requester-name',
      '张艺航',
      '--requester-openid',
      'ou_f6a2032768953df1c08ea6b4b2d7b306',
      '--source-type',
      'minutes',
      '--source-title',
      'FlowMate 会议纪要端到端自测',
      '--raw-message-text',
      `${minutesMarker} 我明天下午前完成会议纪要端到端验证`,
      '--conversation-summary',
      '会议纪要端到端自测',
      '--conversation-context',
      `张艺航: ${minutesMarker} 我明天下午前完成会议纪要端到端验证`,
      '--operation-scope',
      'team'
    ], { timeout: 300000 });
    assert(minutes.ok === true && minutes.syncState === 'synced', 'minutes end-to-end fixture failed');
    steps.push({ name: 'minutes action item to team table/task/calendar', ok: true });

    const digest = runJson('team digest', [teamEntry, 'digest', '--period', 'daily'], { timeout: 240000 });
    assert(digest.ok === true && digest.message.includes('FlowMate 团队日推进摘要'), 'team digest failed');
    steps.push({ name: 'team proactive digest card text', ok: true, commitmentCount: digest.commitmentCount });

    const qa = runJson('team knowledge qa', [
      teamEntry,
      'qa',
      '--question',
      '会议纪要端到端验证是谁负责的？'
    ], { timeout: 300000 });
    assert(qa.ok === true && qa.evidence?.length > 0 && /证据来源/u.test(qa.userFacingHint), 'team knowledge qa failed');
    steps.push({ name: 'team knowledge QA with evidence', ok: true, evidenceCount: qa.evidence.length });
  } finally {
    for (const marker of teamMarkers) {
      try {
        runJson('cleanup team fixture', [
          assistantEntry,
          'commitment-manage',
          '--action',
          'delete',
          '--target',
          marker,
          '--operation-scope',
          'team'
        ], { timeout: 300000 });
      } catch {
        // Keep the original test failure visible; cleanup failure is secondary.
      }
    }
  }

  if (args.has('--live-feishu')) {
    const live = runJson('openclaw-lark live inbound simulation', [
      liveFeishuTest,
      '[FlowMate回归矩阵] 你现在在线吗？请一句话回答。'
    ], { timeout: 600000 });
    assert(live.ok === true && live.channel === 'openclaw-lark', 'live openclaw-lark simulation failed');
    steps.push({ name: 'openclaw-lark live inbound simulation', ok: true, messageId: live.messageId });
  }

  const status = runJson('team:status', [teamEntry, 'status']);
  assert(status.ok === true, 'team status failed');
  steps.push({
    name: 'team final status',
    ok: true,
    enabledSourceCount: status.enabledSourceCount,
    memberCount: status.memberCount
  });

  const service = runJson('service status', [serviceScript, 'status']);
  assert(service.ok === true, 'service status failed');
  steps.push({
    name: 'service status command',
    ok: true,
    gatewayListening: Boolean(service.gateway?.listening),
    personalState: service.personal?.state || '',
    teamState: service.team?.state || ''
  });

  console.log(JSON.stringify({
    ok: true,
    action: 'self-test-regression-matrix',
    mode: args.has('--live-feishu') ? 'with-live-feishu' : 'local-and-feishu-object-layer',
    verifiedCount: steps.length,
    steps
  }, null, 2));
}

await main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    action: 'self-test-regression-matrix',
    error: error.message
  }, null, 2));
  process.exit(1);
});
