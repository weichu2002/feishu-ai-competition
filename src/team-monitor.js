import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { FeishuWriter, FLOWMATE_LEDGER_FIELDS } from './feishu-write.js';
import { larkCliJson } from './lark-cli.js';
import { modelClient } from './model-client.js';
import { isDueSoon, isOverdue, SourceType } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const flowmateRoot = resolve(__dirname, '..');
const assistantEntry = resolve(flowmateRoot, 'scripts', 'assistant-entry.js');
const workspaceDir = resolve(config.openclaw.stateDir);
const workspaceStateDir = resolve(workspaceDir, 'state');
const teamConfigPath = resolve(workspaceStateDir, 'flowmate-team-config.json');
const teamScanStatePath = resolve(workspaceStateDir, 'flowmate-team-scan-state.json');
const teamEventSubscriptionPath = resolve(workspaceStateDir, 'flowmate-team-event-subscription.json');

const TEAM_TABLE_NAME = 'FlowMate_团队重点事项推进总表';
const TEAM_METRICS_TABLE_NAME = 'FlowMate_团队驾驶舱指标';
const TEAM_DASHBOARD_NAME = 'FlowMate 团队推进驾驶舱';
const TEAM_DASHBOARD_BLOCKS = [
  {
    name: 'FlowMate 总览说明',
    type: 'text',
    dataConfig: {
      text: '# FlowMate 团队推进驾驶舱\n自动汇总团队重点事项、负责人、状态、来源和风险。图表来自团队推进总表，摘要来自 FlowMate 指标计算。'
    }
  },
  {
    name: '全部团队事项',
    type: 'statistics',
    dataConfig: {
      table_name: TEAM_TABLE_NAME,
      count_all: true
    }
  },
  {
    name: '驾驶舱指标数',
    aliases: ['待完成事项'],
    type: 'statistics',
    dataConfig: {
      table_name: TEAM_METRICS_TABLE_NAME,
      count_all: true
    }
  },
  {
    name: '状态分布',
    type: 'ring',
    dataConfig: {
      table_name: TEAM_TABLE_NAME,
      count_all: true,
      group_by: [{ field_name: FLOWMATE_LEDGER_FIELDS.status, mode: 'integrated' }]
    }
  },
  {
    name: '负责人工作量',
    type: 'bar',
    dataConfig: {
      table_name: TEAM_TABLE_NAME,
      count_all: true,
      group_by: [{ field_name: FLOWMATE_LEDGER_FIELDS.owner, mode: 'integrated' }]
    }
  },
  {
    name: '来源类型分布',
    type: 'pie',
    dataConfig: {
      table_name: TEAM_TABLE_NAME,
      count_all: true,
      group_by: [{ field_name: FLOWMATE_LEDGER_FIELDS.sourceType, mode: 'integrated' }]
    }
  },
  {
    name: '指标记录数',
    aliases: ['阻塞风险', '指标分布'],
    type: 'statistics',
    dataConfig: {
      table_name: TEAM_METRICS_TABLE_NAME,
      count_all: true
    }
  }
];
const TEAM_VIEWS = ['全部团队事项', '待推进', '今日到期', '本周到期', '临期逾期', '已阻塞', '已完成', '按负责人'];
const FLOWMATE_FIELDS = [
  '承诺ID',
  '承诺标题',
  '负责人',
  '负责人OpenID',
  '截止时间文本',
  '标准截止时间',
  '状态',
  '优先级',
  '来源类型',
  '来源标题',
  '来源链接',
  '证据原文',
  '置信度',
  '下一步动作',
  '风险原因',
  '飞书任务ID',
  '飞书日程ID',
  '飞书日历ID',
  '来源消息ID',
  '来源聊天ID',
  '来源话题ID',
  '承诺原文',
  '上下文摘要',
  '对话上下文',
  '去重指纹',
  '来源集合',
  '最近提醒时间',
  '提醒次数',
  '分派时间',
  '最近同步时间',
  '创建时间',
  '更新时间'
];
const METRICS_FIELDS = ['指标', '数值', '维度', '负责人', '周期', '更新时间', '说明'];

