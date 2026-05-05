import { writeFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { scanTeamSources, buildTeamWarnings, buildAndPushTeamDigest } from '../src/team-monitor.js';
import { config } from '../src/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workspaceStateDir = resolve(config.openclaw.stateDir, 'state');
const watcherPath = resolve(workspaceStateDir, 'flowmate-team-monitor-watcher.json');

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function writeStatus(patch) {
  mkdirSync(dirname(watcherPath), { recursive: true });
  writeFileSync(watcherPath, JSON.stringify({
    pid: process.pid,
    updatedAt: new Date().toISOString(),
    ...patch
  }, null, 2));
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function runLoop(args) {
  const intervalSeconds = Math.max(60, Number(args.interval || 300));
  writeStatus({ state: 'running', intervalSeconds, startedAt: new Date().toISOString() });

  do {
    try {
      writeStatus({ state: 'running', intervalSeconds, lastLoopAt: new Date().toISOString() });
      const scan = await scanTeamSources(args);
      const warnings = await buildTeamWarnings({
        hours: args.hours || 24,
        notify: args.notify || 'false',
        'notify-owners': args['notify-owners'] || 'true'
      });
      let digest = null;
      if (args.digest === 'true') {
        digest = await buildAndPushTeamDigest({
          period: args.period || 'daily',
          notify: args.notify || 'false'
        });
      }
      writeStatus({
        state: 'running',
        intervalSeconds,
        lastResultAt: new Date().toISOString(),
        lastSyncedCount: scan.syncedCount || 0,
        lastWarningCount: warnings.warningCount || 0,
        lastDigestAt: digest ? new Date().toISOString() : '',
        lastError: ''
      });
    } catch (error) {
      writeStatus({
        state: 'error',
        intervalSeconds,
        lastErrorAt: new Date().toISOString(),
        lastError: error.message
      });
    }

    if (args.once) {
      break;
    }
    await sleep(intervalSeconds * 1000);
  } while (true);
}

await runLoop(parseArgs(process.argv.slice(2)));
