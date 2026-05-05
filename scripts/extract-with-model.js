import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { modelClient } from '../src/model-client.js';
import { validateCommitment } from '../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' FlowMate: 模型承诺抽取');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const dataPath = resolve(__dirname, '..', 'examples', 'meeting-minutes.json');
  const outputPath = resolve(__dirname, '..', 'data', 'commitment_ledger.local.json');

  console.log(`📖 读取 mock 数据: ${dataPath}`);
  console.log(`🤖 模型: ${modelClient.getMaskedKey()}\n`);

  let utterances;
  try {
    const content = readFileSync(dataPath, 'utf-8');
    utterances = JSON.parse(content);
    console.log(`✅ 读取成功，共 ${utterances.length} 条发言\n`);
  } catch (err) {
    console.error(`❌ 读取失败: ${err.message}`);
    process.exit(1);
  }

  console.log('🔍 调用智谱 GLM-4.7 模型抽取承诺...\n');

  try {
    const commitments = await modelClient.extractCommitments(utterances);

    console.log(`✅ 模型抽取完成，共 ${commitments.length} 条承诺\n`);

    console.log('═══════════════════════════════════════════════════════════════');
    console.log(' 承诺列表');
    console.log('═══════════════════════════════════════════════════════════════\n');

    for (const c of commitments) {
      const validation = validateCommitment(c);
      const icon = c.confidence === 'high' ? '🟢' : c.confidence === 'medium' ? '🟡' : '🔴';
      console.log(`${icon} [${c.status}] ${c.title}`);
      console.log(`   负责人: ${c.owner} | 截止: ${c.deadlineText} | 置信度: ${c.confidence}`);
      if (c.riskReason) {
        console.log(`   风险: ${c.riskReason}`);
      }
      if (!validation.valid) {
        console.log(`   ⚠️  验证问题: ${validation.errors.join(', ')}`);
      }
      console.log();
    }

    const ledger = {
      version: '1.0.0',
      commitments: commitments,
      metadata: {
        createdAt: new Date().toISOString(),
        source: 'model-extract',
        model: modelClient.model,
        total: commitments.length,
        byConfidence: {
          high: commitments.filter(c => c.confidence === 'high').length,
          medium: commitments.filter(c => c.confidence === 'medium').length,
          low: commitments.filter(c => c.confidence === 'low').length
        },
        byStatus: {
          pending: commitments.filter(c => c.status === 'pending').length,
          confirmed: commitments.filter(c => c.status === 'confirmed').length,
          blocked: commitments.filter(c => c.status === 'blocked').length,
          done: commitments.filter(c => c.status === 'done').length
        }
      }
    };

    writeFileSync(outputPath, JSON.stringify(ledger, null, 2));
    console.log(`💾 账本已保存到: ${outputPath}`);

  } catch (err) {
    console.error(`\n❌ 抽取失败: ${err.message}`);
    console.error('\n可能的解决方案:');
    console.error('1. 检查 ZAI_API_KEY 是否正确');
    console.error('2. 检查网络连接');
    console.error('3. 检查模型配额\n');
    process.exit(1);
  }

  console.log('\n═══════════════════════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('❌ 错误:', err.message);
  process.exit(1);
});
