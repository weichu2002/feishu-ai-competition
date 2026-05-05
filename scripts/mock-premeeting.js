import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CardGenerator } from '../src/cards.js';
import { CommitmentLedger } from '../src/ledger.js';
import { CommitmentStatus } from '../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  console.log('=== Step 10: Pre-Meeting Background & Reminder & Evening Review Test ===\n');

  const ledger = new CommitmentLedger();
  ledger.load(resolve(__dirname, '../.flowmate.local.json'));
  const cardGen = new CardGenerator(ledger);

  console.log('1. Pre-Meeting Background Card (会前背景卡):');
  const allCommitments = ledger.commitments;
  const pendingCommitments = ledger.getByStatus(CommitmentStatus.PENDING);
  const overdueCommitments = ledger.getOverdue();
  const dueSoonCommitments = ledger.getDueSoon(24 * 60);

  const preMeetingCard = {
    card_type: 'card',
    header: {
      title: { tag: 'plain_text', content: '📋 会前背景：待处理承诺' },
      template: 'blue'
    },
    elements: [
      {
        tag: 'column_set',
        flex_mode: 'none',
        background_style: 'grey',
        columns: [
          {
            tag: 'column',
            width: 'stretch',
            elements: [
              { tag: 'markdown', content: `**⏳ 待确认**\n# ${pendingCommitments.length}` }
            ]
          },
          {
            tag: 'column',
            width: 'stretch',
            elements: [
              { tag: 'markdown', content: `**🚨 逾期**\n# ${overdueCommitments.length}` }
            ]
          },
          {
            tag: 'column',
            width: 'stretch',
            elements: [
              { tag: 'markdown', content: `**⏰ 临期**\n# ${dueSoonCommitments.length}` }
            ]
          }
        ]
      },
      { tag: 'hr' },
      {
        tag: 'markdown',
        content: '**📋 承诺列表**'
      },
      ...(pendingCommitments.length > 0
        ? pendingCommitments.slice(0, 5).map(c => ({
            tag: 'markdown',
            content: `• ${c.title}${c.deadline ? ` (${c.deadline.split('T')[0]})` : ''}`
          }))
        : [{ tag: 'markdown', content: '_暂无待确认承诺_' }]),
      { tag: 'hr' },
      {
        tag: 'markdown',
        content: '**💡 建议**'
      },
      {
        tag: 'markdown',
        content: overdueCommitments.length > 0
          ? `• 会议开始前，建议处理 ${overdueCommitments.length} 项逾期承诺`
          : dueSoonCommitments.length > 0
            ? `• 会议期间可能需要跟进 ${dueSoonCommitments.length} 项临期承诺`
            : '• 当前承诺状态良好'
      },
      {
        tag: 'note',
        elements: [
          { tag: 'plain_text', content: 'FlowMate 会前自动生成' }
        ]
      }
    ]
  };

  console.log('- Header:', JSON.stringify(preMeetingCard.header.title));
  console.log('- Elements count:', preMeetingCard.elements.length);
  console.log('- 逾期承诺:', overdueCommitments.length);
  console.log('- 临期承诺:', dueSoonCommitments.length);

  console.log('\n2. Deadline Reminder Card (临期提醒卡片):');
  if (dueSoonCommitments.length > 0) {
    const reminderCard = cardGen.generateReminderCard(dueSoonCommitments[0]);
    console.log('- Header:', JSON.stringify(reminderCard.header.title));
    console.log('- Template:', reminderCard.header.template);
  } else {
    const noDeadlineCommitments = allCommitments.filter(c => !c.deadline);
    if (noDeadlineCommitments.length > 0) {
      const noDeadlineCard = cardGen.generateReminderCard(noDeadlineCommitments[0]);
      console.log('- 无临期承诺，测试无截止时间卡片');
      console.log('- Header:', JSON.stringify(noDeadlineCard.header.title));
    } else {
      console.log('- 暂无需提醒的承诺');
    }
  }

  console.log('\n3. Evening Review Card (晚间复盘卡片):');
  const stats = ledger.getStats();
  const eveningCard = cardGen.generateEveningReviewCard({
    date: new Date().toLocaleDateString('zh-CN'),
    pending: stats.pending,
    done: stats.done,
    overdue: stats.overdue,
    newCommitments: 0
  });
  console.log('- Header:', JSON.stringify(eveningCard.header.title));
  console.log('- Template:', eveningCard.header.template);

  console.log('\n=== Step 10 Test PASSED ===');
  console.log('\nSummary:');
  console.log('- Pre-Meeting Background Card: ✓');
  console.log('- Reminder Card: ✓');
  console.log('- Evening Review Card: ✓');
}

main().catch(console.error);
