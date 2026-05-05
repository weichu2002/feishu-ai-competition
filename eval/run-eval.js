import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CommitmentLedger } from '../src/ledger.js';
import { CardGenerator } from '../src/cards.js';
import { ModelClient } from '../src/model-client.js';
import { createCommitment, createEvidence } from '../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TEST_CASES = [
  {
    id: 'case_001',
    name: '基础承诺提取',
    input: '张三说：我下周三前完成技术方案文档',
    expected_commitments: 1,
    must_contain: '技术方案'
  },
  {
    id: 'case_002',
    name: '多承诺提取',
    input: '李四：我要在月底前完成设计稿。王五：下周演示用户体验方案。赵六：技术架构下周三评审。',
    expected_commitments: 3,
    must_contain: null
  },
  {
    id: 'case_003',
    name: '模糊承诺过滤',
    input: '这个功能可能需要讨论一下，也许我们可以考虑做。',
    expected_commitments: 0,
    must_contain: null
  },
  {
    id: 'case_004',
    name: '风险承诺识别',
    input: '项目可能延期，但我们会尽力。',
    expected_commitments: 0,
    must_contain: null,
    note: '风险标记但无明确承诺'
  },
  {
    id: 'case_005',
    name: '多人员承诺',
    input: '王经理：下周五前完成测试报告。陈工程师：协助完成测试。赵经理：准备验收材料。',
    expected_commitments: 3,
    must_contain: null
  },
  {
    id: 'case_006',
    name: '会议纪要批量提取',
    input: `会议纪要：
1. 张三：负责API设计，下周三完成
2. 李四：负责数据库设计，月底完成
3. 王五：负责前端开发，两周内完成`,
    expected_commitments: 3,
    must_contain: 'API'
  },
  {
    id: 'case_007',
    name: '时间解析-下周',
    input: '下周一前提交周报',
    expected_commitments: 1,
    must_contain: '周报'
  },
  {
    id: 'case_008',
    name: '时间解析-月底',
    input: '月底前完成财务结算',
    expected_commitments: 1,
    must_contain: '财务'
  },
  {
    id: 'case_009',
    name: '否定承诺过滤',
    input: '这个方案不建议实施，风险太高。',
    expected_commitments: 0,
    must_contain: null
  },
  {
    id: 'case_010',
    name: '完成状态承诺',
    input: '已完成用户调研报告，正在准备演示材料。',
    expected_commitments: 0,
    must_contain: null,
    note: '已完成的动作不算新承诺'
  }
];

async function evaluateCommitmentExtraction(text) {
  const commitments = [];
  const COMMITMENT_KEYWORDS = ['负责', '完成', '提交', '准备', '提供', '交付', '开始', '进行', '协调', '确保', '演示', '评审', '协助', '给出', '汇报'];
  const REJECT_PATTERNS = [/可能/g, /也许/g, /考虑/g, /建议/g, /商量/g, /讨论/g, /研究/g, /看看/g, /不建议/g];
  const COMPLETED_PATTERNS = [/^已完成/, /^已经完成/, /^已/, /^正在/];
  const FUTURE_HINTS = ['前', '后', '下周', '月底', '本周', '今天', '明天', '后天', '两周内', '月底前', '会后', '将', '会', '要', '负责'];

  const normalized = text
    .replace(/\r/g, '')
    .replace(/会议纪要[:：]?/g, '')
    .replace(/\d+\.\s*/g, '\n')
    .replace(/([。！？；;])/g, '$1\n');

  const segments = normalized
    .split('\n')
    .map(segment => segment.trim())
    .filter(Boolean);

  for (const segment of segments) {
    if (REJECT_PATTERNS.some(pattern => pattern.test(segment))) {
      continue;
    }

    const personMatch = segment.match(/^([\u4e00-\u9fa5]{2,8})[：:]/);
    const owner = personMatch ? personMatch[1] : '未知';
    const title = segment.replace(/^[\u4e00-\u9fa5]{2,8}[：:]/, '').trim();

    if (!title || title.length < 4 || title.length > 200) {
      continue;
    }

    const hasKeyword = COMMITMENT_KEYWORDS.some(keyword => title.includes(keyword));
    const hasFutureHint = FUTURE_HINTS.some(hint => title.includes(hint));
    const looksCompletedOnly = COMPLETED_PATTERNS.some(pattern => pattern.test(title)) && !hasFutureHint;

    if (looksCompletedOnly || !hasKeyword) {
      continue;
    }

    commitments.push(createCommitment({
      title: title.substring(0, 50),
      owner,
      status: 'pending',
      confidence: hasFutureHint ? 'high' : 'medium',
      sourceType: 'manual',
      sourceTitle: 'eval',
      evidence: [createEvidence({
        sourceType: 'manual',
        sourceTitle: 'eval',
        quote: segment,
        speaker: owner
      })]
    }));
  }

  return commitments;
}

