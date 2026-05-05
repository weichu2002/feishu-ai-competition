import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../src/config.js';
import { larkCliJson } from '../src/lark-cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCAL_CONFIG_PATH = resolve(__dirname, '..', '.flowmate.local.json');
const ENV_PATH = resolve(__dirname, '..', '.env');

const BASE_NAME = '[FlowMate测试] FlowMate_Commitment_Ledger';
const PREFERRED_TABLE_NAME = '承诺账本';

const FIELD_DEFINITIONS = [
  { name: '承诺标题', type: 'text', style: { type: 'plain' } },
  { name: '承诺ID', type: 'text', style: { type: 'plain' } },
  { name: '负责人', type: 'text', style: { type: 'plain' } },
  { name: '负责人OpenID', type: 'text', style: { type: 'plain' } },
  { name: '截止时间文本', type: 'text', style: { type: 'plain' } },
  { name: '标准截止时间', type: 'datetime', style: { format: 'yyyy-MM-dd HH:mm' } },
  { name: '状态', type: 'select', multiple: false, options: [
    { name: 'pending', hue: 'Blue', lightness: 'Lighter' },
    { name: 'confirmed', hue: 'Green', lightness: 'Light' },
    { name: 'in_progress', hue: 'Wathet', lightness: 'Standard' },
    { name: 'blocked', hue: 'Red', lightness: 'Light' },
    { name: 'done', hue: 'Turquoise', lightness: 'Light' },
    { name: 'ignored', hue: 'Gray', lightness: 'Lighter' }
  ] },
  { name: '优先级', type: 'select', multiple: false, options: [
    { name: 'P0', hue: 'Red', lightness: 'Standard' },
    { name: 'P1', hue: 'Orange', lightness: 'Standard' },
    { name: 'P2', hue: 'Blue', lightness: 'Lighter' },
    { name: 'P3', hue: 'Gray', lightness: 'Lighter' }
  ] },
  { name: '来源类型', type: 'select', multiple: false, options: [
    { name: 'meeting', hue: 'Blue', lightness: 'Lighter' },
    { name: 'chat', hue: 'Wathet', lightness: 'Lighter' },
    { name: 'document', hue: 'Purple', lightness: 'Lighter' },
    { name: 'calendar', hue: 'Orange', lightness: 'Lighter' },
    { name: 'task', hue: 'Green', lightness: 'Lighter' },
    { name: 'manual', hue: 'Gray', lightness: 'Lighter' }
  ] },
  { name: '来源标题', type: 'text', style: { type: 'plain' } },
  { name: '来源链接', type: 'text', style: { type: 'url' } },
  { name: '证据原文', type: 'text', style: { type: 'plain' } },
  { name: '置信度', type: 'select', multiple: false, options: [
    { name: 'high', hue: 'Green', lightness: 'Light' },
    { name: 'medium', hue: 'Blue', lightness: 'Lighter' },
    { name: 'low', hue: 'Orange', lightness: 'Light' }
  ] },
  { name: '下一步动作', type: 'text', style: { type: 'plain' } },
  { name: '风险原因', type: 'text', style: { type: 'plain' } },
  { name: '飞书任务ID', type: 'text', style: { type: 'plain' } },
  { name: '创建时间', type: 'datetime', style: { format: 'yyyy-MM-dd HH:mm' } },
  { name: '更新时间', type: 'datetime', style: { format: 'yyyy-MM-dd HH:mm' } }
];

const REQUIRED_FIELD_NAMES = new Set(FIELD_DEFINITIONS.map((field) => field.name));

function log(message, emoji = '📋') {
  console.log(`${emoji} ${message}`);
}

function loadLocalConfig() {
  try {
    if (existsSync(LOCAL_CONFIG_PATH)) {
      return JSON.parse(readFileSync(LOCAL_CONFIG_PATH, 'utf-8'));
    }
  } catch {}
  return { bitable: {}, task: {} };
}

function saveLocalConfig(data) {
  writeFileSync(LOCAL_CONFIG_PATH, JSON.stringify(data, null, 2));
}

function updateEnvVar(content, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(content)) {
    return content.replace(pattern, line);
  }
  return `${content.trimEnd()}\n${line}\n`;
}

function saveEnvConfig(appToken, tableId) {
  if (!existsSync(ENV_PATH)) {
    return;
  }

  let content = readFileSync(ENV_PATH, 'utf-8');
  content = updateEnvVar(content, 'FLOWMATE_BITABLE_APP_TOKEN', appToken);
  content = updateEnvVar(content, 'FLOWMATE_BITABLE_TABLE_ID', tableId);
  writeFileSync(ENV_PATH, content);
}

function timestampString(value) {
  return String(new Date(value).getTime());
}

