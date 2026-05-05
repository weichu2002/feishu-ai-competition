import { spawn } from 'child_process';
import http from 'http';
import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../src/config.js';
import { FeishuWriter } from '../src/feishu-write.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const flowmateRoot = resolve(__dirname, '..');
const workspaceDir = resolve(config.openclaw.stateDir);
const serviceScript = resolve(flowmateRoot, 'scripts', 'flowmate-service.js');
const teamEntry = resolve(flowmateRoot, 'scripts', 'team-entry.js');
const realDocTest = resolve(flowmateRoot, 'scripts', 'self-test-real-document-source.mjs');
const realMinutesTest = resolve(flowmateRoot, 'scripts', 'self-test-real-minutes-source.mjs');
const knowledgeQaTest = resolve(flowmateRoot, 'scripts', 'self-test-team-knowledge-qa.mjs');
const regressionTest = resolve(flowmateRoot, 'scripts', 'self-test-regression-matrix.mjs');
const port = Number(process.env.FLOWMATE_PANEL_PORT || 18888);
const host = '127.0.0.1';
const jobs = new Map();

function parseFlags(argv) {
  return new Set(argv.filter((arg) => arg.startsWith('--')));
}

function json(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolveRead) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => resolveRead(body));
  });
}

function safeParseJson(text, fallback = {}) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function loadWorkspaceUserProfile() {
  const userPath = resolve(workspaceDir, 'USER.md');
  const profile = { name: '', openId: '' };
  if (!existsSync(userPath)) return profile;

  const content = readFileSync(userPath, 'utf8');
  const openIdMatch = content.match(/ou_[A-Za-z0-9]+/u);
  if (openIdMatch) {
    profile.openId = openIdMatch[0];
  }

  const nameMatch = content.match(/\*\*[^*\n]*(?:名字|Name)[^*\n]*\*\*:\s*([^\r\n]+)/u);
  if (nameMatch) {
    profile.name = nameMatch[1].trim();
  }
  return profile;
}

function compactError(result) {
  const text = [
    result?.error,
    result?.stderr
  ].filter(Boolean).join('\n').trim();
  return text ? text.slice(0, 500) : '未知错误';
}

function summarizeJob(label, result) {
  const data = result?.data || {};
  if (!result?.ok) {
    return `FlowMate 控制台：${label}失败。\n${compactError(result)}`;
  }
  if (data?.verifiedCount) {
    return `FlowMate 控制台：${label}完成，验证通过 ${data.verifiedCount} 项。`;
  }
  if (data?.dashboard?.blockCount || data?.blockCount) {
    const blockCount = data.dashboard?.blockCount || data.blockCount;
    return `FlowMate 控制台：${label}完成，驾驶舱区块 ${blockCount} 个。`;
  }
  if (data?.syncedCount !== undefined) {
    return `FlowMate 控制台：${label}完成，同步记录 ${data.syncedCount} 条。`;
  }
  if (data?.scan?.syncedCount !== undefined) {
    return `FlowMate 控制台：${label}完成，同步记录 ${data.scan.syncedCount} 条，证据命中 ${data.qa?.evidenceCount || 0} 条。`;
  }
  if (data?.evidenceCount !== undefined) {
    return `FlowMate 控制台：${label}完成，证据命中 ${data.evidenceCount} 条。`;
  }
  if (data?.healthy !== undefined) {
    return `FlowMate 控制台：${label}完成，服务状态：${data.healthy ? '健康' : '需要处理'}。`;
  }
  return `FlowMate 控制台：${label}完成。`;
}