function ensureDir(dirPath) {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

function readJson(filePath, fallback) {
  if (!existsSync(filePath)) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  ensureDir(dirname(filePath));
  writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function loadWorkspaceUserProfile() {
  const profile = { name: '', openId: '' };
  const userPath = resolve(workspaceDir, 'USER.md');
  if (!existsSync(userPath)) {
    return profile;
  }

  const content = readFileSync(userPath, 'utf8');
  const openIdMatch = content.match(/ou_[A-Za-z0-9]+/u);
  const nameMatch = content.match(/\*\*.*?[:：]\s*(.+)$/mu);
  profile.openId = openIdMatch?.[0] || '';
  profile.name = nameMatch?.[1]?.trim() || '';
  return profile;
}

function loadTeamConfig() {
  const profile = loadWorkspaceUserProfile();
  const raw = readJson(teamConfigPath, {});
  return {
    enabled: raw.enabled !== false,
    tableName: raw.tableName || TEAM_TABLE_NAME,
    tableId: raw.tableId || '',
    metricsTableName: raw.metricsTableName || TEAM_METRICS_TABLE_NAME,
    metricsTableId: raw.metricsTableId || '',
    alertUserOpenId: raw.alertUserOpenId || profile.openId || '',
    reminderCooldownHours: Number(raw.reminderCooldownHours || 12),
    sources: Array.isArray(raw.sources) ? raw.sources : [],
    members: Array.isArray(raw.members) ? raw.members : [],
    updatedAt: raw.updatedAt || ''
  };
}

function saveTeamConfig(configValue) {
  writeJson(teamConfigPath, {
    ...configValue,
    updatedAt: new Date().toISOString()
  });
}

function loadTeamScanState() {
  return readJson(teamScanStatePath, { sources: {} });
}

function saveTeamScanState(state) {
  writeJson(teamScanStatePath, state);
}

function trimIds(ids, limit = 800) {
  return ids.slice(Math.max(0, ids.length - limit));
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

function toIsoWithOffset(value) {
  const date = new Date(value);
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(abs / 60)).padStart(2, '0');
  const offsetRemain = String(abs % 60).padStart(2, '0');
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${sign}${offsetHours}:${offsetRemain}`;
}

function normalizeMessageContent(item) {
  const raw = item?.body?.content || item?.content || item?.text || '';
  if (!raw) {
    return '';
  }
  if (typeof raw !== 'string') {
    return String(raw);
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.text === 'string') {
      return parsed.text;
    }
    if (Array.isArray(parsed?.content)) {
      return parsed.content.flat(3).map((part) => part?.text || '').filter(Boolean).join('');
    }
  } catch {
    // Plain text.
  }
  return raw;
}

function normalizeMessages(result) {
  const rawMessages = result?.messages || result?.data?.messages || result?.data?.items || result?.items || [];
  if (!Array.isArray(rawMessages)) {
    return [];
  }

  return rawMessages.map((item) => {
    const messageId = item?.message_id || item?.messageId || item?.id || '';
    const createTimeRaw = item?.create_time || item?.createTime || item?.timestamp || item?.time || '';
    const createTime = /^\d+$/u.test(String(createTimeRaw))
      ? new Date(Number(createTimeRaw) > 1000000000000 ? Number(createTimeRaw) : Number(createTimeRaw) * 1000).toISOString()
      : (createTimeRaw ? new Date(createTimeRaw).toISOString() : '');
    return {
      messageId,
      senderOpenId: item?.sender?.id || item?.sender?.open_id || item?.sender_id || item?.senderOpenId || item?.from_id || '',
      senderName: item?.sender?.name || item?.sender_name || item?.from_name || '',
      content: normalizeMessageContent(item),
      createTime,
      chatId: item?.chat_id || item?.chatId || '',
      chatName: item?.chat_name || item?.chatName || '',
      threadId: item?.thread_id || item?.threadId || ''
    };
  }).filter((item) => item.messageId && item.content);
}

async function listChatMessages({ chatId, start, end, pageSize = 50 }) {
  const result = await larkCliJson([
    'im',
    '+chat-messages-list',
    '--as',
    'user',
    '--chat-id',
    chatId,
    '--start',
    start,
    '--end',
    end,
    '--page-size',
    String(pageSize),
    '--sort',
    'asc',
    '--format',
    'json'
  ]);
  return normalizeMessages(result).map((message) => ({
    ...message,
    chatId: message.chatId || chatId
  }));
}

function formatContextLine(message, targetMessageId) {
  const prefix = message.messageId === targetMessageId ? '>>' : '-';
  const time = message.createTime ? message.createTime.slice(11, 16) : '';
  const speaker = message.senderName || message.senderOpenId || 'unknown';
  return `${prefix} ${time} ${speaker}: ${message.content}`.trim();
}

function shouldSkipTeamMessage(message) {
  const text = String(message?.content || '').trim();
  if (!text) {
    return true;
  }
  if (!message?.senderOpenId && !message?.senderName) {
    return true;
  }
  return /^(已自动识别并同步这条承诺|FlowMate\s|FlowMate已|监听状态[:：]|团队扫描[:：]|我是 FlowMate)/u.test(text);
}

function buildContext(message, history, radius = 5) {
  const index = history.findIndex((item) => item.messageId === message.messageId);
  const before = index >= 0 ? history.slice(Math.max(0, index - radius), index) : [];
  const after = index >= 0 ? history.slice(index + 1, index + 1 + radius) : [];
  return {
    summary: `${message.chatName || message.chatId || 'team-chat'} | before ${before.length} / after ${after.length}`,
    text: [
      `目标消息ID: ${message.messageId}`,
      `聊天ID: ${message.chatId}`,
      `话题ID: ${message.threadId || ''}`,
      `消息时间: ${message.createTime || ''}`,
      '',
      '前文:',
      ...(before.length ? before.map((item) => formatContextLine(item, message.messageId)) : ['- 无']),
      '',
      '目标消息:',
      formatContextLine(message, message.messageId),
      '',
      '后文:',
      ...(after.length ? after.map((item) => formatContextLine(item, message.messageId)) : ['- 无'])
    ].join('\n')
  };
}

async function ensureTeamTable() {
  const teamConfig = loadTeamConfig();
  const tablesResult = await larkCliJson([
    'base',
    '+table-list',
    '--as',
    'user',
    '--base-token',
    config.feishu.appToken
  ]);
  const tables = Array.isArray(tablesResult?.data?.tables) ? tablesResult.data.tables : [];
  const existing = tables.find((table) => table.id === teamConfig.tableId || table.name === teamConfig.tableName);

  if (existing?.id) {
    const next = { ...teamConfig, tableId: existing.id, tableName: existing.name || teamConfig.tableName };
    saveTeamConfig(next);
    await ensureTableFields(existing.id, FLOWMATE_FIELDS);
    return { tableId: existing.id, tableName: next.tableName, created: false };
  }

  const fields = FLOWMATE_FIELDS.map((name) => ({ name, type: 'text' }));
  const created = await larkCliJson([
    'base',
    '+table-create',
    '--as',
    'user',
    '--base-token',
    config.feishu.appToken,
    '--name',
    teamConfig.tableName,
    '--fields',
    JSON.stringify(fields),
    '--view',
    JSON.stringify({ name: '全部团队事项', type: 'grid' })
  ]);
  const tableId =
    created?.data?.table_id ||
    created?.data?.table?.table_id ||
    created?.data?.table?.id ||
    findValue(created?.data?.table || created?.data, ['table_id']);
  if (!tableId) {
    throw new Error('团队总表创建成功但没有返回 table_id。');
  }

  const next = { ...teamConfig, tableId };
  saveTeamConfig(next);
  return { tableId, tableName: teamConfig.tableName, created: true };
}

async function ensureTableFields(tableId, fieldNames) {
  const fieldResult = await larkCliJson([
    'base',
    '+field-list',
    '--as',
    'user',
    '--base-token',
    config.feishu.appToken,
    '--table-id',
    tableId
  ]);
  const fields = Array.isArray(fieldResult?.data?.fields)
    ? fieldResult.data.fields
    : (Array.isArray(fieldResult?.data?.items) ? fieldResult.data.items : []);
  const existingNames = new Set(fields.map((field) => field?.name).filter(Boolean));
  for (const fieldName of fieldNames) {
    if (existingNames.has(fieldName)) {
      continue;
    }
    await larkCliJson([
      'base',
      '+field-create',
      '--as',
      'user',
      '--base-token',
      config.feishu.appToken,
      '--table-id',
      tableId,
      '--json',
      JSON.stringify({ name: fieldName, type: 'text' })
    ]);
  }
}

async function ensureNamedTable({ tableName, tableId, fieldNames, configKey }) {
  const teamConfig = loadTeamConfig();
  const tablesResult = await larkCliJson([
    'base',
    '+table-list',
    '--as',
    'user',
    '--base-token',
    config.feishu.appToken
  ]);
  const tables = Array.isArray(tablesResult?.data?.tables) ? tablesResult.data.tables : [];
  const existing = tables.find((table) => table.id === tableId || table.name === tableName);
  if (existing?.id) {
    const next = { ...teamConfig, [configKey]: existing.id };
    saveTeamConfig(next);
    await ensureTableFields(existing.id, fieldNames);
    return { tableId: existing.id, tableName: existing.name || tableName, created: false };
  }

  const created = await larkCliJson([
    'base',
    '+table-create',
    '--as',
    'user',
    '--base-token',
    config.feishu.appToken,
    '--name',
    tableName,
    '--fields',
    JSON.stringify(fieldNames.map((name) => ({ name, type: 'text' }))),
    '--view',
    JSON.stringify({ name: '全部指标', type: 'grid' })
  ]);
  const createdTableId =
    created?.data?.table_id ||
    created?.data?.table?.table_id ||
    created?.data?.table?.id ||
    findValue(created?.data?.table || created?.data, ['table_id']);
  if (!createdTableId) {
    throw new Error(`${tableName} 创建成功但没有返回 table_id。`);
  }
  saveTeamConfig({ ...teamConfig, [configKey]: createdTableId });
  return { tableId: createdTableId, tableName, created: true };
}

async function ensureTeamMetricsTable() {
  const teamConfig = loadTeamConfig();
  return await ensureNamedTable({
    tableName: teamConfig.metricsTableName,
    tableId: teamConfig.metricsTableId,
    fieldNames: METRICS_FIELDS,
    configKey: 'metricsTableId'
  });
}

async function ensureTeamViewsAndDashboard(tableId) {
  const views = await larkCliJson([
    'base',
    '+view-list',
    '--as',
    'user',
    '--base-token',
    config.feishu.appToken,
    '--table-id',
    tableId
  ]);
  const existingViews = Array.isArray(views?.data?.views) ? views.data.views : [];
  const fieldResult = await larkCliJson([
    'base',
    '+field-list',
    '--as',
    'user',
    '--base-token',
    config.feishu.appToken,
    '--table-id',
    tableId
  ]);
  const fields = Array.isArray(fieldResult?.data?.fields)
    ? fieldResult.data.fields
    : (Array.isArray(fieldResult?.data?.items) ? fieldResult.data.items : []);
  const fieldMap = new Map(fields.map((field) => [field.name, field.field_id || field.id || '']));
  const ensuredViews = [];

  for (const name of TEAM_VIEWS) {
    const existing = existingViews.find((view) => view?.view_name === name || view?.name === name);
    if (existing) {
      ensuredViews.push({ name, existed: true, viewId: existing.view_id || existing.id || '' });
      continue;
    }
    const created = await larkCliJson([
      'base',
      '+view-create',
      '--as',
      'user',
      '--base-token',
      config.feishu.appToken,
      '--table-id',
      tableId,
      '--json',
      JSON.stringify({ name, type: 'grid' })
    ]);
    const viewId = findValue(created, ['view_id', 'id']);
    await tryConfigureTeamView({ tableId, viewId, viewName: name, fieldMap });
    ensuredViews.push({ name, existed: false, viewId });
    continue;
  }

  for (const view of existingViews) {
    const viewName = view?.view_name || view?.name || '';
    if (!TEAM_VIEWS.includes(viewName)) {
      continue;
    }
    await tryConfigureTeamView({
      tableId,
      viewId: view.view_id || view.id || '',
      viewName,
      fieldMap
    });
  }

  const dashboards = await larkCliJson([
    'base',
    '+dashboard-list',
    '--as',
    'user',
    '--base-token',
    config.feishu.appToken
  ]);
  const existingDashboards = Array.isArray(dashboards?.data?.items) ? dashboards.data.items : [];
  const existingDashboard = existingDashboards.find((item) => item?.name === TEAM_DASHBOARD_NAME);
  let dashboardId = existingDashboard?.dashboard_id || existingDashboard?.id || '';
  let dashboardCreated = false;

  if (!dashboardId) {
    const created = await larkCliJson([
      'base',
      '+dashboard-create',
      '--as',
      'user',
      '--base-token',
      config.feishu.appToken,
      '--name',
      TEAM_DASHBOARD_NAME
    ]);
    dashboardId = findValue(created, ['dashboard_id', 'id']);
    dashboardCreated = true;
  }

  const dashboardBlocks = await ensureTeamDashboardBlocks(dashboardId);

  return { ensuredViews, dashboardId, dashboardCreated, dashboardBlocks };
}

async function tryConfigureTeamView({ tableId, viewId, viewName, fieldMap }) {
  if (!viewId) {
    return;
  }

  const statusFieldId = fieldMap.get(FLOWMATE_LEDGER_FIELDS.status) || '';
  const deadlineFieldId = fieldMap.get(FLOWMATE_LEDGER_FIELDS.deadline) || '';
  const ownerFieldId = fieldMap.get(FLOWMATE_LEDGER_FIELDS.owner) || '';
  const filterByName = {
    '待推进': statusFieldId ? { logic: 'and', conditions: [[statusFieldId, '!=', 'done']] } : null,
    '已阻塞': statusFieldId ? { logic: 'and', conditions: [[statusFieldId, '==', 'blocked']] } : null,
    '已完成': statusFieldId ? { logic: 'and', conditions: [[statusFieldId, '==', 'done']] } : null
  };
  const filter = filterByName[viewName];
  if (filter) {
    try {
      await larkCliJson([
        'base',
        '+view-set-filter',
        '--as',
        'user',
        '--base-token',
        config.feishu.appToken,
        '--table-id',
        tableId,
        '--view-id',
        viewId,
        '--json',
        JSON.stringify(filter)
      ]);
    } catch {
      // View filters are best effort because table field types may vary.
    }
  }

  const sortField = viewName === '按负责人' ? ownerFieldId : deadlineFieldId;
  if (sortField) {
    try {
      await larkCliJson([
        'base',
        '+view-set-sort',
        '--as',
        'user',
        '--base-token',
        config.feishu.appToken,
        '--table-id',
        tableId,
        '--view-id',
        viewId,
        '--json',
        JSON.stringify({ sort_config: [{ field: sortField, desc: false }] })
      ]);
    } catch {
      // Best effort only.
    }
  }
}

function normalizeDashboardBlocks(result) {
  const items = result?.data?.items || result?.data?.blocks || result?.items || [];
  return Array.isArray(items) ? items : [];
}

async function ensureTeamDashboardBlocks(dashboardId) {
  if (!dashboardId) {
    return { ok: true, skipped: true, blocks: [] };
  }

  const existing = normalizeDashboardBlocks(await larkCliJson([
    'base',
    '+dashboard-block-list',
    '--as',
    'user',
    '--base-token',
    config.feishu.appToken,
    '--dashboard-id',
    dashboardId
  ]));
  const ensured = [];

  for (const block of TEAM_DASHBOARD_BLOCKS) {
    const blockNames = [block.name, ...(Array.isArray(block.aliases) ? block.aliases : [])];
    const matched = existing.find((item) => blockNames.includes(item?.name) || blockNames.includes(item?.block_name));
    const blockId = matched?.block_id || matched?.id || '';
    if (blockId) {
      // Updating existing dashboard block configs is not required for metric refresh and can be rejected
      // by Feishu for some chart types. Treat existence as success; create only when missing.
      ensured.push({ name: block.name, type: block.type, blockId, existed: true, updated: 'skipped' });
      continue;
    }

    try {
      const created = await larkCliJson([
        'base',
        '+dashboard-block-create',
        '--as',
        'user',
        '--base-token',
        config.feishu.appToken,
        '--dashboard-id',
        dashboardId,
        '--type',
        block.type,
        '--name',
        block.name,
        '--data-config',
        JSON.stringify(block.dataConfig),
        '--no-validate'
      ]);
      ensured.push({
        name: block.name,
        type: block.type,
        blockId: findValue(created, ['block_id', 'id']),
        existed: false
      });
    } catch (error) {
      ensured.push({ name: block.name, type: block.type, blockId: '', existed: false, created: false, error: error.message });
    }
  }

  try {
    await larkCliJson([
      'base',
      '+dashboard-arrange',
      '--as',
      'user',
      '--base-token',
      config.feishu.appToken,
      '--dashboard-id',
      dashboardId
    ]);
  } catch {
    // Arrangement is cosmetic; block creation is the important part.
  }

  return {
    ok: true,
    dashboardId,
    blockCount: ensured.length,
    failedCount: ensured.filter((item) => item.error).length,
    blocks: ensured
  };
}

function teamWriter(tableId) {
  const writer = new FeishuWriter();
  writer.bitableTableId = tableId;
  writer.schemaProfile = null;
  writer.ensuredLedgerFields = false;
  return writer;
}

function normalizeAlias(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/gu, '');
}

function normalizeAliases(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  return String(value || '')
    .split(/[,，、|]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function contentFingerprint(value) {
  return createHash('sha1').update(String(value || '').trim()).digest('hex');
}

function loadTeamMembers() {
  const teamConfig = loadTeamConfig();
  return teamConfig.members
    .map((member) => ({
      name: String(member.name || '').trim(),
      openId: String(member.openId || member.open_id || '').trim(),
      aliases: [
        member.name,
        member.openId,
        ...(Array.isArray(member.aliases) ? member.aliases : [])
      ].map(normalizeAlias).filter(Boolean)
    }))
    .filter((member) => member.name && member.openId);
}

function resolveTeamMember(owner) {
  const ownerKey = normalizeAlias(owner);
  if (!ownerKey) {
    return null;
  }
  return loadTeamMembers().find((member) => member.aliases.includes(ownerKey)) || null;
}

function shouldNotifyCommitment(commitment, cooldownHours) {
  if (!commitment?.ownerOpenId || commitment.status === 'done') {
    return false;
  }
  if (!commitment.lastReminderAt) {
    return true;
  }
  const last = new Date(commitment.lastReminderAt).getTime();
  if (!Number.isFinite(last)) {
    return true;
  }
  return Date.now() - last >= Number(cooldownHours || 12) * 60 * 60 * 1000;
}

function buildOwnerNotificationText(commitment, reason = 'assigned') {
  const header = reason === 'warning' ? 'FlowMate 团队事项提醒' : 'FlowMate 已为你分派团队事项';
  return [
    header,
    `事项：${commitment.title}`,
    commitment.deadlineText || commitment.deadline ? `截止：${commitment.deadlineText || commitment.deadline}` : '',
    commitment.sourceTitle ? `来源：${commitment.sourceTitle}` : '',
    commitment.conversationSummary ? `上下文：${commitment.conversationSummary}` : '',
    commitment.sourceLink ? `链接：${commitment.sourceLink}` : ''
  ].filter(Boolean).join('\n');
}

async function notifySyncedOwners(result, tableId) {
  const commitments = Array.isArray(result?.commitments) ? result.commitments : [];
  const syncResults = Array.isArray(result?.sync?.results) ? result.sync.results : [];
  if (commitments.length === 0 || syncResults.length === 0) {
    return [];
  }

  const teamConfig = loadTeamConfig();
  const writer = teamWriter(tableId);
  const schema = await writer.getSchemaProfile();
  const notifications = [];
  for (const commitment of commitments) {
    const syncResult = syncResults.find((item) => item.id === commitment.id);
    if (!syncResult?.bitable?.recordId || syncResult.bitable.existed || !commitment.ownerOpenId) {
      continue;
    }
    try {
      const sent = await writer.sendBotMessage(
        commitment.ownerOpenId,
        buildOwnerNotificationText(commitment, 'assigned')
      );
      await writer.updateCommitmentInBitable(syncResult.bitable.recordId, {
        ...commitment,
        bitableRecordId: syncResult.bitable.recordId,
        lastReminderAt: new Date().toISOString(),
        reminderCount: 1
      }, schema);
      notifications.push({
        commitmentId: commitment.id,
        owner: commitment.owner,
        ownerOpenId: commitment.ownerOpenId,
        sent: Boolean(sent?.ok),
        reason: 'assigned'
      });
    } catch (error) {
      notifications.push({
        commitmentId: commitment.id,
        owner: commitment.owner,
        ownerOpenId: commitment.ownerOpenId,
        sent: false,
        error: error.message
      });
    }
  }

  return notifications.filter((item) => item.sent || teamConfig.alertUserOpenId);
}

function runAssistantForTeam(message, source, tableId, context) {
  const args = [
    assistantEntry,
    'auto',
    '--text',
    message.content,
    '--requester-name',
    message.senderName || '团队成员',
    '--source-type',
    SourceType.CHAT,
    '--source-title',
    `团队群：${source.name || message.chatName || source.chatId}`,
    '--source-link',
    `chat:${message.chatId}#message:${message.messageId}`,
    '--source-message-id',
    message.messageId,
    '--raw-message-text',
    message.content,
    '--conversation-summary',
    context.summary,
    '--conversation-context',
    context.text,
    '--operation-scope',
    'team'
  ];
  if (message.senderOpenId) {
    args.push('--requester-openid', message.senderOpenId);
  }
  if (message.chatId) {
    args.push('--source-chat-id', message.chatId);
  }
  if (message.threadId) {
    args.push('--source-thread-id', message.threadId);
  }

  const stdout = execFileSync(process.execPath, args, {
    cwd: flowmateRoot,
    encoding: 'utf8',
    timeout: 180000,
    windowsHide: true,
    env: {
      ...process.env,
      FLOWMATE_BITABLE_TABLE_ID: tableId
    }
  });
  return JSON.parse(stdout.trim() || '{}');
}

async function scanChatSource(source, tableId, options = {}) {
  const now = new Date();
  const end = options.end || toIsoWithOffset(now);
  const start = options.start || toIsoWithOffset(new Date(now.getTime() - Number(options.minutes || 120) * 60 * 1000));
  const pageSize = Number(options.pageSize || 50);
  const history = await listChatMessages({ chatId: source.chatId, start, end, pageSize });
  const state = loadTeamScanState();
  const sourceKey = source.id || source.chatId;
  const sourceState = state.sources?.[sourceKey] || { processedMessageIds: [] };
  const processed = new Set(options.ignoreState ? [] : sourceState.processedMessageIds || []);
  const scanned = [];
  const nextIds = [...(sourceState.processedMessageIds || [])];

  for (const message of history) {
    if (processed.has(message.messageId)) {
      continue;
    }
    if (shouldSkipTeamMessage(message)) {
      nextIds.push(message.messageId);
      scanned.push({
        messageId: message.messageId,
        senderName: message.senderName,
        content: message.content,
        ok: true,
        autoTriggered: false,
        syncState: 'skipped',
        extractedCount: 0,
        hint: '跳过 Bot/系统回执。'
      });
      continue;
    }
    const context = buildContext(message, history);
    let result;
    try {
      result = runAssistantForTeam(message, source, tableId, context);
      result.ownerNotifications = await notifySyncedOwners(result, tableId);
    } catch (error) {
      result = {
        ok: false,
        error: error.stderr ? String(error.stderr).trim() : error.message
      };
    }
    scanned.push({
      messageId: message.messageId,
      senderName: message.senderName,
      content: message.content,
      ok: result.ok === true,
      autoTriggered: Boolean(result.autoTriggered),
      syncState: result.syncState || '',
      extractedCount: result.extractedCount || result.detectedCount || 0,
      ownerNotificationCount: Array.isArray(result.ownerNotifications) ? result.ownerNotifications.filter((item) => item.sent).length : 0,
      hint: result.userFacingHint || result.error || ''
    });
    nextIds.push(message.messageId);
  }

  state.sources = {
    ...(state.sources || {}),
    [sourceKey]: {
      lastScanAt: end,
      processedMessageIds: trimIds(nextIds)
    }
  };
  saveTeamScanState(state);

  return {
    sourceId: sourceKey,
    sourceType: 'chat',
    sourceName: source.name || source.chatId,
    fetchedCount: history.length,
    processedCount: scanned.length,
    syncedCount: scanned.filter((item) => item.syncState === 'synced').length,
    skippedCount: scanned.filter((item) => item.syncState === 'skipped').length,
    failedCount: scanned.filter((item) => item.ok === false).length,
    results: scanned
  };
}

function textFromAny(value, limit = 8000) {
  const seen = new Set();
  const parts = [];
  const walk = (item) => {
    if (parts.join('\n').length > limit || item === null || item === undefined) {
      return;
    }
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed) parts.push(trimmed);
      return;
    }
    if (typeof item !== 'object' || seen.has(item)) {
      return;
    }
    seen.add(item);
    if (Array.isArray(item)) {
      item.forEach(walk);
      return;
    }
    for (const key of ['text', 'title', 'summary', 'content', 'plain_text', 'name']) {
      if (typeof item[key] === 'string') {
        walk(item[key]);
      }
    }
    Object.values(item).forEach(walk);
  };
  walk(value);
  return [...new Set(parts)].join('\n').slice(0, limit);
}

