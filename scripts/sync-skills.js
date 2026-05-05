import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { copyFileSync, mkdirSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  console.log('=== Sync FlowMate Skill to OpenClaw ===\n');

  const sourceSkill = resolve(__dirname, '../skills/flowmate/SKILL.md');

  const possibleTargets = [
    resolve(__dirname, '../../openclaw-state/workspace/skills/flowmate/SKILL.md'),
    resolve(__dirname, '../../.openclaw/skills/flowmate/SKILL.md'),
    resolve(process.env.HOME || process.env.USERPROFILE, '.openclaw/skills/flowmate/SKILL.md'),
  ];

  console.log('Source:', sourceSkill);

  let synced = false;
  for (const target of possibleTargets) {
    const targetDir = dirname(target);
    if (!existsSync(targetDir)) {
      try {
        mkdirSync(targetDir, { recursive: true });
      } catch {
        continue;
      }
    }

    try {
      copyFileSync(sourceSkill, target);
      console.log('✓ Synced to:', target);
      synced = true;
      break;
    } catch {
      continue;
    }
  }

  if (!synced) {
    console.log('\n⚠ Could not sync to OpenClaw workspace.');
    console.log('Manual steps:');
    console.log('1. Copy skills/flowmate/SKILL.md to your OpenClaw workspace skills folder');
    console.log('2. Or run: openclaw skills install flowmate');
  }

  console.log('\nSkill file location:');
  console.log(sourceSkill);
  console.log('\nAfter syncing, restart OpenClaw Gateway to load the skill.');
}

main().catch(console.error);