function buildSmokeRecord() {
  const now = new Date().toISOString();
  return {
    承诺标题: '[FlowMate测试] 验证 Bitable 写入',
    承诺ID: `setup_${Date.now()}`,
    负责人: 'FlowMate',
    负责人OpenID: '',
    截止时间文本: '2026-12-31 23:59',
    标准截止时间: timestampString('2026-12-31T23:59:00+08:00'),
    状态: 'pending',
    优先级: 'P2',
    来源类型: 'manual',
    来源标题: '[FlowMate测试] setup-feishu',
    来源链接: '',
    证据原文: '这是 FlowMate 自动创建的验证记录。',
    置信度: 'high',
    下一步动作: '验证表结构',
    风险原因: '',
    飞书任务ID: '',
    创建时间: timestampString(now),
    更新时间: timestampString(now)
  };
}

function uniqueTableName(baseName) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const suffix = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${baseName}_${suffix}`;
}

async function ensureBaseToken() {
  if (config.feishu.appToken) {
    log(`复用现有 Base: ${BASE_NAME}`, '✅');
    return config.feishu.appToken;
  }

  log(`创建新的 Base: ${BASE_NAME}`);
  const result = await larkCliJson([
    'base',
    '+base-create',
    '--name', BASE_NAME,
    '--time-zone', 'Asia/Shanghai'
  ]);

  const baseToken = result.data?.base?.token || result.data?.base_token || result.data?.token;
  if (!baseToken) {
    throw new Error(`无法从 base 创建结果中解析 token: ${JSON.stringify(result).slice(0, 500)}`);
  }

  log(`Base 创建成功: ${baseToken}`, '✅');
  return baseToken;
}

async function listTables(baseToken) {
  const result = await larkCliJson([
    'base',
    '+table-list',
    '--base-token', baseToken
  ]);

  return result.data?.tables || [];
}

async function getFieldNames(baseToken, tableId) {
  const result = await larkCliJson([
    'base',
    '+field-list',
    '--base-token', baseToken,
    '--table-id', tableId
  ]);

  return new Set((result.data?.fields || []).map((field) => field.name));
}

async function findReusableTable(baseToken) {
  const tables = await listTables(baseToken);

  for (const table of tables) {
    const fieldNames = await getFieldNames(baseToken, table.id);
    const matches = [...REQUIRED_FIELD_NAMES].every((name) => fieldNames.has(name));
    if (matches) {
      log(`复用已存在的正确表结构: ${table.name} (${table.id})`, '✅');
      return { tableId: table.id, tableName: table.name };
    }
  }

  return null;
}

async function createStructuredTable(baseToken, tableName) {
  log(`创建新表: ${tableName}`);

  const result = await larkCliJson([
    'base',
    '+table-create',
    '--base-token', baseToken,
    '--name', tableName,
    '--fields', JSON.stringify(FIELD_DEFINITIONS)
  ]);

  const tableId = result.data?.table?.id || result.data?.table_id || result.data?.id;
  if (!tableId) {
    throw new Error(`无法从建表结果中解析 table id: ${JSON.stringify(result).slice(0, 500)}`);
  }

  log(`表创建成功: ${tableName} (${tableId})`, '✅');
  return { tableId, tableName };
}

async function ensureStructuredTable(baseToken) {
  const reusable = await findReusableTable(baseToken);
  if (reusable) {
    return reusable;
  }

  const tables = await listTables(baseToken);
  const tableNames = new Set(tables.map((table) => table.name));
  const tableName = tableNames.has(PREFERRED_TABLE_NAME)
    ? uniqueTableName(PREFERRED_TABLE_NAME)
    : PREFERRED_TABLE_NAME;

  return await createStructuredTable(baseToken, tableName);
}

async function writeSmokeRecord(baseToken, tableId) {
  log('写入验证记录...');
  const result = await larkCliJson([
    'base',
    '+record-upsert',
    '--base-token', baseToken,
    '--table-id', tableId,
    '--json', JSON.stringify(buildSmokeRecord())
  ]);

  const ok = result.ok === true || result.code === 0;
  if (!ok) {
    throw new Error(`验证记录写入失败: ${JSON.stringify(result).slice(0, 500)}`);
  }

  log('验证记录写入成功', '✅');
}

async function main() {
  console.log('='.repeat(63));
  console.log(' FlowMate: 飞书 Bitable 初始化');
  console.log('='.repeat(63));
  console.log();

  const baseToken = await ensureBaseToken();
  const { tableId, tableName } = await ensureStructuredTable(baseToken);
  await writeSmokeRecord(baseToken, tableId);

  const localConfig = loadLocalConfig();
  localConfig.bitable = {
    appToken: baseToken,
    tableId,
    tableName,
    lastSetup: new Date().toISOString()
  };
  localConfig.lastCheck = new Date().toISOString();
  saveLocalConfig(localConfig);
  saveEnvConfig(baseToken, tableId);

  console.log();
  console.log('='.repeat(63));
  console.log(' 初始化完成');
  console.log('='.repeat(63));
  console.log();
  console.log(`Base Token: ${baseToken}`);
  console.log(`Table ID:   ${tableId}`);
  console.log(`Table Name: ${tableName}`);
  console.log();
  console.log('已更新: .flowmate.local.json, .env');
}

main().catch((err) => {
  console.error('\n初始化失败:', err.message);
  process.exit(1);
});