function documentTextFromFetchResult(value) {
  const candidates = [
    value?.data?.markdown,
    value?.data?.content,
    value?.data?.text,
    value?.markdown,
    value?.content,
    value?.text
  ];
  const direct = candidates.find((item) => typeof item === 'string' && item.trim());
  return direct ? direct.trim().slice(0, 8000) : textFromAny(value);
}

function extractMinuteTokens(value) {
  const tokens = new Set();
  const walk = (item) => {
    if (item === null || item === undefined) return;
    if (typeof item === 'string') {
      const match = item.match(/\b(?:obc|omc)[A-Za-z0-9]{8,}\b/gu);
      if (match) match.forEach((token) => tokens.add(token));
      return;
    }
    if (typeof item !== 'object') return;
    if (Array.isArray(item)) {
      item.forEach(walk);
      return;
    }
    for (const key of ['token', 'minute_token', 'minuteToken']) {
      if (typeof item[key] === 'string' && item[key]) {
        tokens.add(item[key]);
      }
    }
    Object.values(item).forEach(walk);
  };
  walk(value);
  return [...tokens];
}

function minutesNotesText(notesResult) {
  const notes = Array.isArray(notesResult?.data?.notes) ? notesResult.data.notes : [];
  const lines = [];
  for (const note of notes) {
    const title = note?.title || '';
    if (title) lines.push(`# ${title}`);
    const artifacts = note?.artifacts || {};
    if (Array.isArray(artifacts.todos) && artifacts.todos.length) {
      lines.push('## 妙记待办');
      for (const todo of artifacts.todos) {
        const content = typeof todo === 'string' ? todo : (todo?.content || textFromAny(todo, 1200));
        if (content) lines.push(`- ${content}`);
      }
      continue;
    }
    if (artifacts.summary) {
      lines.push('## 妙记摘要', artifacts.summary);
    }
    if (Array.isArray(artifacts.chapters) && artifacts.chapters.length) {
      lines.push('## 章节摘要');
      for (const chapter of artifacts.chapters) {
        const chapterTitle = chapter?.title || '';
        const summary = chapter?.summary_content || chapter?.summary || '';
        if (chapterTitle || summary) lines.push(`- ${chapterTitle}${summary ? `：${summary}` : ''}`);
      }
    }
  }
  return lines.join('\n').trim().slice(0, 16000);
}

