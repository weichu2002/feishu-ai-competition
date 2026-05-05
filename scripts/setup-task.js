import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCAL_CONFIG_PATH = resolve(__dirname, '..', '.flowmate.local.json');

const TEST_PREFIX = '[FlowMate测试]';
const TEST_TASK_TITLE = TEST_PREFIX + ' 自动创建任务验证';

function runCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: true, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('close', code => resolve({ stdout, stderr, code }));
    child.on('error', err => reject(err));
  });
}

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

function saveLocalConfig(config) {
  config.lastCheck = new Date().toISOString();
  writeFileSync(LOCAL_CONFIG_PATH, JSON.stringify(config, null, 2));
}

async function checkLogin() {
  log('检查登录状态...');
  const result = await runCommand('lark-cli', ['auth', 'status']);
  if (!result.stdout.includes('user') && !result.stdout.includes('bot')) {
    throw new Error('未登录或登录已过期，请先运行 lark-cli auth login');
  }
  log('登录状态正常', '✅');
}

async function findExistingTask(config) {
  log('查找现有的 FlowMate 测试任务...');

  try {
    const result = await runCommand('lark-cli', ['task', '+search', '--query', TEST_PREFIX]);
    const output = result.stdout;

    const taskIdMatch = output.match(/task_id[\s:"]+([a-zA-Z0-9_-]{20,})/i) ||
                        output.match(/guid[\s:"]+([a-zA-Z0-9_-]{20,})/i);

    if (taskIdMatch) {
      const taskId = taskIdMatch[1];
      log(`找到现有测试任务: ${taskId}`, '✅');
      return taskId;
    }
  } catch {}

  log('未找到现有测试任务，将创建新的', '⚠️');
  return null;
}

async function createTask() {
  log(`创建新的测试任务: ${TEST_TASK_TITLE}...`);

  const taskData = {
    summary: TEST_TASK_TITLE,
    description: `此任务由 FlowMate 自动创建，用于验证任务写入链路。
创建时间: ${new Date().toISOString()}
说明: FlowMate 是会议驱动的个人承诺闭环 Agent，此任务用于测试完整的任务创建流程。`
  };

  const result = await runCommand('lark-cli', [
    'task', '+create',
    '--data', JSON.stringify(taskData)
  ]);

  if (result.code !== 0) {
    throw new Error(`创建任务失败: ${result.stderr}`);
  }

  const output = result.stdout;
  const taskIdMatch = output.match(/task_id[\s:"]+([a-zA-Z0-9_-]{20,})/i) ||
                      output.match(/guid[\s:"]+([a-zA-Z0-9_-]{20,})/i) ||
                      output.match(/"([a-zA-Z0-9_-]{20,})"/);

  if (!taskIdMatch) {
    throw new Error(`无法解析 task_id: ${output}`);
  }

  const taskId = taskIdMatch[1];
  log(`任务创建成功: ${taskId}`, '✅');
  return taskId;
}

async function verifyTask(taskId) {
  log(`验证任务 ${taskId}...`);

  const result = await runCommand('lark-cli', ['task', '+get', '--task-id', taskId]);

  if (result.code !== 0) {
    throw new Error(`验证失败: ${result.stderr}`);
  }

  log('验证通过', '✅');
  return true;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' FlowMate: 测试任务自动初始化');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const config = loadLocalConfig();

  try {
    await checkLogin();

    let taskId = config.task?.taskId;

    if (!taskId) {
      const existing = await findExistingTask(config);
      if (existing) {
        taskId = existing;
      } else {
        taskId = await createTask();
      }
    }

    config.task = {
      taskId,
      taskTitle: TEST_TASK_TITLE,
      lastSetup: new Date().toISOString()
    };

    await verifyTask(taskId);

    saveLocalConfig(config);

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log(' ✅ 初始化完成！');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('\n📁 资源配置已保存到 .flowmate.local.json');
    console.log(`\n   Task ID:  ${taskId}`);
    console.log('\n📝 下一步: 运行 npm run mock:extract 测试承诺抽取\n');

  } catch (err) {
    console.error('\n❌ 初始化失败:', err.message);
    console.error('\n可能的解决方案:');
    console.error('1. 如果是权限问题，请确认已在飞书开放平台授权');
    console.error('2. 如果是 Token 过期，请运行 lark-cli auth login');
    console.error('3. 如果是网络问题，请检查网络连接\n');
    process.exit(1);
  }
}

main();
