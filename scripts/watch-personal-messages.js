import { spawn } from 'child_process';
import { FeishuWriter } from '../src/feishu-write.js';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  buildWatcherStatusPatch,
  clearAuthState,
  createMessageSearchAuthPrompt,
  getLarkAuthStatus,
  getMonitorGate,
  hasUserIdentity,
  isPendingAuthValid,
  loadAuthState,
  loadWorkspaceUserProfile,
  saveAuthState,
  saveWatcherStatus,
  startDeviceCodeCompletion
} from '../src/personal-monitor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const assistantEntryPath = resolve(__dirname, 'assistant-entry.js');

let pendingAuthSession = null;
let authRecoveryNotified = false;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    i += 1;
  }
  return args;
}

function buildScanArgs(args) {
  const commandArgs = [assistantEntryPath, 'scan-personal-messages'];

  if (args['chat-type']) {
    commandArgs.push('--chat-type', String(args['chat-type']));
  }
  if (args['page-size']) {
    commandArgs.push('--page-size', String(args['page-size']));
  }
  if (args['lookback-minutes']) {
    commandArgs.push('--lookback-minutes', String(args['lookback-minutes']));
  }
  if (args['overlap-seconds']) {
    commandArgs.push('--overlap-seconds', String(args['overlap-seconds']));
  }

  return commandArgs;
}

function buildAuthReminderMessage(verificationUrl) {
  const lines = [
    'FlowMate 个人消息自动扫描已暂停：需要重新授权消息搜索权限。',
    '授权完成后，扫描器会自动恢复，不需要重新启动。',
    '',
    `请打开这个链接完成授权：${verificationUrl}`
  ];

  return lines.join('\n');
}

function buildAuthRecoveredMessage() {
  return [
    'FlowMate 个人消息自动扫描已恢复。',
    '后续你发出的新承诺消息，会继续自动写入承诺账本、任务和日历。'
  ].join('\n');
}

async function sendBotReminder(text) {
  const profile = loadWorkspaceUserProfile();
  if (!profile.openId) {
    return {
      ok: false,
      skipped: true,
      reason: 'missing_user_openid'
    };
  }

  const writer = new FeishuWriter();
  return await writer.sendBotMessage(profile.openId, text);
}

async function ensureAuthorizationReady() {
  const status = await getLarkAuthStatus();
  if (hasUserIdentity(status)) {
    if (!authRecoveryNotified) {
      const state = loadAuthState();
      if (state?.status === 'waiting_authorization') {
        try {
          await sendBotReminder(buildAuthRecoveredMessage());
        } catch {
          // Ignore recovery notification failures; scanning can still continue.
        }
      }
      authRecoveryNotified = true;
    }
    pendingAuthSession = null;
    clearAuthState();
    return {
      ready: true,
      status
    };
  }

  authRecoveryNotified = false;
  const existing = loadAuthState();
  if (isPendingAuthValid(existing)) {
    pendingAuthSession = {
      ...existing,
      waiting: true
    };
    return {
      ready: false,
      reason: 'awaiting_authorization',
      verificationUrl: existing.verificationUrl,
      expiresAt: existing.expiresAt,
      status
    };
  }

  const prompt = await createMessageSearchAuthPrompt();
  const expiresAt = new Date(Date.now() + Number(prompt.expires_in || 600) * 1000).toISOString();
  pendingAuthSession = {
    status: 'waiting_authorization',
    startedAt: new Date().toISOString(),
    expiresAt,
    verificationUrl: prompt.verification_url || '',
    deviceCode: prompt.device_code || ''
  };
  saveAuthState(pendingAuthSession);

  if (pendingAuthSession.deviceCode) {
    startDeviceCodeCompletion(pendingAuthSession.deviceCode, (completion) => {
      if (pendingAuthSession?.deviceCode === prompt.device_code) {
        pendingAuthSession = {
          ...pendingAuthSession,
          completionClosedAt: completion.closedAt,
          completionExitCode: completion.exitCode,
          completionError: completion.error
        };
        saveAuthState({
          ...(loadAuthState() || {}),
          ...pendingAuthSession
        });
      }
    });
  }

  if (pendingAuthSession.verificationUrl) {
    try {
      await sendBotReminder(buildAuthReminderMessage(pendingAuthSession.verificationUrl));
      pendingAuthSession.remindedAt = new Date().toISOString();
      saveAuthState(pendingAuthSession);
    } catch {
      // Ignore reminder failures; console output still exposes the link.
    }
  }

  return {
    ready: false,
    reason: 'authorization_required',
    verificationUrl: pendingAuthSession.verificationUrl,
    expiresAt: pendingAuthSession.expiresAt,
    status
  };
}

