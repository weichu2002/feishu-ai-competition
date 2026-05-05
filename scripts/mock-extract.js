import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createCommitment, createEvidence, Confidence, SourceType } from '../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const COMMITMENT_PATTERNS = [
  { regex: /我(今晚|今天|明天|后天|这周|这月)/i, type: 'relative_deadline', confidence: 'high' },
  { regex: /(\d+)小时/i, type: 'relative_deadline', confidence: 'high' },
  { regex: /(\d+)天/i, type: 'relative_deadline', confidence: 'high' },
  { regex: /下周三|下周一|下周五/i, type: 'absolute_deadline', confidence: 'medium' },
  { regex: /可能会卡|可能有问题|可能延期|可能会影响/i, type: 'risk', confidence: 'low' },
  { regex: /已完成|已发|已同步|已写好/i, type: 'done', confidence: 'high' }
];

const COMMITMENT_KEYWORDS = [
  '我来做', '我负责', '我来', '我来调研', '我来负责',
  '我今晚', '我明天', '我今天', '我下午', '我先',
  '会后我', '会后', '同步', '完成', '做好', '发 PR', '发到',
  '收到，我', '收到'
];

const REJECT_PATTERNS = [
  /^(好的|好的吧|好的，)/i,
  /^(那|那就)/i,
  /^(等|等等)/i,
  /大家记得/i,
  /有问题随时问/i,
  /可以先做.*版本/i,
  /^功能太多.*延期/i
];

function extractCommitmentFromUtterance(utterance) {
  const commitments = [];

  if (REJECT_PATTERNS.some(p => p.test(utterance.text))) {
    return commitments;
  }

  const sentences = utterance.text.split(/[，。,.!！?？;；\n]/).filter(s => s.trim());

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (trimmed.length < 5) continue;

    const hasKeyword = COMMITMENT_KEYWORDS.some(k => trimmed.includes(k));

    let confidence = Confidence.MEDIUM;
    let deadlineText = '';
    let deadline = null;
    let riskReason = '';
    let nextAction = '';
    let isRisk = false;

    for (const pattern of COMMITMENT_PATTERNS) {
      const match = trimmed.match(pattern.regex);
      if (match) {
        if (pattern.type === 'relative_deadline') {
          confidence = pattern.confidence;
          deadlineText = match[0];
          deadline = parseRelativeDeadline(deadlineText);
        } else if (pattern.type === 'risk') {
          confidence = Confidence.LOW;
          riskReason = trimmed;
          isRisk = true;
        } else if (pattern.type === 'done') {
          confidence = Confidence.HIGH;
        }
      }
    }

    if (!hasKeyword && !isRisk) continue;

    const evidence = createEvidence({
      sourceType: utterance.sourceType,
      sourceTitle: utterance.sourceTitle,
      sourceLink: utterance.sourceLink,
      quote: trimmed,
      speaker: utterance.speaker,
      timestamp: utterance.timestamp
    });

    const commitment = createCommitment({
      title: trimmed,
      owner: utterance.speaker,
      deadlineText: deadlineText || '待确认',
      deadline: deadline,
      priority: confidence === Confidence.HIGH ? 'P1' : 'P2',
      status: riskReason ? 'blocked' : (deadline ? 'pending' : 'pending'),
      sourceType: utterance.sourceType === 'chat' ? SourceType.CHAT : SourceType.MEETING,
      sourceTitle: utterance.sourceTitle,
      sourceLink: utterance.sourceLink,
      evidence: [evidence],
      confidence: confidence,
      nextAction: nextAction,
      riskReason: riskReason
    });

    commitments.push(commitment);
  }

  return commitments;
}

function parseRelativeDeadline(text) {
  const now = new Date();
  const lower = text.toLowerCase();

  if (lower.includes('今晚') || lower.includes('今天')) {
    const d = new Date(now);
    d.setHours(23, 59, 59, 999);
    return d.toISOString();
  }
  if (lower.includes('明天')) {
    const d = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    d.setHours(23, 59, 59, 999);
    return d.toISOString();
  }
  if (lower.includes('下午')) {
    const d = new Date(now);
    d.setHours(17, 0, 0, 0);
    return d.toISOString();
  }
  if (lower.match(/\d+小时/)) {
    const hours = parseInt(lower.match(/\d+/)[0]);
    return new Date(now.getTime() + hours * 60 * 60 * 1000).toISOString();
  }
  if (lower.match(/\d+天/)) {
    const days = parseInt(lower.match(/\d+/)[0]);
    return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
  }

  return null;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' FlowMate: Mock 承诺抽取');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const dataPath = resolve(__dirname, '..', 'examples', 'meeting-minutes.json');
  const outputPath = resolve(__dirname, '..', 'data', 'commitment_ledger.local.json');

  console.log(`📖 读取 mock 数据: ${dataPath}`);

  let utterances;
  try {
    const content = readFileSync(dataPath, 'utf-8');
    utterances = JSON.parse(content);
    console.log(`✅ 读取成功，共 ${utterances.length} 条发言\n`);
  } catch (err) {
    console.error(`❌ 读取失败: ${err.message}`);
    process.exit(1);
  }

  console.log('🔍 开始抽取承诺...\n');

  const allCommitments = [];

  for (const utterance of utterances) {
    const extracted = extractCommitmentFromUtterance(utterance);
    if (extracted.length > 0) {
      console.log(`  📌 ${utterance.speaker}: ${extracted.length} 条承诺`);
      allCommitments.push(...extracted);
    }
  }

  console.log(`\n✅ 共抽取 ${allCommitments.length} 条承诺\n`);

  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' 承诺列表');
  console.log('═══════════════════════════════════════════════════════════════\n');

  for (const c of allCommitments) {
    console.log(`  ${c.confidence === 'high' ? '🟢' : c.confidence === 'medium' ? '🟡' : '🔴'} [${c.status}] ${c.title}`);
    console.log(`     负责人: ${c.owner} | 截止: ${c.deadlineText} | 置信度: ${c.confidence}`);
    if (c.riskReason) {
      console.log(`     风险: ${c.riskReason}`);
    }
    console.log();
  }

  const ledger = {
    version: '1.0.0',
    commitments: allCommitments,
    metadata: {
      createdAt: new Date().toISOString(),
      source: 'mock-extract',
      total: allCommitments.length,
      byConfidence: {
        high: allCommitments.filter(c => c.confidence === 'high').length,
        medium: allCommitments.filter(c => c.confidence === 'medium').length,
        low: allCommitments.filter(c => c.confidence === 'low').length
      },
      byStatus: {
        pending: allCommitments.filter(c => c.status === 'pending').length,
        blocked: allCommitments.filter(c => c.status === 'blocked').length,
        done: allCommitments.filter(c => c.status === 'done').length
      }
    }
  };

  writeFileSync(outputPath, JSON.stringify(ledger, null, 2));
  console.log(`💾 账本已保存到: ${outputPath}`);

  console.log('\n═══════════════════════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('❌ 错误:', err.message);
  process.exit(1);
});
