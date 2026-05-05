import { spawnSync } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const teamEntry = resolve(root, 'scripts', 'team-entry.js');

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function runJson(label, args, { timeout = 300000 } = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    env: {
      ...process.env,
      LARKSUITE_CLI_CONFIG_DIR: process.env.LARKSUITE_CLI_CONFIG_DIR || resolve(process.env.USERPROFILE || process.env.HOME || root, '.lark-cli')
    }
  });
  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();
  if (result.status !== 0) {
    throw new Error(`${label} failed with code ${result.status}\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`);
  }
  try {
    return JSON.parse(stdout || '{}');
  } catch {
    return JSON.parse(stdout.split(/\r?\n/u).filter(Boolean).at(-1));
  }
}

const args = parseArgs(process.argv.slice(2));
const question = args.question || '根据最近的团队来源，FlowMate 现在有哪些待推进事项或风险？请给证据来源。';
const qa = runJson('team knowledge qa', [
  teamEntry,
  'qa',
  '--question',
  question
]);

console.log(JSON.stringify({
  ok: qa.ok === true,
  action: 'self-test-team-knowledge-qa',
  question,
  answer: qa.answer || qa.userFacingHint || '',
  evidenceCount: qa.evidence?.length || 0,
  evidence: qa.evidence || [],
  raw: qa,
  userFacingHint: qa.userFacingHint || qa.answer || '没有找到足够证据。'
}, null, 2));