function runTextExtractionForTeam({ text, sourceType, sourceTitle, tableId }) {
  const profile = loadWorkspaceUserProfile();
  ensureDir(workspaceStateDir);
  const inputPath = resolve(workspaceStateDir, `flowmate-team-input-${Date.now()}-${contentFingerprint(text).slice(0, 8)}.txt`);
  writeFileSync(inputPath, text, 'utf8');
  const contextText = text.length > 1200 ? `${text.slice(0, 1200)}\n...[truncated for command args; full text passed by --input]` : text;
  try {
    const stdout = execFileSync(process.execPath, [
    assistantEntry,
    'extract-and-sync',
    '--input',
    inputPath,
    '--requester-name',
    profile.name || '团队成员',
    '--requester-openid',
    profile.openId || '',
    '--source-type',
    sourceType,
    '--source-title',
    sourceTitle,
    '--raw-message-text',
    contextText,
    '--conversation-summary',
    sourceTitle,
    '--conversation-context',
    contextText,
    '--operation-scope',
    'team'
    ], {
      cwd: flowmateRoot,
      encoding: 'utf8',
      timeout: 180000,
      windowsHide: true,
      env: {
        ...process.env,
        FLOWMATE_BITABLE_TABLE_ID: tableId
      }
    });
    return JSON.parse(stdout.trim() || '{}');
  } finally {
    try {
      unlinkSync(inputPath);
    } catch {
      // Best effort cleanup.
    }
  }
}

async function scanDocumentSource(source, tableId) {
  const fetched = await larkCliJson([
    'docs',
    '+fetch',
    '--as',
    'user',
    '--doc',
    source.doc || source.docToken || source.url,
    '--format',
    'json'
  ]);
  const text = documentTextFromFetchResult(fetched);
  if (!text) {
    return { sourceId: source.id, sourceType: 'document', processedCount: 0, syncedCount: 0, results: [] };
  }
  const state = loadTeamScanState();
  const sourceKey = source.id || source.doc || source.docToken || source.url;
  const fingerprint = contentFingerprint(text);
  if (!source.force && state.sources?.[sourceKey]?.contentFingerprint === fingerprint) {
    return {
      sourceId: sourceKey,
      sourceType: 'document',
      processedCount: 0,
      syncedCount: 0,
      skippedCount: 1,
      results: [{ ok: true, syncState: 'skipped', hint: '文档内容未变化，跳过重复扫描。' }]
    };
  }
  const result = runTextExtractionForTeam({
    text,
    sourceType: SourceType.DOCUMENT,
    sourceTitle: `团队文档：${source.name || source.doc || source.docToken || source.url}`,
    tableId
  });
  result.ownerNotifications = await notifySyncedOwners(result, tableId);
  state.sources = {
    ...(state.sources || {}),
    [sourceKey]: {
      ...(state.sources?.[sourceKey] || {}),
      lastScanAt: new Date().toISOString(),
      contentFingerprint: fingerprint
    }
  };
  saveTeamScanState(state);
  return {
    sourceId: sourceKey,
    sourceType: 'document',
    processedCount: 1,
    syncedCount: result.syncState === 'synced' ? result.extractedCount || 0 : 0,
    results: [result]
  };
}