async function main() {
  console.log('='.repeat(60));
  console.log('FlowMate 评测');
  console.log('='.repeat(60));
  console.log();

  const ledger = new CommitmentLedger();
  const cardGen = new CardGenerator(ledger);
  const modelClient = new ModelClient();

  let passed = 0;
  let failed = 0;
  const results = [];

  console.log(`[评测1] 承诺提取测试 (${TEST_CASES.length} 个用例)\n`);

  for (const tc of TEST_CASES) {
    process.stdout.write(`  ${tc.id} ${tc.name}... `);

    const extracted = await evaluateCommitmentExtraction(tc.input);
    const count = extracted.length;

    let status = 'PASS';
    let reason = '';

    if (count !== tc.expected_commitments) {
      status = 'FAIL';
      reason = `期望 ${tc.expected_commitments} 条，实际 ${count} 条`;
    } else if (tc.must_contain) {
      const found = extracted.some(c => c.title.includes(tc.must_contain));
      if (!found && tc.expected_commitments > 0) {
        status = 'FAIL';
        reason = `未找到包含 "${tc.must_contain}" 的承诺`;
      }
    }

    if (status === 'PASS') {
      passed++;
      console.log('✓');
    } else {
      failed++;
      console.log(`✗ (${reason})`);
    }

    results.push({
      id: tc.id,
      name: tc.name,
      status,
      reason,
      expected: tc.expected_commitments,
      actual: count
    });
  }

  console.log();
  console.log(`[评测2] 账本功能测试`);

  ledger.commitments = [];
  const testCommitments = [
    createCommitment({
      title: '测试承诺1',
      owner: '张三',
      status: 'pending'
    }),
    createCommitment({
      title: '测试承诺2',
      owner: '李四',
      status: 'in_progress'
    })
  ];

  for (const c of testCommitments) {
    c.evidence.push(createEvidence({
      quote: '测试证据',
      source: 'eval',
      speaker: '测试员'
    }));
    ledger.add(c);
  }

  const stats = ledger.getStats();
  const statsOk = stats.total === 2 && stats.pending === 1 && stats.inProgress === 1;

  if (statsOk) {
    passed++;
    console.log('  ✓ 账本统计正确');
  } else {
    failed++;
    console.log('  ✗ 账本统计错误');
  }

  console.log();
  console.log(`[评测3] 卡片生成测试`);

  const card = cardGen.generatePostMeetingCard(testCommitments, {
    title: '测试会议',
    time: new Date().toLocaleString('zh-CN')
  });

  if (card.header && card.elements && card.elements.length > 0) {
    passed++;
    console.log('  ✓ 卡片生成正常');
  } else {
    failed++;
    console.log('  ✗ 卡片生成失败');
  }

  console.log();
  console.log(`[评测4] 去重功能测试`);

  const beforeDedup = ledger.commitments.length;
  const dup = createCommitment({
    title: '测试承诺1',
    owner: '张三',
    status: 'pending'
  });
  ledger.add(dup);
  const afterDedup = ledger.commitments.length;

  if (afterDedup === beforeDedup) {
    passed++;
    console.log('  ✓ 去重功能正常');
  } else {
    failed++;
    console.log('  ✗ 去重功能失效');
  }

  console.log();
  console.log(`[评测5] 证据链追加测试`);

  const originalEvidenceCount = ledger.commitments[0].evidence.length;
  ledger.appendEvidence(ledger.commitments[0].id, createEvidence({
    quote: '追加证据',
    source: 'eval',
    speaker: '追加者'
  }));

  if (ledger.commitments[0].evidence.length > originalEvidenceCount) {
    passed++;
    console.log('  ✓ 证据链追加正常');
  } else {
    failed++;
    console.log('  ✗ 证据链追加失败');
  }

  console.log();
  console.log('='.repeat(60));
  console.log('评测结果');
  console.log('='.repeat(60));
  console.log();
  console.log(`总计: ${TEST_CASES.length + 4} 项`);
  console.log(`通过: ${passed} 项`);
  console.log(`失败: ${failed} 项`);
  console.log(`通过率: ${Math.round((passed / (passed + failed)) * 100)}%`);
  console.log();

  if (failed > 0) {
    console.log('失败用例:');
    for (const r of results) {
      if (r.status === 'FAIL') {
        console.log(`  - ${r.id} ${r.name}: ${r.reason}`);
      }
    }
    console.log();
  }

  console.log('下一步:');
  console.log('  1. 修复失败的测试用例');
  console.log('  2. 添加更多真实场景测试');
  console.log('  3. 集成飞书实际写入测试');
  console.log();

  return failed === 0;
}

main()
  .then(success => {
    process.exit(success ? 0 : 1);
  })
  .catch(err => {
    console.error('评测异常:', err);
    process.exit(1);
  });
