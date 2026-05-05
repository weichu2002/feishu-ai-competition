const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(repoRoot, 'openclaw-state');
process.env.OPENCLAW_STATE_DIR = stateDir;

const openclawConfigPath = path.join(stateDir, 'openclaw.json');
const cfg = JSON.parse(fs.readFileSync(openclawConfigPath, 'utf8'));

require(path.join(
  stateDir,
  'extensions',
  'openclaw-lark',
  'src',
  'messaging',
  'inbound',
  'handler.js',
));
const { dispatchSyntheticTextMessage } = require(path.join(
  stateDir,
  'extensions',
  'openclaw-lark',
  'src',
  'messaging',
  'inbound',
  'synthetic-message.js',
));

async function main() {
  const text = process.argv[2] || '监听状态';
  const replyToMessageId = process.argv[3];
  const chatId = process.argv[4] || 'oc_fa243762d6cb60e2939fdd9f24db7bce';
  const senderOpenId = process.argv[5] || 'ou_f6a2032768953df1c08ea6b4b2d7b306';

  if (!replyToMessageId) {
    throw new Error('replyToMessageId is required');
  }

  const syntheticMessageId = `om_flowmate_smoke_${Date.now()}`;

  await dispatchSyntheticTextMessage({
    cfg,
    accountId: 'default',
    chatId,
    senderOpenId,
    text,
    syntheticMessageId,
    replyToMessageId,
    chatType: 'p2p',
    runtime: {
      log: (...args) => console.log('[runtime.log]', ...args),
      error: (...args) => console.error('[runtime.error]', ...args),
    },
    forceMention: true,
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        text,
        replyToMessageId,
        chatId,
        senderOpenId,
        syntheticMessageId,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