async function scanDocumentCommentsSource(source, tableId) {
  const fileToken = source.fileToken || source.file_token || source.doc || source.docToken || source.url;
  const fileType = source.fileType || source.file_type || 'docx';
  const comments = await larkCliJson([
    'drive',
    'file.comments',
    'list',
    '--as',
    'user',
    '--params',
    JSON.stringify({
      file_token: fileToken,
      file_type: fileType,
      user_id_type: 'open_id'
    })
  ]);
  const text = textFromAny(comments);
  if (!text) {
    return { sourceId: source.id || fileToken, sourceType: 'document-comments', processedCount: 0, syncedCount: 0, results: [] };
  }

  const sourceKey = source.id || fileToken;
  const state = loadTeamScanState();
  const fingerprint = contentFingerprint(text);
  if (!source.force && state.sources?.[sourceKey]?.contentFingerprint === fingerprint) {
    return {
      sourceId: sourceKey,
      sourceType: 'document-comments',
      processedCount: 0,
      syncedCount: 0,
      skippedCount: 1,
      results: [{ ok: true, syncState: 'skipped', hint: '文档评论未变化，跳过重复扫描。' }]
    };
  }

  const result = runTextExtractionForTeam({
    text,
    sourceType: SourceType.DOCUMENT,
    sourceTitle: `团队文档评论：${source.name || fileToken}`,
    tableId
  });
  result.ownerNotifications = await notifySyncedOwners(result, tableId);
  state.sources = {
    ...(state.sources || {}),
    [sourceKey]: {
      ...(state.sources?.[sourceKey] || {}),
      lastScanAt: new Date().toISOString(),
      contentFingerprint: fingerprint
    }
  };
  saveTeamScanState(state);

  return {
    sourceId: sourceKey,
    sourceType: 'document-comments',
    processedCount: 1,
    syncedCount: result.syncState === 'synced' ? result.extractedCount || 0 : 0,
    results: [result]
  };
}

async function scanMinutesSource(source, tableId, options = {}) {
  const now = new Date();
  let searched = null;
  let tokens = source.minuteToken || source['minute-token'] || source.token
    ? [source.minuteToken || source['minute-token'] || source.token]
    : [];
  if (tokens.length === 0) {
    const args = [
      'minutes',
      '+search',
      '--as',
      'user',
      '--query',
      source.query || source.name || '会议',
      '--start',
      options.start || toIsoWithOffset(new Date(now.getTime() - Number(options.minutes || 24 * 60) * 60 * 1000)),
      '--end',
      options.end || toIsoWithOffset(now),
      '--page-size',
      String(source.pageSize || 10),
      '--format',
      'json'
    ];
    searched = await larkCliJson(args);
    tokens = extractMinuteTokens(searched).slice(0, Number(source.pageSize || 10));
  }

  const notesTexts = [];
  const noteResults = [];
  for (const token of tokens) {
    try {
      const notes = await larkCliJson([
        'vc',
        '+notes',
        '--as',
        'user',
        '--minute-tokens',
        token,
        '--format',
        'json'
      ], { timeout: 180000 });
      noteResults.push({ token, ok: true });
      const noteText = minutesNotesText(notes);
      if (noteText) notesTexts.push(noteText);
    } catch (error) {
      noteResults.push({ token, ok: false, error: error.message });
    }
  }

  const text = notesTexts.join('\n\n---\n\n') || textFromAny(searched);
  if (!text) {
    return { sourceId: source.id, sourceType: 'minutes', processedCount: 0, syncedCount: 0, tokens, noteResults, results: [] };
  }
  const state = loadTeamScanState();
  const sourceKey = source.id || source.query || 'minutes';
  const fingerprint = contentFingerprint(text);
  if (!source.force && state.sources?.[sourceKey]?.contentFingerprint === fingerprint) {
    return {
      sourceId: sourceKey,
      sourceType: 'minutes',
      processedCount: 0,
      syncedCount: 0,
      skippedCount: 1,
      tokens,
      noteResults,
      results: [{ ok: true, syncState: 'skipped', hint: '会议纪要搜索结果未变化，跳过重复扫描。' }]
    };
  }
  const result = runTextExtractionForTeam({
    text,
    sourceType: SourceType.MINUTES,
    sourceTitle: `团队会议纪要：${source.name || source.query || '会议纪要搜索'}`,
    tableId
  });
  result.ownerNotifications = await notifySyncedOwners(result, tableId);
  state.sources = {
    ...(state.sources || {}),
    [sourceKey]: {
      ...(state.sources?.[sourceKey] || {}),
      lastScanAt: new Date().toISOString(),
      contentFingerprint: fingerprint
    }
  };
  saveTeamScanState(state);
  return {
    sourceId: sourceKey,
    sourceType: 'minutes',
    processedCount: 1,
    syncedCount: result.syncState === 'synced' ? result.extractedCount || 0 : 0,
    tokens,
    noteResults,
    results: [result]
  };
}

export async function configureTeamSource(args = {}) {
  const teamConfig = loadTeamConfig();
  const type = args.type || (args.comments || args['file-token']
    ? 'document-comments'
    : (args['chat-id'] ? 'chat' : args.doc || args['doc-token'] ? 'document' : args.query ? 'minutes' : 'chat'));
  const id = args.id || args['chat-id'] || args['file-token'] || args.doc || args['doc-token'] || args.query || `${type}-${Date.now()}`;
  const source = {
    id,
    type,
    name: args.name || id,
    enabled: args.enabled !== 'false',
    chatId: args['chat-id'] || '',
    doc: args.doc || args['doc-token'] || args.url || '',
    fileToken: args['file-token'] || '',
    fileType: args['file-type'] || '',
    query: args.query || '',
    minuteToken: args['minute-token'] || args.minuteToken || args.token || '',
    force: args.force === 'true'
  };
  const sources = teamConfig.sources.filter((item) => item.id !== id);
  const next = { ...teamConfig, sources: [...sources, source] };
  saveTeamConfig(next);
  return {
    ok: true,
    action: 'team-source-add',
    source,
    configPath: teamConfigPath,
    userFacingHint: `团队固定来源已配置：${source.name}。`
  };
}

export async function configureTeamMember(args = {}) {
  const teamConfig = loadTeamConfig();
  const openId = String(args['open-id'] || args.openId || args.open_id || '').trim();
  const name = String(args.name || '').trim();
  if (!name || !openId) {
    throw new Error('缺少团队成员 name 或 open-id。');
  }

  const member = {
    name,
    openId,
    aliases: normalizeAliases(args.aliases || args.alias || '')
  };
  const members = teamConfig.members.filter((item) =>
    item.openId !== openId &&
    normalizeAlias(item.name) !== normalizeAlias(name)
  );
  saveTeamConfig({ ...teamConfig, members: [...members, member] });
  return {
    ok: true,
    action: 'team-member-add',
    member,
    userFacingHint: `团队成员映射已保存：${name}。`
  };
}

export async function listTeamMembers() {
  const members = loadTeamConfig().members.map((member) => ({
    name: member.name || '',
    openId: member.openId || '',
    aliases: Array.isArray(member.aliases) ? member.aliases : []
  }));
  return {
    ok: true,
    action: 'team-member-list',
    members,
    memberCount: members.length,
    userFacingHint: members.length === 0
      ? '当前还没有配置团队成员映射。'
      : [
        `当前团队成员映射 ${members.length} 个：`,
        ...members.map((member) => `- ${member.name} (${member.openId})`)
      ].join('\n')
  };
}

export async function removeTeamMember(args = {}) {
  const teamConfig = loadTeamConfig();
  const key = normalizeAlias(args.name || args['open-id'] || args.openId || '');
  if (!key) {
    throw new Error('缺少团队成员 name 或 open-id。');
  }
  const members = teamConfig.members.filter((member) =>
    normalizeAlias(member.name) !== key &&
    normalizeAlias(member.openId) !== key &&
    !(Array.isArray(member.aliases) && member.aliases.map(normalizeAlias).includes(key))
  );
  if (members.length === teamConfig.members.length) {
    return {
      ok: false,
      action: 'team-member-remove',
      userFacingHint: `没有找到团队成员映射：${args.name || args['open-id'] || args.openId}`
    };
  }
  saveTeamConfig({ ...teamConfig, members });
  return {
    ok: true,
    action: 'team-member-remove',
    userFacingHint: `已移除团队成员映射：${args.name || args['open-id'] || args.openId}`
  };
}

export async function listTeamSources() {
  const teamConfig = loadTeamConfig();
  const sources = teamConfig.sources.map((source) => ({
    id: source.id,
    type: source.type,
    name: source.name,
    enabled: source.enabled !== false,
    chatId: source.chatId || '',
    doc: source.doc || source.docToken || source.url || '',
    query: source.query || ''
  }));

  return {
    ok: true,
    action: 'team-source-list',
    sources,
    sourceCount: sources.length,
    enabledSourceCount: sources.filter((source) => source.enabled).length,
    configPath: teamConfigPath,
    userFacingHint: sources.length === 0
      ? '当前还没有配置团队固定来源。'
      : [
        `当前团队固定来源 ${sources.filter((source) => source.enabled).length}/${sources.length} 个启用：`,
        ...sources.map((source) => `- ${source.enabled ? '启用' : '停用'} ${source.name} (${source.type})`)
      ].join('\n')
  };
}

