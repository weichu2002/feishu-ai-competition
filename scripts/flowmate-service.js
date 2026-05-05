import { execFileSync, spawn } from 'child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import net from 'net';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../src/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const flowmateRoot = resolve(__dirname, '..');
const repoRoot = resolve(flowmateRoot, '..');
const openclawMain = resolve(repoRoot, 'openclaw-main', 'openclaw-main', 'openclaw.mjs');
const openclawStateDir = resolve(repoRoot, 'openclaw-state');
const stateDir = resolve(config.openclaw.stateDir, 'state');
const serviceStatePath = resolve(stateDir, 'flowmate-service-state.json');

function readJson(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function findPortPid(port) {
  if (process.platform !== 'win32') return '';
  try {
    const output = execFileSync('netstat.exe', ['-ano'], {
      encoding: 'utf8',
      windowsHide: true
    });
    const pattern = new RegExp(`^\\s*TCP\\s+127\\.0\\.0\\.1:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'imu');
    const match = output.match(pattern);
    return match?.[1] || '';
  } catch {
    return '';
  }
}

function isWatcherUnhealthy(status) {
  return status?.state === 'error' || Boolean(status?.lastError);
}

function waitForPort(port, host = '127.0.0.1', timeoutMs = 20000) {
  const startedAt = Date.now();
  return new Promise((resolveWait) => {
    const tick = () => {
      const socket = net.createConnection({ host, port });
      socket.once('connect', () => {
        socket.destroy();
        resolveWait(true);
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - startedAt > timeoutMs) {
          resolveWait(false);
        } else {
          setTimeout(tick, 500);
        }
      });
    };
    tick();
  });
}

async function isPortOpen(port) {
  return await waitForPort(port, '127.0.0.1', 800);
}

function spawnNode(args, logName, env = {}) {
  mkdirSync(resolve(stateDir, 'service-logs'), { recursive: true });
  const out = resolve(stateDir, 'service-logs', `${logName}.out.log`);
  const err = resolve(stateDir, 'service-logs', `${logName}.err.log`);
  const outFd = openSync(out, 'a');
  const errFd = openSync(err, 'a');
  const child = spawn(process.execPath, args, {
    cwd: flowmateRoot,
    detached: true,
    stdio: ['ignore', outFd, errFd],
    windowsHide: true,
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: openclawStateDir,
      FLOWMATE_OPENCLAW_STATE_DIR: config.openclaw.stateDir,
      ...env,
      FLOWMATE_SERVICE_OUT_LOG: out,
      FLOWMATE_SERVICE_ERR_LOG: err
    }
  });
  child.unref();
  closeSync(outFd);
  closeSync(errFd);
  return { pid: child.pid, out, err };
}

function startProcess(command, args, cwd, logName, env = {}) {
  mkdirSync(resolve(stateDir, 'service-logs'), { recursive: true });
  const out = resolve(stateDir, 'service-logs', `${logName}.out.log`);
  const err = resolve(stateDir, 'service-logs', `${logName}.err.log`);
  const outFd = openSync(out, 'a');
  const errFd = openSync(err, 'a');
  const child = spawn(command, args, {
    cwd,
    detached: true,
    stdio: ['ignore', outFd, errFd],
    windowsHide: true,
    env: {
      ...process.env,
      ...env
    }
  });
  child.unref();
  closeSync(outFd);
  closeSync(errFd);
  return {
    pid: child.pid,
    out,
    err
  };
}

async function startServices() {
  const state = readJson(serviceStatePath, {});
  const personalStatus = readJson(resolve(stateDir, 'flowmate-personal-monitor-watcher.json'), {});
  const teamStatus = readJson(resolve(stateDir, 'flowmate-team-monitor-watcher.json'), {});
  const next = { ...state, updatedAt: new Date().toISOString(), services: { ...(state.services || {}) } };

  if (await isPortOpen(18789)) {
    next.services.gateway = {
      ...(next.services.gateway || {}),
      pid: findPortPid(18789) || next.services.gateway?.pid || '',
      adopted: true
    };
  } else {
    next.services.gateway = startProcess(process.execPath, [openclawMain, 'gateway', 'run', '--verbose'], resolve(openclawMain, '..'), 'gateway', {
      OPENCLAW_STATE_DIR: openclawStateDir
    });
  }

  if (isWatcherUnhealthy(personalStatus) && isPidAlive(personalStatus.pid)) {
    stopPid(personalStatus.pid);
  }
  if (isWatcherUnhealthy(teamStatus) && isPidAlive(teamStatus.pid)) {
    stopPid(teamStatus.pid);
  }

  if (!isWatcherUnhealthy(personalStatus) && isPidAlive(personalStatus.pid)) {
    next.services.personal = {
      ...(next.services.personal || {}),
      pid: personalStatus.pid,
      adopted: true
    };
  } else if (!isPidAlive(next.services.personal?.pid)) {
    next.services.personal = spawnNode(['scripts/watch-personal-messages.js', '--interval', '60'], 'personal-watcher');
  }

  if (!isWatcherUnhealthy(teamStatus) && isPidAlive(teamStatus.pid)) {
    next.services.team = {
      ...(next.services.team || {}),
      pid: teamStatus.pid,
      adopted: true
    };
  } else if (!isPidAlive(next.services.team?.pid)) {
    next.services.team = spawnNode(['scripts/watch-team-sources.js', '--interval', '300', '--notify', 'false'], 'team-watcher');
  }

  writeJson(serviceStatePath, next);
  await waitForPort(18789, '127.0.0.1', 20000);
  return await serviceStatus();
}

function stopPid(pid) {
  if (!pid || !isPidAlive(pid)) return false;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
      process.kill(Number(pid), 'SIGTERM');
    }
    return true;
  } catch {
    return false;
  }
}

async function stopServices() {
  const state = readJson(serviceStatePath, {});
  const services = state.services || {};
  const stopped = {};
  for (const [name, service] of Object.entries(services)) {
    stopped[name] = stopPid(service?.pid);
  }
  writeJson(serviceStatePath, {
    ...state,
    updatedAt: new Date().toISOString(),
    stoppedAt: new Date().toISOString(),
    stopped
  });
  return {
    ok: true,
    action: 'service-stop',
    stopped,
    statePath: serviceStatePath
  };
}

async function serviceStatus() {
  const state = readJson(serviceStatePath, {});
  const personal = readJson(resolve(stateDir, 'flowmate-personal-monitor-watcher.json'), {});
  const team = readJson(resolve(stateDir, 'flowmate-team-monitor-watcher.json'), {});
  const gatewayOpen = await isPortOpen(18789);
  const gatewayPid = gatewayOpen ? findPortPid(18789) : '';
  const services = state.services || {};
  return {
    ok: true,
    action: 'service-status',
    gateway: {
      port: 18789,
      listening: gatewayOpen,
      pid: gatewayPid || services.gateway?.pid || ''
    },
    personal: {
      pid: services.personal?.pid || personal.pid || '',
      alive: isPidAlive(services.personal?.pid || personal.pid),
      state: personal.state || '',
      lastResultAt: personal.lastResultAt || '',
      lastError: personal.lastError || ''
    },
    team: {
      pid: services.team?.pid || team.pid || '',
      alive: isPidAlive(services.team?.pid || team.pid),
      state: team.state || '',
      lastResultAt: team.lastResultAt || '',
      lastError: team.lastError || ''
    },
    statePath: serviceStatePath
  };
}

async function serviceHealth() {
  const status = await serviceStatus();
  return {
    ...status,
    action: 'service-health',
    healthy: Boolean(status.gateway.listening && status.personal.alive && status.team.alive && status.personal.lastError === '' && status.team.lastError === '')
  };
}

function installAutostart() {
  if (process.platform !== 'win32') {
    return {
      ok: false,
      action: 'service-install-autostart',
      userFacingHint: '当前只实现了 Windows 登录自启动安装。'
    };
  }
  const taskName = 'FlowMateServices';
  const command = `cmd.exe /c "cd /d ${flowmateRoot} && npm run service:start"`;
  try {
    execFileSync('schtasks.exe', [
      '/Create',
      '/TN',
      taskName,
      '/SC',
      'ONLOGON',
      '/TR',
      command,
      '/F'
    ], { windowsHide: true });
  } catch {
    const startupDir = resolve(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    if (!process.env.APPDATA || !existsSync(startupDir)) {
      throw new Error('计划任务创建被拒绝，且没有找到用户 Startup 文件夹。');
    }
    const startupCmd = resolve(startupDir, 'FlowMateServices.cmd');
    writeFileSync(startupCmd, [
      '@echo off',
      `cd /d "${flowmateRoot}"`,
      'npm run service:start'
    ].join('\r\n'));
    return {
      ok: true,
      action: 'service-install-autostart',
      mode: 'startup-folder',
      path: startupCmd,
      userFacingHint: `计划任务权限不足，已改用用户 Startup 启动脚本：${startupCmd}`
    };
  }
  return {
    ok: true,
    action: 'service-install-autostart',
    taskName,
    command,
    userFacingHint: `已安装 Windows 登录自启动任务：${taskName}`
  };
}

function installPanelAutostart() {
  if (process.platform !== 'win32') {
    return {
      ok: false,
      action: 'service-install-autostart',
      userFacingHint: '当前只实现了 Windows 登录自启动安装。'
    };
  }

  const taskName = 'FlowMateServices';
  const command = `cmd.exe /c "cd /d ${flowmateRoot} && npm run service:panel -- --start --open"`;
  try {
    execFileSync('schtasks.exe', [
      '/Create',
      '/TN',
      taskName,
      '/SC',
      'ONLOGON',
      '/TR',
      command,
      '/F'
    ], { windowsHide: true });
    return {
      ok: true,
      action: 'service-install-autostart',
      mode: 'scheduled-task-panel',
      taskName,
      command,
      userFacingHint: `已安装 Windows 登录自启动任务：${taskName}，启动后打开 FlowMate 网页控制台。`
    };
  } catch {
    const startupDir = resolve(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    if (!process.env.APPDATA || !existsSync(startupDir)) {
      throw new Error('计划任务创建被拒绝，并且没有找到用户 Startup 文件夹。');
    }
    const startupCmd = resolve(startupDir, 'FlowMateServices.cmd');
    const startupVbs = resolve(startupDir, 'FlowMateServices.vbs');
    const hiddenCommand = `cmd.exe /c cd /d "${flowmateRoot}" && npm run service:panel -- --start --open`;
    writeFileSync(startupVbs, [
      'Set shell = CreateObject("WScript.Shell")',
      `shell.Run "${hiddenCommand.replaceAll('"', '""')}", 0, False`
    ].join('\r\n'));
    if (existsSync(startupCmd)) {
      try {
        unlinkSync(startupCmd);
      } catch {
        // Best effort only.
      }
    }
    return {
      ok: true,
      action: 'service-install-autostart',
      mode: 'startup-folder-hidden-panel',
      path: startupVbs,
      userFacingHint: `计划任务权限不足，已改用隐藏启动脚本打开 FlowMate 网页控制台：${startupVbs}`
    };
  }
}

