import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { FeishuWriter } from '../src/feishu-write.js';
import { loadWorkspaceUserProfile, personalMonitorPaths } from '../src/personal-monitor.js';

const latestOperationPath = resolve(personalMonitorPaths.workspaceStateDir, 'flowmate-last-operation.json');

async function main() {
  const writer = new FeishuWriter();
  const profile = loadWorkspaceUserProfile();
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const deadline = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

  const commitment = {
    id: `codex-undo-smoke-${stamp}`,
    title: `[FlowMate测试] Undo Smoke ${stamp}`,
    owner: profile.name || 'Current User',
    ownerOpenId: profile.openId || '',
    deadlineText: 'today',
    deadline,
    priority: 'P2',
    status: 'pending',
    sourceType: 'chat',
    sourceTitle: 'FlowMate undo smoke test',
    sourceLink: '',
    evidence: [{
      sourceType: 'chat',
      sourceTitle: 'FlowMate undo smoke test',
      sourceLink: '',
      quote: 'This is a temporary FlowMate undo smoke test.',
      speaker: profile.name || 'Current User',
      timestamp: new Date().toISOString()
    }],
    confidence: 'high',
    nextAction: '',
    riskReason: '',
    feishuTaskId: '',
    bitableRecordId: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const bitable = await writer.syncCommitmentToBitable(commitment);
  commitment.bitableRecordId = bitable.recordId || '';

  const task = await writer.syncCommitmentsToTask(commitment);
  commitment.feishuTaskId = task.taskId || '';

  if (commitment.bitableRecordId && commitment.feishuTaskId) {
    const schema = await writer.getSchemaProfile();
    await writer.updateCommitmentInBitable(commitment.bitableRecordId, commitment, schema);
  }

  const calendar = await writer.ensureCalendarReminder(commitment);

  const payload = {
    savedAt: new Date().toISOString(),
    trigger: 'undo-smoke-test',
    sourceTitle: commitment.sourceTitle,
    items: [{
      id: commitment.id,
      title: commitment.title,
      bitableRecordId: commitment.bitableRecordId,
      bitableCreated: true,
      taskId: commitment.feishuTaskId,
      taskCreated: Boolean(commitment.feishuTaskId),
      calendarEventId: calendar.eventId || '',
      calendarCalendarId: calendar.calendarId || '',
      calendarCreated: Boolean(calendar.eventId),
      owner: commitment.owner,
      deadline: commitment.deadline
    }]
  };

  writeFileSync(latestOperationPath, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify({
    ok: true,
    latestOperationPath,
    payload
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error.message
  }, null, 2));
  process.exit(1);
});