function resolveSourceId(args = {}) {
  return args.id || args['source-id'] || args['chat-id'] || args['file-token'] || args.doc || args['doc-token'] || args.query || '';
}

export async function updateTeamSourceState(args = {}, enabled) {
  const teamConfig = loadTeamConfig();
  const sourceId = resolveSourceId(args);
  if (!sourceId) {
    throw new Error('缺少团队来源 id 或 chat-id。');
  }

  let matched = false;
  const sources = teamConfig.sources.map((source) => {
    if (source.id === sourceId || source.chatId === sourceId || source.doc === sourceId || source.query === sourceId) {
      matched = true;
      return { ...source, enabled };
    }
    return source;
  });
  if (!matched) {
    return {
      ok: false,
      action: enabled ? 'team-source-enable' : 'team-source-disable',
      sourceId,
      userFacingHint: `没有找到团队来源：${sourceId}`
    };
  }

  saveTeamConfig({ ...teamConfig, sources });
  return {
    ok: true,
    action: enabled ? 'team-source-enable' : 'team-source-disable',
    sourceId,
    userFacingHint: `${enabled ? '已启用' : '已停用'}团队来源：${sourceId}`
  };
}

export async function removeTeamSource(args = {}) {
  const teamConfig = loadTeamConfig();
  const state = loadTeamScanState();
  const sourceId = resolveSourceId(args);
  if (!sourceId) {
    throw new Error('缺少团队来源 id 或 chat-id。');
  }

  const before = teamConfig.sources.length;
  const sources = teamConfig.sources.filter((source) =>
    source.id !== sourceId &&
    source.chatId !== sourceId &&
    source.doc !== sourceId &&
    source.query !== sourceId
  );
  if (sources.length === before) {
    return {
      ok: false,
      action: 'team-source-remove',
      sourceId,
      userFacingHint: `没有找到团队来源：${sourceId}`
    };
  }

  if (state.sources && typeof state.sources === 'object') {
    delete state.sources[sourceId];
  }
  saveTeamConfig({ ...teamConfig, sources });
  saveTeamScanState(state);

  return {
    ok: true,
    action: 'team-source-remove',
    sourceId,
    userFacingHint: `已移除团队来源：${sourceId}`
  };
}

function buildTeamMetrics(commitments) {
  const now = new Date();
  const weekStart = new Date(now);
  const day = weekStart.getDay() || 7;
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - day + 1);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 7);

  const active = commitments.filter((item) => item.status !== 'done');
  const ownerMap = new Map();
  for (const item of commitments) {
    const owner = item.owner || '未识别';
    const current = ownerMap.get(owner) || { total: 0, active: 0, overdue: 0, blocked: 0 };
    current.total += 1;
    if (item.status !== 'done') current.active += 1;
    if (isOverdue(item)) current.overdue += 1;
    if (item.status === 'blocked') current.blocked += 1;
    ownerMap.set(owner, current);
  }

  const metrics = [
    { metric: '本周新增', value: commitments.filter((item) => new Date(item.createdAt || 0) >= weekStart).length, dimension: 'global', owner: '', period: 'this_week' },
    { metric: '待完成', value: active.length, dimension: 'global', owner: '', period: 'current' },
    { metric: '临期24小时', value: commitments.filter((item) => isDueSoon(item, 24)).length, dimension: 'global', owner: '', period: 'next_24h' },
    { metric: '逾期', value: commitments.filter((item) => isOverdue(item)).length, dimension: 'global', owner: '', period: 'current' },
    { metric: '阻塞', value: commitments.filter((item) => item.status === 'blocked').length, dimension: 'global', owner: '', period: 'current' },
    { metric: '本周到期', value: commitments.filter((item) => {
      if (!item.deadline || item.status === 'done') return false;
      const deadline = new Date(item.deadline);
      return deadline >= weekStart && deadline < weekEnd;
    }).length, dimension: 'global', owner: '', period: 'this_week' }
  ];

  for (const [owner, counts] of ownerMap.entries()) {
    metrics.push({ metric: '负责人待完成', value: counts.active, dimension: 'owner', owner, period: 'current' });
    metrics.push({ metric: '负责人逾期', value: counts.overdue, dimension: 'owner', owner, period: 'current' });
    metrics.push({ metric: '负责人阻塞', value: counts.blocked, dimension: 'owner', owner, period: 'current' });
  }

  return metrics;
}

function formatCommitmentLine(item) {
  return [
    item.title || '未命名事项',
    item.owner || '未识别',
    item.deadlineText || item.deadline || '无截止',
    item.status || 'pending'
  ].join(' | ');
}

function loadTeamCommitments() {
  return (async () => {
    const table = await ensureTeamTable();
    const writer = teamWriter(table.tableId);
    const schema = await writer.getSchemaProfile();
    const records = writer.normalizeBitableRecords(await writer.listBitableRecords());
    return {
      table,
      writer,
      schema,
      records,
      commitments: records.map((record) => writer.buildCommitmentFromRecord(record, schema))
    };
  })();
}

function buildTeamDigestText({ commitments, metrics, period = 'daily' }) {
  const overdue = commitments.filter((item) => isOverdue(item));
  const dueSoon = commitments.filter((item) => isDueSoon(item, 24));
  const blocked = commitments.filter((item) => item.status === 'blocked');
  const active = commitments.filter((item) => item.status !== 'done');
  const recent = [...active]
    .sort((left, right) => new Date(left.deadline || '2999-12-31').getTime() - new Date(right.deadline || '2999-12-31').getTime())
    .slice(0, 8);
  const ownerMetrics = metrics
    .filter((item) => item.dimension === 'owner' && item.metric === '负责人待完成' && Number(item.value) > 0)
    .slice(0, 8);

  return [
    `FlowMate 团队${period === 'weekly' ? '周' : '日'}推进摘要`,
    `待完成：${active.length} 条`,
    `逾期：${overdue.length} 条`,
    `临期24小时：${dueSoon.length} 条`,
    `阻塞：${blocked.length} 条`,
    '',
    '重点风险：',
    ...([...overdue, ...dueSoon, ...blocked].slice(0, 6).map((item) => `- ${formatCommitmentLine(item)}`)),
    overdue.length + dueSoon.length + blocked.length === 0 ? '- 暂无明显风险' : '',
    '',
    '按负责人待完成：',
    ...(ownerMetrics.length ? ownerMetrics.map((item) => `- ${item.owner}：${item.value} 条`) : ['- 暂无待完成事项']),
    '',
    '下一批建议关注：',
    ...(recent.length ? recent.map((item) => `- ${formatCommitmentLine(item)}`) : ['- 当前团队总表为空'])
  ].filter((line) => line !== '').join('\n');
}

export async function buildAndPushTeamDigest(args = {}) {
  const teamConfig = loadTeamConfig();
  const { table, commitments } = await loadTeamCommitments();
  const metrics = buildTeamMetrics(commitments);
  const text = buildTeamDigestText({ commitments, metrics, period: args.period || 'daily' });
  const writer = teamWriter(table.tableId);
  let sent = null;
  const targetOpenId = args['user-id'] || args['user-open-id'] || teamConfig.alertUserOpenId;
  if (args.notify === 'true' && targetOpenId) {
    sent = await writer.sendBotMessage(targetOpenId, text);
  }
  return {
    ok: true,
    action: 'team-digest',
    table,
    period: args.period || 'daily',
    metricCount: metrics.length,
    commitmentCount: commitments.length,
    notified: Boolean(sent?.ok),
    targetOpenId: targetOpenId || '',
    message: text,
    userFacingHint: text
  };
}

function evidenceTextForCommitment(item) {
  return [
    `事项：${item.title}`,
    `负责人：${item.owner || '未识别'}`,
    `状态：${item.status || 'pending'}`,
    `截止：${item.deadlineText || item.deadline || '无'}`,
    `来源：${item.sourceTitle || item.sourceType || '未知'}`,
    item.sourceLink ? `链接：${item.sourceLink}` : '',
    item.rawMessageText ? `原文：${item.rawMessageText}` : '',
    item.conversationSummary ? `上下文摘要：${item.conversationSummary}` : '',
    item.conversationContext ? `上下文：${String(item.conversationContext).slice(0, 800)}` : ''
  ].filter(Boolean).join('\n');
}

function scoreKnowledgeCandidate(item, query) {
  const normalizedQuery = normalizeAlias(query);
  const haystack = normalizeAlias([
    item.title,
    item.owner,
    item.status,
    item.deadlineText,
    item.sourceTitle,
    item.rawMessageText,
    item.conversationSummary,
    item.conversationContext
  ].filter(Boolean).join(' '));
  if (!normalizedQuery) return 0;
  if (haystack.includes(normalizedQuery)) return 100;
  let score = 0;
  for (const char of new Set(normalizedQuery.split(''))) {
    if (haystack.includes(char)) score += 1;
  }
  return score;
}

