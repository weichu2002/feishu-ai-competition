import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { larkCliJson } from './lark-cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workspaceDir = resolve(config.openclaw.stateDir);
const workspaceStateDir = resolve(workspaceDir, 'state');
const localLarkCliRunnerPath = resolve(__dirname, '..', 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js');

export const personalMonitorPaths = {
  workspaceDir,
  workspaceStateDir,
  control: resolve(workspaceStateDir, 'flowmate-personal-monitor-control.json'),
  auth: resolve(workspaceStateDir, 'flowmate-personal-message-auth-state.json'),
  watcher: resolve(workspaceStateDir, 'flowmate-personal-monitor-watcher.json')
};

function ensureDir(path) {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

function readJson(path, fallback) {
  if (!existsSync(path)) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(path, value) {
  ensureDir(workspaceStateDir);
  writeFileSync(path, JSON.stringify(value, null, 2));
}

export function loadWorkspaceUserProfile() {
  const profile = {
    name: '',
    openId: ''
  };
  const userPath = resolve(workspaceDir, 'USER.md');
  if (!existsSync(userPath)) {
    return profile;
  }

  const content = readFileSync(userPath, 'utf-8');
  const nameMatch = content.match(/\*\*.*?[:：]\s*(.+)/u);
  const openIdMatch = content.match(/(ou_[A-Za-z0-9]+)/u);
  if (nameMatch?.[1]) {
    profile.name = nameMatch[1].trim();
  }
  if (openIdMatch?.[1]) {
    profile.openId = openIdMatch[1].trim();
  }

  return profile;
}

export function loadMonitorControl() {
  const raw = readJson(personalMonitorPaths.control, {});
  return {
    enabled: raw.enabled !== false,
    pausedUntil: typeof raw.pausedUntil === 'string' ? raw.pausedUntil : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    updatedBy: typeof raw.updatedBy === 'string' ? raw.updatedBy : '',
    reason: typeof raw.reason === 'string' ? raw.reason : ''
  };
}

export function saveMonitorControl(control) {
  writeJson(personalMonitorPaths.control, control);
}

export function setMonitorEnabled(reason = '', updatedBy = 'system') {
  const next = {
    enabled: true,
    pausedUntil: '',
    updatedAt: new Date().toISOString(),
    updatedBy,
    reason
  };
  saveMonitorControl(next);
  return next;
}

export function setMonitorDisabled(reason = '', updatedBy = 'system') {
  const next = {
    enabled: false,
    pausedUntil: '',
    updatedAt: new Date().toISOString(),
    updatedBy,
    reason
  };
  saveMonitorControl(next);
  return next;
}

export function setMonitorPaused({ minutes = 0, until = '', reason = '', updatedBy = 'system' } = {}) {
  let pausedUntil = '';
  if (until) {
    pausedUntil = new Date(until).toISOString();
  } else {
    const resolvedMinutes = Math.max(1, Number(minutes || 0));
    pausedUntil = new Date(Date.now() + resolvedMinutes * 60 * 1000).toISOString();
  }

  const next = {
    enabled: true,
    pausedUntil,
    updatedAt: new Date().toISOString(),
    updatedBy,
    reason
  };
  saveMonitorControl(next);
  return next;
}

export function getMonitorGate(now = new Date()) {
  const control = loadMonitorControl();
  if (!control.enabled) {
    return {
      allow: false,
      state: 'disabled',
      control
    };
  }

  if (control.pausedUntil) {
    const pausedUntil = new Date(control.pausedUntil);
    if (Number.isFinite(pausedUntil.getTime()) && pausedUntil.getTime() > now.getTime()) {
      return {
        allow: false,
        state: 'paused',
        resumeAt: control.pausedUntil,
        control
      };
    }
  }

  return {
    allow: true,
    state: 'enabled',
    control
  };
}

export function loadAuthState() {
  return readJson(personalMonitorPaths.auth, {
    status: 'idle'
  });
}

export function saveAuthState(state) {
  writeJson(personalMonitorPaths.auth, state);
}

export function clearAuthState() {
  saveAuthState({
    status: 'authorized',
    lastAuthorizedAt: new Date().toISOString()
  });
}

export function isPendingAuthValid(state) {
  if (!state?.verificationUrl || !state?.expiresAt) {
    return false;
  }

  const expiresAt = new Date(state.expiresAt);
  return Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() > Date.now();
}

export async function getLarkAuthStatus() {
  return await larkCliJson(['auth', 'status']);
}

export function hasUserIdentity(status) {
  return status?.identity === 'user';
}

export async function createMessageSearchAuthPrompt() {
  return await larkCliJson(['auth', 'login', '--scope', 'search:message', '--no-wait']);
}

export function startDeviceCodeCompletion(deviceCode, onClose) {
  const child = spawn(process.execPath, [
    localLarkCliRunnerPath,
    'auth',
    'login',
    '--device-code',
    deviceCode
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
    shell: false
  });

  let stderr = '';
  child.stderr.on('data', (data) => {
    stderr += data.toString();
  });

  child.on('close', (code) => {
    if (typeof onClose === 'function') {
      onClose({
        closedAt: new Date().toISOString(),
        exitCode: code,
        error: stderr.trim()
      });
    }
  });

  child.on('error', (error) => {
    if (typeof onClose === 'function') {
      onClose({
        closedAt: new Date().toISOString(),
        exitCode: -1,
        error: error.message
      });
    }
  });

  return child;
}

export function loadWatcherStatus() {
  return readJson(personalMonitorPaths.watcher, {
    pid: 0,
    state: 'idle',
    intervalSeconds: 60,
    startedAt: '',
    lastLoopAt: '',
    lastResultAt: '',
    lastErrorAt: '',
    lastError: ''
  });
}

export function saveWatcherStatus(status) {
  writeJson(personalMonitorPaths.watcher, status);
}

export function buildWatcherStatusPatch(patch = {}) {
  const current = loadWatcherStatus();
  return {
    ...current,
    ...patch
  };
}

export function isWatcherHealthy(status = loadWatcherStatus()) {
  const heartbeatAt = status.lastLoopAt || status.lastResultAt || '';
  if (!heartbeatAt) {
    return false;
  }

  const heartbeat = new Date(heartbeatAt);
  if (!Number.isFinite(heartbeat.getTime())) {
    return false;
  }

  const intervalSeconds = Math.max(15, Number(status.intervalSeconds || 60));
  return Date.now() - heartbeat.getTime() <= intervalSeconds * 2500;
}