async function runSingleScan(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, buildScanArgs(args), {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        try {
          resolve(JSON.parse(stdout));
        } catch (error) {
          reject(new Error(`Failed to parse scan result: ${error.message}`));
        }
        return;
      }

      reject(new Error(stderr || stdout || `scan exited with code ${code}`));
    });

    child.on('error', (error) => {
      reject(error);
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const intervalSeconds = Number(args.interval || args['interval-seconds'] || 60);
  const runOnce = Boolean(args.once);

  saveWatcherStatus(buildWatcherStatusPatch({
    pid: process.pid,
    state: 'starting',
    intervalSeconds,
    startedAt: new Date().toISOString(),
    resumeAt: '',
    reason: '',
    lastLoopAt: '',
    lastResultAt: '',
    lastErrorAt: '',
    lastError: ''
  }));

  console.log(JSON.stringify({
    ok: true,
    action: 'watch-personal-messages',
    intervalSeconds,
    runOnce,
    message: 'FlowMate personal message watcher started'
  }, null, 2));

  const loop = async () => {
    try {
      saveWatcherStatus(buildWatcherStatusPatch({
        pid: process.pid,
        state: 'checking',
        intervalSeconds,
        resumeAt: '',
        reason: '',
        lastLoopAt: new Date().toISOString()
      }));

      const gate = getMonitorGate();
      if (!gate.allow) {
        saveWatcherStatus(buildWatcherStatusPatch({
          pid: process.pid,
          state: gate.state,
          intervalSeconds,
          lastResultAt: new Date().toISOString(),
          resumeAt: gate.resumeAt || '',
          reason: gate.control?.reason || ''
        }));
        console.log(JSON.stringify({
          ok: true,
          action: 'watch-personal-messages',
          state: gate.state,
          reason: gate.control?.reason || '',
          resumeAt: gate.resumeAt || ''
        }, null, 2));
        return;
      }

      const auth = await ensureAuthorizationReady();
      if (!auth.ready) {
        saveWatcherStatus(buildWatcherStatusPatch({
          pid: process.pid,
          state: 'paused_for_authorization',
          intervalSeconds,
          lastResultAt: new Date().toISOString(),
          resumeAt: auth.expiresAt || '',
          reason: auth.reason
        }));
        console.log(JSON.stringify({
          ok: true,
          action: 'watch-personal-messages',
          state: 'paused_for_authorization',
          reason: auth.reason,
          verificationUrl: auth.verificationUrl || '',
          expiresAt: auth.expiresAt || ''
        }, null, 2));
        return;
      }

      const result = await runSingleScan(args);
      saveWatcherStatus(buildWatcherStatusPatch({
        pid: process.pid,
        state: 'running',
        intervalSeconds,
        lastResultAt: new Date().toISOString(),
        lastErrorAt: '',
        lastError: '',
        resumeAt: '',
        reason: ''
      }));
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      saveWatcherStatus(buildWatcherStatusPatch({
        pid: process.pid,
        state: 'error',
        intervalSeconds,
        lastErrorAt: new Date().toISOString(),
        lastError: error.message
      }));
      console.error(JSON.stringify({
        ok: false,
        action: 'watch-personal-messages',
          error: error.message
      }, null, 2));
    } finally {
      if (!runOnce) {
        setTimeout(loop, Math.max(15, intervalSeconds) * 1000);
      }
    }
  };

  await loop();
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    action: 'watch-personal-messages',
    error: error.message
  }, null, 2));
  process.exit(1);
});
