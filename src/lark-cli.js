import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { resolve as resolvePath, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCAL_LARK_CLI_RUNNER = resolvePath(__dirname, '..', 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js');

export class LarkCliError extends Error {
  constructor(message, code, stderr, stdout) {
    super(message);
    this.name = 'LarkCliError';
    this.code = code;
    this.stderr = stderr;
    this.stdout = stdout;
  }
}

function resolveLarkCliInvocation() {
  if (existsSync(LOCAL_LARK_CLI_RUNNER)) {
    return {
      command: process.execPath,
      argsPrefix: [LOCAL_LARK_CLI_RUNNER],
      displayName: 'local @larksuite/cli'
    };
  }

  return {
    command: 'lark-cli',
    argsPrefix: [],
    displayName: 'lark-cli'
  };
}

export async function larkCli(args, options = {}) {
  return new Promise((resolve, reject) => {
    const invocation = resolveLarkCliInvocation();
    const commandArgs = [...invocation.argsPrefix, ...args];
    const childEnv = { ...process.env, ...(options.env || {}) };
    const userProfile = process.env.USERPROFILE || process.env.HOME || '';

    if (userProfile && !childEnv.LARKSUITE_CLI_CONFIG_DIR) {
      childEnv.LARKSUITE_CLI_CONFIG_DIR = resolvePath(userProfile, '.lark-cli');
    }

    delete childEnv.OPENCLAW_CLI;
    delete childEnv.OPENCLAW_HOME;
    delete childEnv.OPENCLAW_STATE_DIR;
    delete childEnv.OPENCLAW_CONFIG_PATH;
    delete childEnv.OPENCLAW_SERVICE_MARKER;
    delete childEnv.OPENCLAW_SERVICE_VERSION;
    delete childEnv.OPENCLAW_GATEWAY_PORT;
    delete childEnv.OPENCLAW_SHELL;

    const child = spawn(invocation.command, commandArgs, {
      ...options,
      env: childEnv,
      shell: false,
      windowsHide: true
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
        resolve({ stdout, stderr, exitCode: code });
      } else {
        reject(new LarkCliError(
          `${invocation.displayName} ${args.join(' ')} failed with code ${code}`,
          code,
          stderr,
          stdout
        ));
      }
    });

    child.on('error', (err) => {
      reject(new LarkCliError(`Failed to spawn ${invocation.displayName}: ${err.message}`, -1, '', ''));
    });

    if (options.timeout) {
      setTimeout(() => {
        child.kill();
        reject(new LarkCliError(`${invocation.displayName} ${args.join(' ')} timed out`, -1, '', ''));
      }, options.timeout);
    }
  });
}

export async function larkCliJson(args, options = {}) {
  const result = await larkCli(args, options);
  try {
    const output = result.stdout.trim();
    if (!output) {
      throw new Error('empty output');
    }

    try {
      return JSON.parse(output);
    } catch {
      const lines = output.split('\n');
      const lastLine = lines[lines.length - 1];
      return JSON.parse(lastLine);
    }
  } catch (e) {
    throw new LarkCliError(
      `Failed to parse JSON output: ${e.message}. Output: ${result.stdout.substring(0, 500)}`,
      result.exitCode,
      result.stderr,
      result.stdout
    );
  }
}
