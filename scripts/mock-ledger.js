import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CommitmentLedger } from '../src/ledger.js';
import { createCommitment, createEvidence } from '../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' FlowMate: Mock 账本测试');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const ledger = new CommitmentLedger();

  console.log('📖 加载本地账本...');
  ledger.load();

  const initialStats = ledger.getStats();
  console.log(`   当前账本: ${initialStats.total} 条承诺\n`);

  console.log('📝 添加新的承诺...');

  const c1 = createCommitment({
    title: '我今晚把 OpenClaw 接入说明补到 README',
    owner: '张三',
    deadlineText: '今晚',
    deadline: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
    priority: 'P1',
    status: 'pending',
    sourceType: 'meeting',
    sourceTitle: 'FlowMate 项目需求评审会议',
    sourceLink: 'https://example.feishu.cn/meeting/abc123',
    evidence: [createEvidence({
      quote: '我今晚把 OpenClaw 接入说明补到 README，明天上午前发 PR。',
      speaker: '张三',
      sourceType: 'meeting',
      sourceTitle: 'FlowMate 项目需求评审会议'
    })],
    confidence: 'high'
  });

  ledger.add(c1);
  console.log(`   添加: ${c1.title}`);

  const c2 = createCommitment({
    title: '会后我同步 Demo 脚本到 flowmate/examples 目录',
    owner: '李四',
    deadlineText: '会后',
    priority: 'P2',
    status: 'pending',
    sourceType: 'meeting',
    sourceTitle: 'FlowMate 项目需求评审会议',
    evidence: [createEvidence({
      quote: '会后我同步一下 Demo 脚本到 flowmate/examples 目录。',
      speaker: '李四',
      sourceType: 'meeting',
      sourceTitle: 'FlowMate 项目需求评审会议'
    })],
    confidence: 'medium'
  });

  ledger.add(c2);
  console.log(`   添加: ${c2.title}`);

  console.log('\n🔍 测试去重（添加相似承诺）...');

  const c3 = createCommitment({
    title: '我今晚把 OpenClaw 接入说明补到 README',
    owner: '张三',
    deadlineText: '今晚',
    evidence: [createEvidence({
      quote: '我今晚把 OpenClaw 接入说明补到 README',
      speaker: '张三',
      sourceType: 'meeting',
      sourceTitle: 'FlowMate 项目需求评审会议'
    })],
    confidence: 'high'
  });

  const added = ledger.add(c3);
  if (added === c1) {
    console.log('   ✅ 去重成功: 相似承诺被合并');
  } else {
    console.log('   ⚠️  未检测到重复');
  }

  console.log('\n✏️  更新承诺状态...');

  ledger.update(c1.id, { status: 'in_progress' });
  console.log(`   张三的承诺 -> in_progress`);

  ledger.update(c1.id, { riskReason: '网络问题，可能需要更多时间' });
  console.log(`   添加风险原因: ${c1.riskReason}`);

  console.log('\n📊 账本统计...');

  const stats = ledger.getStats();
  console.log(`   总承诺数: ${stats.total}`);
  console.log(`   pending: ${stats.pending} | confirmed: ${stats.confirmed} | in_progress: ${stats.inProgress} | blocked: ${stats.blocked} | done: ${stats.done}`);
  console.log(`   逾期: ${stats.overdue} | 临期(24h): ${stats.dueSoon} | 无截止时间: ${stats.noDeadline}`);
  console.log(`   置信度: high=${stats.byConfidence.high} | medium=${stats.byConfidence.medium} | low=${stats.byConfidence.low}`);

  console.log('\n💾 保存账本...');
  ledger.save();
  console.log(`   保存到: ${ledger.filePath}`);

  console.log('\n🔄 重新加载账本...');
  const reloaded = new CommitmentLedger().load();
  console.log(`   重新加载: ${reloaded.commitments.length} 条承诺`);

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(' ✅ Mock 账本测试完成');
  console.log('═══════════════════════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('❌ 错误:', err.message);
  process.exit(1);
});