export async function answerTeamKnowledgeQuestion(args = {}) {
  const question = String(args.question || args.query || args.text || '').trim();
  if (!question) {
    throw new Error('缺少知识问答问题。');
  }
  const { table, commitments } = await loadTeamCommitments();
  const candidates = commitments
    .map((item) => ({ item, score: scoreKnowledgeCandidate(item, question) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, Number(args.limit || 6));
  const evidence = candidates.map(({ item }, index) => ({
    index: index + 1,
    title: item.title,
    owner: item.owner || '',
    sourceTitle: item.sourceTitle || '',
    sourceLink: item.sourceLink || '',
    sourceMessageId: item.sourceMessageId || '',
    text: evidenceTextForCommitment(item)
  }));

  if (evidence.length === 0) {
    return {
      ok: true,
      action: 'team-knowledge-qa',
      table,
      question,
      answer: '团队总表里暂时没有找到足够相关的证据。我不会编造答案。',
      evidence: [],
      userFacingHint: '团队总表里暂时没有找到足够相关的证据。我不会编造答案。'
    };
  }

  const systemPrompt = [
    '你是 FlowMate 的团队知识问答助手。',
    '只能基于给定证据回答，不要编造。',
    '回答要简洁，必须附上证据编号和来源标题；如果证据不足，明确说证据不足。'
  ].join('\n');
  const prompt = [
    `问题：${question}`,
    '',
    '证据：',
    ...evidence.map((item) => `[${item.index}] ${item.text}`)
  ].join('\n');

  let answer = '';
  try {
    answer = await modelClient.complete(prompt, systemPrompt);
  } catch {
    answer = [
      '我找到了相关证据，但模型回答暂时不可用。相关证据如下：',
      ...evidence.map((item) => `[${item.index}] ${item.title} | ${item.owner || '未识别'} | ${item.sourceTitle || '未知来源'}`)
    ].join('\n');
  }

  const lines = [
    String(answer || '').trim(),
    '',
    '证据来源：',
    ...evidence.map((item) => `- [${item.index}] ${item.title} | ${item.sourceTitle || '未知来源'}${item.sourceLink ? ` | ${item.sourceLink}` : ''}`)
  ];

  return {
    ok: true,
    action: 'team-knowledge-qa',
    table,
    question,
    answer: lines.join('\n').trim(),
    evidence,
    userFacingHint: lines.join('\n').trim()
  };
}

export async function listUnassignedTeamCommitments() {
  const { table, commitments } = await loadTeamCommitments();
  const unassigned = commitments.filter((item) => !item.ownerOpenId || !item.owner || item.owner === '待确认');
  return {
    ok: true,
    action: 'team-unassigned-list',
    table,
    count: unassigned.length,
    items: unassigned.map((item) => ({
      id: item.id,
      title: item.title,
      owner: item.owner || '',
      recordId: item.bitableRecordId
    })),
    userFacingHint: unassigned.length === 0
      ? '当前没有待确认负责人的团队事项。'
      : [
        `当前有 ${unassigned.length} 条待确认负责人的团队事项：`,
        ...unassigned.slice(0, 10).map((item) => `- ${item.title} (${item.bitableRecordId || item.id})`)
      ].join('\n')
  };
}

export async function reassignTeamCommitment(args = {}) {
  const target = String(args.target || args['target-text'] || args.id || '').trim();
  const ownerName = String(args.name || args.owner || '').trim();
  const ownerOpenId = String(args['open-id'] || args.openId || args.ownerOpenId || '').trim();
  if (!target || !ownerName || !ownerOpenId) {
    throw new Error('缺少 target、name 或 open-id，无法重分派团队事项。');
  }

  await configureTeamMember({ name: ownerName, 'open-id': ownerOpenId, aliases: args.aliases || '' });
  const { table, writer, schema, commitments } = await loadTeamCommitments();
  const normalizedTarget = normalizeAlias(target);
  const matched = commitments.find((item) =>
    normalizeAlias(item.bitableRecordId) === normalizedTarget ||
    normalizeAlias(item.id) === normalizedTarget ||
    normalizeAlias(item.title).includes(normalizedTarget)
  );
  if (!matched) {
    return {
      ok: false,
      action: 'team-reassign',
      userFacingHint: `没有找到团队事项：${target}`
    };
  }

  const next = {
    ...matched,
    owner: ownerName,
    ownerOpenId,
    assignedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await writer.updateCommitmentInBitable(matched.bitableRecordId, next, schema);
  if (matched.feishuTaskId) {
    await writer.updateTask(matched.feishuTaskId, next);
  }
  const sent = await writer.sendBotMessage(ownerOpenId, buildOwnerNotificationText(next, 'assigned'));
  return {
    ok: true,
    action: 'team-reassign',
    table,
    item: {
      id: next.id,
      title: next.title,
      owner: next.owner,
      ownerOpenId: next.ownerOpenId,
      recordId: next.bitableRecordId
    },
    notified: Boolean(sent?.ok),
    userFacingHint: `已将“${next.title}”分派给 ${ownerName}，并同步任务/通知。`
  };
}

async function upsertMetricRecord(tableId, metric) {
  const recordsResult = await larkCliJson([
    'base',
    '+record-list',
    '--as',
    'user',
    '--base-token',
    config.feishu.appToken,
    '--table-id',
    tableId,
    '--format',
    'json'
  ]);
  const fields = recordsResult?.data?.fields || [];
  const rows = recordsResult?.data?.data || [];
  const recordIds = recordsResult?.data?.record_id_list || [];
  const existingIndex = rows.findIndex((row) => {
    const record = Object.fromEntries(fields.map((field, index) => [field, row[index]]));
    return String(record['指标'] || '') === metric.metric &&
      String(record['维度'] || '') === metric.dimension &&
      String(record['负责人'] || '') === metric.owner &&
      String(record['周期'] || '') === metric.period;
  });
  const json = {
    指标: metric.metric,
    数值: String(metric.value),
    维度: metric.dimension,
    负责人: metric.owner,
    周期: metric.period,
    更新时间: String(Date.now()),
    说明: metric.note || ''
  };
  const args = [
    'base',
    '+record-upsert',
    '--as',
    'user',
    '--base-token',
    config.feishu.appToken,
    '--table-id',
    tableId,
    '--json',
    JSON.stringify(json)
  ];
  if (existingIndex >= 0 && recordIds[existingIndex]) {
    args.splice(args.length - 2, 0, '--record-id', recordIds[existingIndex]);
  }
  return await larkCliJson(args);
}

export async function refreshTeamDashboardMetrics() {
  const table = await ensureTeamTable();
  const dashboard = await ensureTeamViewsAndDashboard(table.tableId);
  const metricsTable = await ensureTeamMetricsTable();
  const writer = teamWriter(table.tableId);
  const schema = await writer.getSchemaProfile();
  const records = writer.normalizeBitableRecords(await writer.listBitableRecords());
  const commitments = records.map((record) => writer.buildCommitmentFromRecord(record, schema));
  const metrics = buildTeamMetrics(commitments);
  const updates = [];
  for (const metric of metrics) {
    updates.push(await upsertMetricRecord(metricsTable.tableId, metric));
  }
  return {
    ok: true,
    action: 'team-dashboard-refresh',
    table,
    metricsTable,
    dashboard,
    metricCount: metrics.length,
    metrics,
    updatedCount: updates.length,
    userFacingHint: `团队驾驶舱指标已刷新：${metrics.length} 项。`
  };
}

export async function subscribeTeamTaskEvents() {
  let subscription = null;
  try {
    subscription = await larkCliJson([
      'task',
      '+subscribe-event',
      '--as',
      'user'
    ]);
  } catch (error) {
    return {
      ok: false,
      action: 'team-subscribe-task-events',
      error: error.message,
      userFacingHint: `任务事件订阅失败：${error.message}。当前仍可用团队 watcher 周期同步状态。`
    };
  }

  const state = {
    subscribedAt: new Date().toISOString(),
    subscription,
    note: 'FlowMate subscribes to Feishu task events when supported by lark-cli; watch:team keeps periodic status reconciliation as the safety net.'
  };
  writeJson(teamEventSubscriptionPath, state);

  return {
    ok: true,
    action: 'team-subscribe-task-events',
    statePath: teamEventSubscriptionPath,
    subscription,
    userFacingHint: '已订阅飞书任务事件；团队 watcher 仍会周期对账，保证事件未送达时也能回写状态。'
  };
}

export async function scanTeamSources(args = {}) {
  const teamConfig = loadTeamConfig();
  if (!teamConfig.enabled) {
    return { ok: true, action: 'team-scan-once', scanState: 'disabled', userFacingHint: '团队扫描当前是关闭状态。' };
  }

  const table = await ensureTeamTable();
  await ensureTeamViewsAndDashboard(table.tableId);
  const adHocSource = args['chat-id']
    ? { id: args['chat-id'], type: 'chat', name: args.name || args['chat-id'], chatId: args['chat-id'], enabled: true }
    : null;
  const sources = adHocSource ? [adHocSource] : teamConfig.sources.filter((source) => source.enabled !== false);
  if (sources.length === 0) {
    return {
      ok: true,
      action: 'team-scan-once',
      table,
      processedSourceCount: 0,
      userFacingHint: '还没有配置团队固定来源。请先配置群聊、文档或会议纪要来源。'
    };
  }

  const results = [];
  for (const source of sources) {
    if (source.type === 'chat' && source.chatId) {
      results.push(await scanChatSource(source, table.tableId, args));
    } else if (source.type === 'document' && (source.doc || source.docToken || source.url)) {
      results.push(await scanDocumentSource(source, table.tableId));
    } else if (source.type === 'document-comments' && (source.fileToken || source.doc || source.docToken || source.url)) {
      results.push(await scanDocumentCommentsSource(source, table.tableId));
    } else if (source.type === 'minutes') {
      results.push(await scanMinutesSource(source, table.tableId, args));
    }
  }

  const syncedCount = results.reduce((sum, item) => sum + (item.syncedCount || 0), 0);
  let linkedStatusSync = null;
  let dashboard = null;
  try {
    linkedStatusSync = await syncTeamLinkedStatuses();
  } catch {
    linkedStatusSync = null;
  }
  try {
    dashboard = await refreshTeamDashboardMetrics();
  } catch {
    dashboard = null;
  }
  return {
    ok: true,
    action: 'team-scan-once',
    table,
    processedSourceCount: results.length,
    syncedCount,
    linkedStatusUpdatedCount: linkedStatusSync?.updatedCount || 0,
    dashboardMetricCount: dashboard?.metricCount || 0,
    results,
    userFacingHint: syncedCount > 0
      ? `团队扫描完成，已同步 ${syncedCount} 条重点事项。`
      : '团队扫描完成，本轮没有新增重点事项。'
  };
}

export async function syncTeamLinkedStatuses() {
  const table = await ensureTeamTable();
  const writer = teamWriter(table.tableId);
  const result = await writer.syncLinkedStatuses();
  return {
    ok: true,
    action: 'team-sync-statuses',
    table,
    ...result,
    userFacingHint: `团队总表已回写 ${result.updatedCount} 条关联状态。`
  };
}

export async function buildTeamWarnings(args = {}) {
  const teamConfig = loadTeamConfig();
  const table = await ensureTeamTable();
  const writer = teamWriter(table.tableId);
  const schema = await writer.getSchemaProfile();
  const records = writer.normalizeBitableRecords(await writer.listBitableRecords());
  const commitments = records.map((record) => writer.buildCommitmentFromRecord(record, schema));
  const overdue = commitments.filter((item) => isOverdue(item));
  const dueSoon = commitments.filter((item) => isDueSoon(item, Number(args.hours || 24)));
  const blocked = commitments.filter((item) => item.status === 'blocked');
  const lines = [
    'FlowMate 团队重点事项预警',
    `逾期：${overdue.length} 条`,
    `未来 ${Number(args.hours || 24)} 小时临期：${dueSoon.length} 条`,
    `阻塞：${blocked.length} 条`
  ];
  const topItems = [...overdue, ...dueSoon, ...blocked].slice(0, 8);
  for (const item of topItems) {
    lines.push(`- ${item.title} | ${item.owner || '未识别'} | ${item.deadlineText || item.deadline || '无截止时间'} | ${item.status}`);
  }

  let notification = null;
  if (args.notify === 'true' && teamConfig.alertUserOpenId) {
    notification = await writer.sendBotMessage(teamConfig.alertUserOpenId, lines.join('\n'));
  }
  const ownerNotifications = [];
  if (args['notify-owners'] === 'true') {
    for (const item of topItems) {
      if (!shouldNotifyCommitment(item, teamConfig.reminderCooldownHours)) {
        continue;
      }
      try {
        const sent = await writer.sendBotMessage(item.ownerOpenId, buildOwnerNotificationText(item, 'warning'));
        await writer.updateCommitmentInBitable(item.bitableRecordId, {
          ...item,
          lastReminderAt: new Date().toISOString(),
          reminderCount: Number(item.reminderCount || 0) + 1
        }, schema);
        ownerNotifications.push({
          id: item.id,
          title: item.title,
          owner: item.owner,
          ownerOpenId: item.ownerOpenId,
          sent: Boolean(sent?.ok)
        });
      } catch (error) {
        ownerNotifications.push({
          id: item.id,
          title: item.title,
          owner: item.owner,
          ownerOpenId: item.ownerOpenId,
          sent: false,
          error: error.message
        });
      }
    }
  }

  return {
    ok: true,
    action: 'team-warn',
    table,
    warningCount: overdue.length + dueSoon.length + blocked.length,
    overdueCount: overdue.length,
    dueSoonCount: dueSoon.length,
    blockedCount: blocked.length,
    notified: Boolean(notification?.ok),
    ownerNotifiedCount: ownerNotifications.filter((item) => item.sent).length,
    ownerNotifications,
    message: lines.join('\n'),
    userFacingHint: lines.join('\n')
  };
}

export async function getTeamStatus() {
  const teamConfig = loadTeamConfig();
  const state = loadTeamScanState();
  const eventSubscription = readJson(teamEventSubscriptionPath, null);
  return {
    ok: true,
    action: 'team-status',
    enabled: teamConfig.enabled,
    tableName: teamConfig.tableName,
    tableId: teamConfig.tableId,
    metricsTableName: teamConfig.metricsTableName,
    metricsTableId: teamConfig.metricsTableId,
    sourceCount: teamConfig.sources.length,
    enabledSourceCount: teamConfig.sources.filter((source) => source.enabled !== false).length,
    memberCount: teamConfig.members.length,
    configPath: teamConfigPath,
    statePath: teamScanStatePath,
    eventSubscriptionPath: teamEventSubscriptionPath,
    eventSubscription,
    scanState: state,
    userFacingHint: [
      `团队扫描：${teamConfig.enabled ? 'enabled' : 'disabled'}`,
      `团队总表：${teamConfig.tableName}${teamConfig.tableId ? ` (${teamConfig.tableId})` : '（未创建）'}`,
      `固定来源：${teamConfig.sources.filter((source) => source.enabled !== false).length}/${teamConfig.sources.length}`,
      `成员映射：${teamConfig.members.length}`,
      `任务事件订阅：${eventSubscription?.subscribedAt ? eventSubscription.subscribedAt : 'not subscribed'}`
    ].join('\n')
  };
}

export async function handleTeamCommand(command, args = {}) {
  if (command === 'team-source-add') {
    return await configureTeamSource(args);
  }
  if (command === 'team-member-add') {
    return await configureTeamMember(args);
  }
  if (command === 'team-member-list') {
    return await listTeamMembers();
  }
  if (command === 'team-member-remove') {
    return await removeTeamMember(args);
  }
  if (command === 'team-source-add-current') {
    if (!args['source-chat-id'] && !args['chat-id']) {
      throw new Error('缺少当前群聊 chat-id，无法加入团队扫描。');
    }
    return await configureTeamSource({
      ...args,
      type: 'chat',
      id: args['source-chat-id'] || args['chat-id'],
      'chat-id': args['source-chat-id'] || args['chat-id'],
      name: args['source-title'] || args.name || args['source-chat-id'] || args['chat-id']
    });
  }
  if (command === 'team-source-list') {
    return await listTeamSources();
  }
  if (command === 'team-source-remove' || command === 'team-source-remove-current') {
    return await removeTeamSource({
      ...args,
      id: args.id || args['source-id'] || args['source-chat-id'] || args['chat-id']
    });
  }
  if (command === 'team-source-enable') {
    return await updateTeamSourceState(args, true);
  }
  if (command === 'team-source-disable') {
    return await updateTeamSourceState(args, false);
  }
  if (command === 'team-scan-once') {
    return await scanTeamSources(args);
  }
  if (command === 'team-sync-statuses') {
    return await syncTeamLinkedStatuses();
  }
  if (command === 'team-warn') {
    return await buildTeamWarnings(args);
  }
  if (command === 'team-dashboard-refresh') {
    return await refreshTeamDashboardMetrics();
  }
  if (command === 'team-subscribe-task-events') {
    return await subscribeTeamTaskEvents();
  }
  if (command === 'team-digest') {
    return await buildAndPushTeamDigest(args);
  }
  if (command === 'team-knowledge-qa') {
    return await answerTeamKnowledgeQuestion(args);
  }
  if (command === 'team-unassigned-list') {
    return await listUnassignedTeamCommitments();
  }
  if (command === 'team-reassign') {
    return await reassignTeamCommitment(args);
  }
  if (command === 'team-ensure') {
    const table = await ensureTeamTable();
    const extras = await ensureTeamViewsAndDashboard(table.tableId);
    const metricsTable = await ensureTeamMetricsTable();
    const dashboard = await refreshTeamDashboardMetrics();
    return {
      ok: true,
      action: 'team-ensure',
      table,
      metricsTable,
      dashboardMetricCount: dashboard.metricCount,
      ...extras,
      userFacingHint: `团队总表和视图已准备好：${table.tableName}。`
    };
  }
  return await getTeamStatus();
}
