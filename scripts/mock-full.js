import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CommitmentLedger } from '../src/ledger.js';
import { CardGenerator } from '../src/cards.js';
import { ModelClient } from '../src/model-client.js';
import { CommitmentStatus, SourceType, createCommitment, createEvidence } from '../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  console.log('='.repeat(60));
  console.log('FlowMate Full Mock Test');
  console.log('='.repeat(60));
  console.log();

  const ledger = new CommitmentLedger();
  const cardGen = new CardGenerator(ledger);
  const modelClient = new ModelClient();

  console.log('[1/8] 加载账本...');
  ledger.load(resolve(__dirname, '../.flowmate.local.json'));
  console.log(`  ✓ ${ledger.commitments.length} 条承诺\n`);

  console.log('[2/8] 加载模型...');
  console.log(`  ✓ 模型: ${modelClient.modelName}\n`);

  console.log('[3/8] 模拟提取...');
  const mockMinutes = `[张艺航]: 大家好，今天我们讨论Q2产品规划。我负责路线图更新，下周三完成初稿。

[李明]: 技术债务清理计划，我和团队讨论后4月底给出方案。

[王芳]: 用户体验优化，我已经完成第一版设计，本周五演示。

[陈总]: 希望大家月底前完成各自模块。

[张艺航]: 我还会准备一个技术方案文档，下周五前完成初版。`;

  const mockCommitments = [
    createCommitment({
      title: 'Q2产品路线图更新初稿',
      owner: '张艺航',
      deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      status: CommitmentStatus.PENDING,
      priority: 'high',
      confidence: 'high',
      source: SourceType.MEETING_MINUTES
    }),
    createCommitment({
      title: '技术债务清理计划',
      owner: '李明',
      deadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      status: CommitmentStatus.PENDING,
      priority: 'medium',
      confidence: 'high',
      source: SourceType.MEETING_MINUTES
    }),
    createCommitment({
      title: '用户体验优化第一版演示',
      owner: '王芳',
      deadline: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
      status: CommitmentStatus.IN_PROGRESS,
      priority: 'high',
      confidence: 'high',
      source: SourceType.MEETING_MINUTES
    }),
    createCommitment({
      title: '各自模块开发完成',
      owner: '全员',
      deadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      status: CommitmentStatus.PENDING,
      priority: 'medium',
      confidence: 'medium',
      source: SourceType.MEETING_MINUTES
    }),
    createCommitment({
      title: '技术方案文档初版',
      owner: '张艺航',
      deadline: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      status: CommitmentStatus.PENDING,
      priority: 'medium',
      confidence: 'high',
      source: SourceType.MEETING_MINUTES
    })
  ];

  for (const c of mockCommitments) {
    c.evidence.push(createEvidence({
      quote: mockMinutes,
      source: 'meeting-minutes',
      speaker: c.owner,
      timestamp: new Date().toISOString()
    }));
    ledger.add(c);
  }

  ledger.save();
  console.log(`  ✓ 添加了 ${mockCommitments.length} 条承诺到账本\n`);

  console.log('[4/8] 生成卡片...');
  const postCard = cardGen.generatePostMeetingCard(mockCommitments, {
    title: 'Q2产品规划会议',
    time: new Date().toLocaleString('zh-CN'),
    participantCount: 4
  });
  console.log(`  ✓ 会后卡片: ${postCard.header.title.content}\n`);

  console.log('[5/8] 统计账本...');
  const stats = ledger.getStats();
  console.log(`  ✓ 总承诺: ${stats.total}`);
  console.log(`  ✓ 待确认: ${stats.pending}`);
  console.log(`  ✓ 进行中: ${stats.inProgress}`);
  console.log(`  ✓ 已完成: ${stats.done}`);
  console.log(`  ✓ 逾期: ${stats.overdue}`);
  console.log(`  ✓ 临期: ${stats.dueSoon}\n`);

  console.log('[6/8] 晚间复盘...');
  const eveningCard = cardGen.generateEveningReviewCard({
    date: new Date().toLocaleDateString('zh-CN'),
    pending: stats.pending,
    done: stats.done,
    overdue: stats.overdue,
    newCommitments: mockCommitments.length
  });
  console.log(`  ✓ 晚间卡片: ${eveningCard.header.title.content}\n`);

  console.log('[7/8] 临期提醒...');
  const dueSoon = ledger.getDueSoon(24 * 60);
  if (dueSoon.length > 0) {
    const reminderCard = cardGen.generateReminderCard(dueSoon[0]);
    console.log(`  ✓ 临期承诺: ${dueSoon[0].title}`);
    console.log(`  ✓ 提醒卡片: ${reminderCard.header.title.content}\n`);
  } else {
    console.log('  ✓ 暂无临期承诺\n');
  }

  console.log('[8/8] 承诺详情...');
  const detailCard = cardGen.generateCommitmentDetailCard(ledger.commitments[0]);
  console.log(`  ✓ 详情卡片: ${detailCard.header.title.content}\n`);

  console.log('='.repeat(60));
  console.log('Full Mock Test PASSED');
  console.log('='.repeat(60));
}

main().catch(console.error);
