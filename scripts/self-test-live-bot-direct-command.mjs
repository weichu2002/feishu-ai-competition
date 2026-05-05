import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const stateDir = path.join(repoRoot, "openclaw-state");
const assistantEntry = path.join(repoRoot, "flowmate", "scripts", "assistant-entry.js");
const openclawLarkSrcDir = path.join(stateDir, "extensions", "openclaw-lark", "src");
const require = createRequire(import.meta.url);

process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
process.env.FLOWMATE_ASSISTANT_ENTRY = assistantEntry;

const { LarkClient } = require(path.join(openclawLarkSrcDir, "core", "lark-client.js"));
const { handleFeishuMessage } = require(
  path.join(openclawLarkSrcDir, "messaging", "inbound", "handler.js"),
);

const cfg = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
const text = process.argv[2] || "监听状态";
const replyToMessageId = process.argv[3] ?? "";
const chatId = process.argv[4] || "oc_fa243762d6cb60e2939fdd9f24db7bce";
const senderOpenId = process.argv[5] || "ou_f6a2032768953df1c08ea6b4b2d7b306";
const messageId = process.argv[6] || `om_flowmate_lark_direct_${Date.now()}`;

const runtime = {
  channel: {
    reply: {
      resolveEnvelopeFormatOptions: () => ({}),
      formatAgentEnvelope: ({ body }) => String(body ?? ""),
      finalizeInboundContext: (payload) => payload,
    },
    routing: {
      resolveAgentRoute: () => ({ sessionKey: "agent:main:main", agentId: "main" }),
    },
    commands: {
      isControlCommandMessage: (value) => /^\/(?:new|reset|status)\b/i.test(String(value ?? "").trim()),
      shouldComputeCommandAuthorized: () => false,
      resolveCommandAuthorizedFromAuthorizers: () => false,
    },
  },
  system: {
    enqueueSystemEvent: () => {},
  },
};

LarkClient.setRuntime(runtime);
LarkClient.setGlobalConfig?.(cfg);

await handleFeishuMessage({
  cfg,
  accountId: "default",
  botOpenId: undefined,
  forceMention: true,
  replyToMessageId,
  event: {
    sender: {
      sender_id: { open_id: senderOpenId },
    },
    message: {
      message_id: messageId,
      chat_id: chatId,
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text }),
    },
  },
  runtime: {
    ...runtime,
    log: (...args) => console.error("[runtime.log]", ...args),
    error: (...args) => console.error("[runtime.error]", ...args),
  },
});

process.stdout.write(
  JSON.stringify(
    {
      ok: true,
      text,
      replyToMessageId,
      messageId,
      chatId,
      senderOpenId,
      handled: true,
      channel: "openclaw-lark",
    },
    null,
    2,
  ),
);
