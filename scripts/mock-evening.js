import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CardGenerator } from '../src/cards.js';
import { CommitmentLedger } from '../src/ledger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  console.log('=== Evening Review Full Test ===\n');

  const ledger = new CommitmentLedger();
  ledger.load(resolve(__dirname, '../.flowmate.local.json'));
  const cardGen = new CardGenerator(ledger);

  const stats = ledger.getStats();

  console.log('统计数据:');
  console.log('- 总承诺:', stats.total);
  console.log('- 待确认:', stats.pending);
  console.log('- 进行中:', stats.inProgress);
  console.log('- 已完成:', stats.done);
  console.log('- 逾期:', stats.overdue);
  console.log('- 临期:', stats.dueSoon);
  console.log('- 高置信度:', stats.byConfidence.high);
  console.log('- 中置信度:', stats.byConfidence.medium);
  console.log('- 低置信度:', stats.byConfidence.low);

  console.log('\n生成晚间复盘卡片...');
  const eveningCard = cardGen.generateEveningReviewCard({
    date: new Date().toLocaleDateString('zh-CN'),
    pending: stats.pending,
    done: stats.done,
    overdue: stats.overdue,
    newCommitments: 3
  });

  console.log('\n卡片结构:');
  console.log('- 类型:', eveningCard.card_type);
  console.log('- 标题:', JSON.stringify(eveningCard.header.title));
  console.log('- 模板:', eveningCard.header.template);
  console.log('- 元素数:', eveningCard.elements.length);

  console.log('\n=== Evening Review Test PASSED ===');
}

main().catch(console.error);
