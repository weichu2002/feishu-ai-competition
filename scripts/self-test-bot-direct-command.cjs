const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const stateConfigPath = path.join(repoRoot, 'openclaw-state', 'openclaw.json');
const cacheRoot = path.join(
  repoRoot,
  'openclaw-state',
  'extensions',
  'openclaw-lark',
  'node_modules',
  '.cache',
  'jiti',
);

function resolveLarkCacheModule(prefix) {
  const matches = fs
    .readdirSync(cacheRoot)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.cjs'))
    .sort();
  if (matches.length === 0) {
    throw new Error(`openclaw-lark cache module not found: ${prefix}`);
  }
  return path.join(cacheRoot, matches[matches.length - 1]);
}

const { LarkClient } = require(resolveLarkCacheModule('core-lark-client.'));
const { handleFeishuMessage } = require(resolveLarkCacheModule('inbound-handler.'));

const cfg = JSON.parse(fs.readFileSync(stateConfigPath, 'utf8'));
const text = process.argv[2] || '监听状态';
const chatId = process.argv[3] || 'oc_fa243762d6cb60e2939fdd9f24db7bce';
const senderOpenId = process.argv[4] || 'ou_f6a2032768953df1c08ea6b4b2d7b306';
const replyToMessageId = process.argv[5] ?? '';

const runtimeStub = {
  log: (...args) => console.error('[runtime:log]', ...args),
  error: (...args) => console.error('[runtime:error]', ...args),
  exit: (code) => process.exit(code),
  config: {
    loadConfig: () => cfg,
  },
  channel: {
    reply: {
      resolveEnvelopeFormatOptions: () => ({}),
    },
    routing: {
      resolveAgentRoute: () => ({ sessionKey: 'agent:main:main' }),
    },
    commands: {
      shouldComputeCommandAuthorized: () => false,
      resolveCommandAuthorizedFromAuthorizers: async () => false,
    },
  },
  system: {
    enqueueSystemEvent: () => {},
  },
};

LarkClient.setRuntime(runtimeStub);
LarkClient.setGlobalConfig?.(cfg);

async function main() {
  const syntheticMessageId = `flowmate-selftest-${Date.now()}`;
  await handleFeishuMessage({
    cfg,
    accountId: 'default',
    botOpenId: undefined,
    forceMention: true,
    replyToMessageId,
    event: {
      sender: {
        sender_id: { open_id: senderOpenId },
      },
      message: {
        message_id: syntheticMessageId,
        chat_id: chatId,
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text }),
      },
    },
    runtime: runtimeStub,
  });
  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        text,
        syntheticMessageId,
        replyToMessageId,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
