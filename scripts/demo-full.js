import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CommitmentLedger } from '../src/ledger.js';
import { CardGenerator } from '../src/cards.js';
import { FeishuWriter } from '../src/feishu-write.js';
import { ModelClient } from '../src/model-client.js';
import { CommitmentStatus, Priority, SourceType, createCommitment, createEvidence } from '../src/types.js';
import { config } from '../src/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  console.log('='.repeat(60));
  console.log('FlowMate 端到端演示 (demo:full)');
  console.log('='.repeat(60));
  console.log();

  const startTime = Date.now();

  console.log('[Step 1] 加载本地账本...');
  const ledger = new CommitmentLedger(resolve(__dirname, '..', config.ledger.path));
  ledger.load();
  console.log(`  ✓ 加载了 ${ledger.commitments.length} 条承诺`);
  console.log();

  console.log('[Step 2] 初始化卡片生成器...');
  const cardGen = new CardGenerator(ledger);
  console.log('  ✓ CardGenerator 就绪');
  console.log();

  console.log('[Step 3] 初始化飞书写入器...');
  const writer = new FeishuWriter();
  console.log(`  ✓ Bitable: ${writer.bitableAppToken ? '已配置' : '未配置'}`);
  console.log(`  ✓ Task: ${writer.taskId ? '已配置' : '未配置'}`);
  console.log();

  console.log('[Step 4] 初始化模型客户端...');
  const modelClient = new ModelClient();
  console.log('  ✓ ModelClient 就绪');
  console.log();

  console.log('[Step 5] 模拟从会议纪要中提取承诺...');
  const mockMeetingText = `
    产品规划会议 - 2026年4月26日

    张艺航：我负责Q2季度的产品路线图更新，下周三前完成初稿。

    李明：关于技术债务，我会和团队讨论，在4月底前给出清理计划。

    王芳：用户体验优化方案，我已经完成了第一版设计，本周五前给大家演示。

    陈总：希望大家在月底前能完成各自负责的模块开发。

    (会议结束)
  `;

  const extractedCommitments = [];
  const lines = mockMeetingText.split('\n').filter(l => l.trim());

  for (const line of lines) {
    if (line.includes('负责') && line.includes('完成')) {
      const title = line.replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s]/g, '').trim();
      const owner = line.includes('张艺航') ? '张艺航' :
                    line.includes('李明') ? '李明' :
                    line.includes('王芳') ? '王芳' :
                    line.includes('陈总') ? '陈总' : '未知';

      const deadlineMatch = line.match(/([下本]?[周月日])?[周](.+?)前/);
      let deadline = null;
      if (deadlineMatch) {
        const now = new Date();
        if (line.includes('下周三')) {
          const nextWed = new Date(now);
          nextWed.setDate(now.getDate() + (3 - now.getDay() + 7) % 7 || 7);
          deadline = nextWed.toISOString();
        } else if (line.includes('周五')) {
          const nextFri = new Date(now);
          nextFri.setDate(now.getDate() + (5 - now.getDay() + 7) % 7 || 7);
          deadline = nextFri.toISOString();
        } else if (line.includes('月底')) {
          const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
          deadline = endOfMonth.toISOString();
        }
      }

      extractedCommitments.push(createCommitment({
        title: title.substring(0, 50),
        owner,
        deadline,
        status: CommitmentStatus.PENDING,
        priority: line.includes('希望') ? Priority.P2 : Priority.P1,
        confidence: 'high',
        sourceType: SourceType.MEETING,
        isRisk: false
      }));
    }
  }

  console.log(`  ✓ 从会议纪要提取了 ${extractedCommitments.length} 条承诺`);
  for (const c of extractedCommitments) {
    console.log(`    - [${c.owner}] ${c.title} (${c.deadline ? '有期限' : '无期限'})`);
  }
  console.log();

  console.log('[Step 6] 添加证据链...');
  for (const c of extractedCommitments) {
    c.evidence.push(createEvidence({
      quote: mockMeetingText,
      source: 'meeting-minutes',
      speaker: c.owner,
      timestamp: new Date().toISOString()
    }));
  }
  console.log('  ✓ 证据链已添加');
  console.log();

  console.log('[Step 7] 添加承诺到账本...');
  for (const c of extractedCommitments) {
    const added = ledger.add(c);
    console.log(`  ✓ 添加: ${added.title}`);
  }
  ledger.save();
  console.log(`  ✓ 账本已保存，共 ${ledger.commitments.length} 条承诺`);
  console.log();

  console.log('[Step 8] 生成会后卡片...');
  const postMeetingCard = cardGen.generatePostMeetingCard(extractedCommitments, {
    title: '产品规划会议',
    time: '2026-04-26 10:00',
    participantCount: 4
  });
  console.log(`  ✓ 卡片标题: ${postMeetingCard.header.title.content}`);
  console.log(`  ✓ 卡片元素: ${postMeetingCard.elements.length} 个`);
  console.log();

  console.log('[Step 9] 生成晚间复盘卡片...');
  const stats = ledger.getStats();
  const eveningCard = cardGen.generateEveningReviewCard({
    date: '2026-04-26',
    pending: stats.pending,
    done: stats.done,
    overdue: stats.overdue,
    newCommitments: extractedCommitments.length
  });
  console.log(`  ✓ 卡片标题: ${eveningCard.header.title.content}`);
  console.log(`  ✓ 完成率: ${Math.round((stats.done / (stats.pending + stats.done || 1)) * 100)}%`);
  console.log();

  console.log('[Step 10] 生成临期提醒...');
  const dueSoon = ledger.getDueSoon(24 * 60);
  if (dueSoon.length > 0) {
    const reminderCard = cardGen.generateReminderCard(dueSoon[0]);
    console.log(`  ✓ 临期承诺: ${dueSoon[0].title}`);
    console.log(`  ✓ 提醒卡片: ${reminderCard.header.title.content}`);
  } else {
    console.log('  ✓ 暂无临期承诺');
  }
  console.log();

  const endTime = Date.now();
  const duration = ((endTime - startTime) / 1000).toFixed(2);

  console.log('='.repeat(60));
  console.log('端到端演示完成!');
  console.log('='.repeat(60));
  console.log();
  console.log('执行摘要:');
  console.log(`  • 承诺提取: ${extractedCommitments.length} 条`);
  console.log(`  • 账本总数: ${ledger.commitments.length} 条`);
  console.log(`  • 卡片生成: 3 张 (会后/晚间/临期)`);
  console.log(`  • 执行时间: ${duration}s`);
  console.log();
  console.log('下一步:');
  console.log('  1. node scripts/mock-full.js  - 运行完整测试');
  console.log('  2. node scripts/sync-skills.js - 同步到 OpenClaw Skills');
  console.log('  3. 配置实际飞书凭证后即可写入真实数据');
  console.log();
}

main().catch(err => {
  console.error('演示失败:', err.message);
  process.exit(1);
});