function uninstallAutostart() {
  if (process.platform !== 'win32') {
    return {
      ok: false,
      action: 'service-uninstall-autostart',
      userFacingHint: '当前只实现了 Windows 登录自启动卸载。'
    };
  }
  const taskName = 'FlowMateServices';
  try {
    execFileSync('schtasks.exe', ['/Delete', '/TN', taskName, '/F'], { windowsHide: true });
  } catch {
    // It may have been installed via Startup folder fallback.
  }
  const startupCmd = resolve(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'FlowMateServices.cmd');
  if (existsSync(startupCmd)) {
    try {
      unlinkSync(startupCmd);
    } catch {
      // Best effort only.
    }
  }
  const startupVbs = resolve(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'FlowMateServices.vbs');
  if (existsSync(startupVbs)) {
    try {
      unlinkSync(startupVbs);
    } catch {
      // Best effort only.
    }
  }
  return {
    ok: true,
    action: 'service-uninstall-autostart',
    taskName,
    userFacingHint: `已卸载 Windows 登录自启动任务：${taskName}`
  };
}

async function main() {
  const command = process.argv[2] || 'status';
  let result;
  if (command === 'start') {
    result = await startServices();
  } else if (command === 'stop') {
    result = await stopServices();
  } else if (command === 'health') {
    result = await serviceHealth();
  } else if (command === 'install-autostart') {
    result = installPanelAutostart();
  } else if (command === 'uninstall-autostart') {
    result = uninstallAutostart();
  } else {
    result = await serviceStatus();
  }
  console.log(JSON.stringify(result, null, 2));
}

await main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error.message
  }, null, 2));
  process.exit(1);
});
