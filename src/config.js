import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const envPath = resolve(__dirname, '..', '.env');
  try {
    const content = readFileSync(envPath, 'utf-8');
    const env = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...valueParts] = trimmed.split('=');
        if (key) {
          env[key.trim()] = valueParts.join('=').trim();
        }
      }
    }
    return env;
  } catch {
    return {};
  }
}

const env = loadEnv();

export const config = {
  zai: {
    apiKey: process.env.ZAI_API_KEY || env.ZAI_API_KEY || '',
    model: process.env.ZAI_MODEL || env.ZAI_MODEL || 'zai/glm-4.7',
    fallbackModel: process.env.ZAI_FALLBACK_MODEL || env.ZAI_FALLBACK_MODEL || 'glm-4.7',
    apiUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions'
  },

  openclaw: {
    stateDir: process.env.FLOWMATE_OPENCLAW_STATE_DIR || env.FLOWMATE_OPENCLAW_STATE_DIR || 'E:/feishu-ai-competition/openclaw-state/workspace',
    gatewayUrl: process.env.FLOWMATE_OPENCLAW_GATEWAY_URL || env.FLOWMATE_OPENCLAW_GATEWAY_URL || 'ws://127.0.0.1:18789'
  },

  ledger: {
    path: process.env.FLOWMATE_LEDGER_PATH || env.FLOWMATE_LEDGER_PATH || './data/commitment_ledger.local.json'
  },

  feishu: {
    appToken: process.env.FLOWMATE_BITABLE_APP_TOKEN || env.FLOWMATE_BITABLE_APP_TOKEN || '',
    tableId: process.env.FLOWMATE_BITABLE_TABLE_ID || env.FLOWMATE_BITABLE_TABLE_ID || '',
    recordId: process.env.FLOWMATE_BITABLE_RECORD_ID || env.FLOWMATE_BITABLE_RECORD_ID || '',
    taskId: process.env.FLOWMATE_TASK_ID || env.FLOWMATE_TASK_ID || ''
  },

  flowmate: {
    testPrefix: '[FlowMate测试]',
    ledgerTableName: 'FlowMate_Commitment_Ledger',
    ledgerFields: [
      '承诺ID',
      '承诺标题',
      '负责人',
      '负责人OpenID',
      '截止时间文本',
      '标准截止时间',
      '状态',
      '优先级',
      '来源类型',
      '来源标题',
      '来源链接',
      '证据原文',
      '置信度',
      '下一步动作',
      '风险原因',
      '飞书任务ID',
      '创建时间',
      '更新时间'
    ]
  }
};

export function getMaskedApiKey() {
  const key = config.zai.apiKey;
  if (!key) return '(not set)';
  if (key.length <= 8) return '****';
  return key.substring(0, 4) + '****' + key.substring(key.length - 4);
}

export function validateConfig() {
  const errors = [];

  if (!config.zai.apiKey || config.zai.apiKey === '<ZAI_API_KEY>') {
    errors.push('ZAI_API_KEY is not set');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}