async function notifyUser(label, result) {
  const profile = loadWorkspaceUserProfile();
  if (!profile.openId) {
    return { ok: true, skipped: true, reason: 'missing user open id' };
  }
  try {
    const writer = new FeishuWriter();
    return await writer.sendBotMessage(profile.openId, summarizeJob(label, result));
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function runNode(label, args, { timeout = 600000 } = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, args, {
      cwd: flowmateRoot,
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        LARKSUITE_CLI_CONFIG_DIR: process.env.LARKSUITE_CLI_CONFIG_DIR || resolve(process.env.USERPROFILE || process.env.HOME || flowmateRoot, '.lark-cli')
      }
    });

    let stdout = '';
    let stderr = '';
    let finished = false;
    const timer = setTimeout(() => {
      if (!finished) {
        child.kill();
        finished = true;
        resolveRun({ ok: false, label, error: `${label} timed out`, stdout, stderr });
      }
    }, timeout);

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const output = stdout.trim();
      let parsed = output ? safeParseJson(output, null) : null;
      if (!parsed && output) {
        parsed = safeParseJson(output.split(/\r?\n/u).filter(Boolean).at(-1), null);
      }
      resolveRun({
        ok: code === 0,
        label,
        code,
        data: parsed,
        stdout,
        stderr,
        error: code === 0 ? '' : `${label} failed with code ${code}`
      });
    });
    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolveRun({ ok: false, label, error: error.message, stdout, stderr });
    });
  });
}

async function collectStatus() {
  const [health, teamStatus, sourceList] = await Promise.all([
    runNode('service health', [serviceScript, 'health'], { timeout: 120000 }),
    runNode('team status', [teamEntry, 'status'], { timeout: 120000 }),
    runNode('team sources', [teamEntry, 'source-list'], { timeout: 120000 })
  ]);
  return {
    ok: Boolean(health.ok && health.data?.healthy),
    checkedAt: new Date().toISOString(),
    health: health.data || health,
    team: teamStatus.data || teamStatus,
    sources: sourceList.data || sourceList
  };
}

function createJob(label, args, options = {}) {
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const job = {
    id,
    label,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: '',
    result: null
  };
  jobs.set(id, job);
  runNode(label, args, options).then(async (result) => {
    job.result = result;
    job.notification = await notifyUser(label, result);
    job.status = result.ok ? 'completed' : 'failed';
    job.finishedAt = new Date().toISOString();
  });
  return job;
}

function actionToJob(action) {
  if (action === 'start') {
    return createJob('启动 FlowMate 服务', [serviceScript, 'start'], { timeout: 180000 });
  }
  if (action === 'stop') {
    return createJob('停止 FlowMate 服务', [serviceScript, 'stop'], { timeout: 120000 });
  }
  if (action === 'dashboard') {
    return createJob('刷新团队驾驶舱', [teamEntry, 'dashboard-refresh'], { timeout: 360000 });
  }
  if (action === 'subscribe-events') {
    return createJob('订阅任务事件', [teamEntry, 'subscribe-events'], { timeout: 120000 });
  }
  if (action === 'real-doc-test') {
    return createJob('真实文档固定来源端到端验证', [realDocTest], { timeout: 900000 });
  }
  if (action === 'real-minutes-test') {
    return createJob('真实妙记固定来源端到端验证', [realMinutesTest], { timeout: 900000 });
  }
  if (action === 'knowledge-qa-test') {
    return createJob('团队知识问答证据验证', [knowledgeQaTest], { timeout: 360000 });
  }
  if (action === 'live-regression') {
    return createJob('完整 live 回归验证', [regressionTest, '--live-feishu'], { timeout: 1200000 });
  }
  return null;
}

function openBrowser() {
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '', `http://${host}:${port}/`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    }).unref();
  }
}

