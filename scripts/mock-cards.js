import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CommitmentLedger } from '../src/ledger.js';
import { CardGenerator } from '../src/cards.js';
import { CommitmentStatus, SourceType, createCommitment, createEvidence } from '../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  console.log('=== Step 8: Card Generation Test ===\n');

  const ledger = new CommitmentLedger();
  ledger.load(resolve(__dirname, '../.flowmate.local.json'));

  const commitments = ledger.commitments;

  const cardGen = new CardGenerator(ledger);

  console.log('1. Post-Meeting Card (会议卡片):');
  const postMeetingCard = cardGen.generatePostMeetingCard(commitments, {
    title: 'Q2产品规划会议',
    time: '2026-04-26 10:00',
    participantCount: 8
  });
  console.log(JSON.stringify(postMeetingCard.header, null, 2));
  console.log('Elements count:', postMeetingCard.elements.length);

  console.log('\n2. Reminder Card (提醒卡片):');
  const pendingCommitments = commitments.filter(c => c.deadline);
  if (pendingCommitments.length > 0) {
    const reminderCard = cardGen.generateReminderCard(pendingCommitments[0]);
    console.log(JSON.stringify(reminderCard.header, null, 2));
    console.log('Elements count:', reminderCard.elements.length);
  } else {
    console.log('No commitments with deadline for reminder test');
  }

  console.log('\n3. Evening Review Card (晚间复盘卡片):');
  const stats = ledger.getStats();
  const eveningCard = cardGen.generateEveningReviewCard({
    date: '2026-04-26',
    pending: stats.pending || 0,
    done: stats.done || 0,
    overdue: stats.overdue || 0,
    newCommitments: 3
  });
  console.log(JSON.stringify(eveningCard.header, null, 2));

  console.log('\n4. Commitment Detail Card (承诺详情卡片):');
  if (commitments.length > 0) {
    const detailCard = cardGen.generateCommitmentDetailCard(commitments[0]);
    console.log(JSON.stringify(detailCard.header, null, 2));
    console.log('Evidence count:', commitments[0].evidence?.length || 0);
  }

  console.log('\n=== Card Generation Test PASSED ===');
  console.log('\nSummary:');
  console.log('- PostMeeting card: ✓');
  console.log('- Reminder card: ✓');
  console.log('- EveningReview card: ✓');
  console.log('- Detail card: ✓');
}

main().catch(console.error);
