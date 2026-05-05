import { spawn } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function getLarkCliCommand() {
  const npmGlobal = process.env.npm_config_prefix || 'E:\\npm-global';
  const possiblePaths = [
    'lark-cli',
    join(npmGlobal, 'node_modules', '.bin', 'lark-cli.cmd'),
    'E:\\npm-global\\node_modules\\.bin\\lark-cli.cmd'
  ];

  for (const p of possiblePaths) {
    if (existsSync(p)) {
      return p;
    }
  }
  return 'lark-cli';
}

async function runCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: true, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('close', code => {
      resolve({ stdout, stderr, code });
    });
    child.on('error', err => reject(err));
  });
}

async function checkCommand(name, cmd, args) {
  console.log(`\n📋 Checking ${name}...`);
  try {
    const result = await runCommand(cmd, args);
    if (result.code === 0) {
      console.log(`  ✅ ${name} is available`);
      return { success: true, output: result.stdout.substring(0, 200) };
    } else {
      console.log(`  ❌ ${name} failed with code ${result.code}`);
      return { success: false, error: result.stderr || `exit code ${result.code}` };
    }
  } catch (err) {
    console.log(`  ❌ ${name} failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function checkAuthStatus() {
  console.log('\n📋 Checking auth status...');
  try {
    const result = await runCommand('lark-cli', ['auth', 'status']);
    const output = result.stdout;

    const hasUser = output.includes('"identity": "user"') || (output.includes('user') && output.includes('ou_'));
    const hasApp = output.includes('"identity": "bot"') || output.includes('bot');
    const hasToken = output.includes('token') || output.includes('Token');

    if (hasUser) {
      console.log('  ✅ User is logged in');
    } else if (hasApp) {
      console.log('  ⚠️  Only app identity, user not logged in');
    } else {
      console.log('  ❌ No valid auth found');
    }

    const tokenMatch = output.match(/expiry[":\s]+(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})/i);
    if (tokenMatch) {
      console.log(`  📅 Token expiry: ${tokenMatch[1]}`);
      const expiry = new Date(tokenMatch[1]);
      const now = new Date();
      if (expiry < now) {
        console.log('  ⚠️  Token has expired! Need to re-login');
      } else if (expiry - now < 24 * 60 * 60 * 1000) {
        console.log('  ⚠️  Token expires in less than 24 hours');
      } else {
        console.log('  ✅ Token is valid');
      }
    }

    return { hasUser, hasApp, hasToken };
  } catch (err) {
    console.log(`  ❌ Auth check failed: ${err.message}`);
    return { hasUser: false, hasApp: false, hasToken: false, error: err.message };
  }
}

async function loadLocalConfig() {
  console.log('\n📋 Checking .flowmate.local.json...');
  try {
    const configPath = resolve(__dirname, '..', '.flowmate.local.json');
    const content = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content);
    console.log('  ✅ Local config found');
    return config;
  } catch {
    console.log('  ⚠️  No .flowmate.local.json found (may need to run setup)');
    return null;
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' FlowMate: lark-cli Diagnostic Report');
  console.log('═══════════════════════════════════════════════════════════════');

  const checks = [];

  console.log('\n[1/4] Basic availability');
  const larkCliCmd = getLarkCliCommand();
  console.log(`  Using lark-cli from: ${larkCliCmd}`);

  checks.push(await checkCommand('lark-cli --version', larkCliCmd, ['--version']));
  checks.push(await checkCommand('lark-cli --help', larkCliCmd, ['--help']));

  console.log('\n[2/4] Auth status');
  const auth = await checkAuthStatus();
  checks.push({ success: auth.hasUser || auth.hasApp });

  console.log('\n[3/4] Local config');
  const localConfig = await loadLocalConfig();
  checks.push({ success: true });

  console.log('\n[4/4] Token validity check');
  if (auth.error && auth.error.includes('401')) {
    console.log('  ⚠️  Token appears invalid (401 error)');
    console.log('  💡 Run: lark-cli auth login --recommend');
  } else if (!auth.hasToken) {
    console.log('  ⚠️  Cannot determine token validity');
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(' Summary');
  console.log('═══════════════════════════════════════════════════════════════');

  const allPassed = checks.every(c => c.success);
  if (allPassed) {
    console.log('✅ All checks passed!');
  } else {
    console.log('⚠️  Some checks failed. Please fix before running other scripts.');
  }

  if (localConfig) {
    console.log('\n📁 Configured resources:');
    if (localConfig.bitable) {
      console.log(`  - Bitable App: ${localConfig.bitable.appToken}`);
      console.log(`  - Table: ${localConfig.bitable.tableId}`);
    }
    if (localConfig.task) {
      console.log(`  - Task: ${localConfig.task.taskId}`);
    }
    console.log(`  - Last check: ${localConfig.lastCheck}`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════\n');

  process.exit(allPassed ? 0 : 1);
}

main().catch(err => {
  console.error('❌ Unexpected error:', err.message);
  process.exit(1);
});