function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>FlowMate 控制台</title>
  <style>
    :root {
      --ink: #17211d;
      --muted: #66746f;
      --line: rgba(23, 33, 29, 0.13);
      --paper: rgba(255, 252, 243, 0.82);
      --green: #1f7a52;
      --red: #b33a2b;
      --gold: #e2a93b;
      --blue: #2866a6;
      --shadow: 0 24px 80px rgba(35, 45, 38, 0.16);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--ink);
      font-family: "霞鹜文楷", "LXGW WenKai", "Microsoft YaHei UI", "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at 18% 10%, rgba(226, 169, 59, 0.25), transparent 28rem),
        radial-gradient(circle at 88% 18%, rgba(40, 102, 166, 0.18), transparent 24rem),
        linear-gradient(135deg, #f7ead3 0%, #edf2df 48%, #dfeeea 100%);
    }
    main {
      width: min(1160px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 36px 0 48px;
    }
    header {
      display: grid;
      grid-template-columns: 1.4fr 0.8fr;
      gap: 24px;
      align-items: stretch;
      margin-bottom: 22px;
    }
    .hero, .panel {
      border: 1px solid var(--line);
      background: var(--paper);
      box-shadow: var(--shadow);
      backdrop-filter: blur(18px);
      border-radius: 30px;
    }
    .hero { padding: 30px; position: relative; overflow: hidden; }
    .hero::after {
      content: "";
      position: absolute;
      right: -70px;
      bottom: -90px;
      width: 260px;
      height: 260px;
      border-radius: 44% 56% 48% 52%;
      background: rgba(31, 122, 82, 0.16);
      transform: rotate(-18deg);
    }
    h1 {
      margin: 0 0 10px;
      font-size: clamp(34px, 5vw, 60px);
      letter-spacing: -0.04em;
      line-height: 0.95;
    }
    .sub { margin: 0; color: var(--muted); max-width: 660px; font-size: 17px; line-height: 1.7; }
    .status-card { padding: 26px; display: flex; flex-direction: column; justify-content: space-between; gap: 18px; }
    .badge {
      width: fit-content;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-radius: 999px;
      font-weight: 700;
      border: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.56);
    }
    .dot { width: 10px; height: 10px; border-radius: 999px; background: var(--gold); box-shadow: 0 0 0 6px rgba(226,169,59,.16); }
    .badge.ok .dot { background: var(--green); box-shadow: 0 0 0 6px rgba(31,122,82,.16); }
    .badge.bad .dot { background: var(--red); box-shadow: 0 0 0 6px rgba(179,58,43,.15); }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
    .panel { padding: 22px; }
    .panel h2 { margin: 0 0 14px; font-size: 22px; }
    .actions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    button {
      border: 0;
      cursor: pointer;
      border-radius: 18px;
      padding: 14px 16px;
      color: white;
      background: var(--ink);
      font-weight: 800;
      font-size: 15px;
      box-shadow: 0 12px 28px rgba(23, 33, 29, 0.18);
      transition: transform .16s ease, box-shadow .16s ease, opacity .16s ease;
    }
    button:hover { transform: translateY(-2px); box-shadow: 0 18px 34px rgba(23, 33, 29, 0.2); }
    button:disabled { opacity: .45; cursor: wait; transform: none; }
    button.green { background: var(--green); }
    button.blue { background: var(--blue); }
    button.gold { background: #9b6815; }
    button.red { background: var(--red); }
    .metric-list { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
    .metric {
      padding: 16px;
      border-radius: 22px;
      background: rgba(255,255,255,.55);
      border: 1px solid var(--line);
    }
    .metric b { display: block; font-size: 24px; margin-bottom: 4px; }
    .metric span { color: var(--muted); font-size: 13px; }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      min-height: 220px;
      max-height: 420px;
      overflow: auto;
      padding: 16px;
      border-radius: 18px;
      background: #14201c;
      color: #d8f4e6;
      font: 13px/1.55 "Cascadia Code", Consolas, monospace;
    }
    .small { color: var(--muted); font-size: 13px; line-height: 1.6; }
    @media (max-width: 820px) {
      header, .grid { grid-template-columns: 1fr; }
      .actions, .metric-list { grid-template-columns: 1fr; }
      main { padding-top: 18px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <section class="hero">
        <h1>FlowMate<br/>本地控制台</h1>
        <p class="sub">不用再盯黑窗口了。这里可以一键启动 Gateway、个人 watcher、团队 watcher，也可以刷新团队驾驶舱、订阅任务事件、跑真实验证。</p>
      </section>
      <section class="panel status-card">
        <div id="badge" class="badge"><span class="dot"></span><span>检查中</span></div>
        <p class="small" id="checkedAt">正在读取本机服务状态...</p>
      </section>
    </header>

    <section class="grid">
      <div class="panel">
        <h2>一键操作</h2>
        <div class="actions">
          <button class="green" data-action="start">启动服务</button>
          <button class="red" data-action="stop">停止服务</button>
          <button class="blue" data-refresh>刷新状态</button>
          <button class="gold" data-action="dashboard">刷新驾驶舱</button>
          <button class="blue" data-action="subscribe-events">订阅任务事件</button>
          <button data-action="real-doc-test">真实文档验证</button>
          <button data-action="real-minutes-test">真实妙记验证</button>
          <button data-action="knowledge-qa-test">证据问答验证</button>
          <button data-action="live-regression">完整 live 回归</button>
        </div>
        <p class="small">“完整 live 回归”会跑比较久；演示前建议先点“启动服务”和“刷新状态”。</p>
      </div>
      <div class="panel">
        <h2>当前状态</h2>
        <div class="metric-list">
          <div class="metric"><b id="gateway">-</b><span>Gateway</span></div>
          <div class="metric"><b id="personal">-</b><span>个人监听</span></div>
          <div class="metric"><b id="team">-</b><span>团队监听</span></div>
        </div>
      </div>
    </section>

    <section class="panel" style="margin-top:18px">
      <h2>操作日志</h2>
      <pre id="log">控制台已加载。</pre>
    </section>
  </main>

  <script>
    const log = document.querySelector('#log');
    const badge = document.querySelector('#badge');
    const buttons = [...document.querySelectorAll('button')];

    function write(value) {
      log.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    }

    function setBusy(busy) {
      buttons.forEach((button) => { button.disabled = busy; });
    }

    function yesNo(value) { return value ? '正常' : '异常'; }

    async function refresh() {
      const res = await fetch('/api/status');
      const data = await res.json();
      const ok = Boolean(data.ok);
      badge.className = 'badge ' + (ok ? 'ok' : 'bad');
      badge.querySelector('span:last-child').textContent = ok ? '服务健康' : '需要处理';
      document.querySelector('#checkedAt').textContent = '检查时间：' + new Date(data.checkedAt).toLocaleString();
      document.querySelector('#gateway').textContent = yesNo(data.health?.gateway?.listening);
      document.querySelector('#personal').textContent = yesNo(data.health?.personal?.alive && data.health?.personal?.lastError === '');
      document.querySelector('#team').textContent = yesNo(data.health?.team?.alive && data.health?.team?.lastError === '');
      write(data);
    }

    async function pollJob(id) {
      while (true) {
        const res = await fetch('/api/job/' + id);
        const job = await res.json();
        write(job);
        if (job.status !== 'running') return job;
        await new Promise((resolve) => setTimeout(resolve, 1400));
      }
    }

    async function runAction(action) {
      setBusy(true);
      try {
        const res = await fetch('/api/action', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action })
        });
        const job = await res.json();
        write(job);
        await pollJob(job.id);
        await refresh();
      } finally {
        setBusy(false);
      }
    }

    document.querySelectorAll('[data-action]').forEach((button) => {
      button.addEventListener('click', () => runAction(button.dataset.action));
    });
    document.querySelector('[data-refresh]').addEventListener('click', refresh);
    refresh().catch((error) => write(error.message));
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${host}:${port}`);
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      json(res, 200, await collectStatus());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/action') {
      const body = safeParseJson(await readBody(req));
      const job = actionToJob(body.action);
      if (!job) {
        json(res, 400, { ok: false, error: 'unknown action' });
        return;
      }
      json(res, 200, job);
      return;
    }
    const jobMatch = url.pathname.match(/^\/api\/job\/([^/]+)$/u);
    if (req.method === 'GET' && jobMatch) {
      const job = jobs.get(jobMatch[1]);
      json(res, job ? 200 : 404, job || { ok: false, error: 'job not found' });
      return;
    }
    json(res, 404, { ok: false, error: 'not found' });
  } catch (error) {
    json(res, 500, { ok: false, error: error.message });
  }
});

server.listen(port, host, async () => {
  const flags = parseFlags(process.argv.slice(2));
  console.log(`FlowMate 控制台：http://${host}:${port}/`);
  if (flags.has('--start')) {
    await runNode('启动 FlowMate 服务', [serviceScript, 'start'], { timeout: 180000 });
  }
  if (flags.has('--open')) {
    openBrowser();
  }
});
