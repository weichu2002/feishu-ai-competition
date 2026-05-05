import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { config } from '../src/config.js';
import { modelClient } from '../src/model-client.js';
import { FeishuWriter } from '../src/feishu-write.js';
import { larkCliJson } from '../src/lark-cli.js';
import { handleTeamCommand } from '../src/team-monitor.js';
import {
  CommitmentStatus,
  Confidence,
  Priority,
  SourceType,
  createCommitment,
  createEvidence,
  isDueSoon,
  isOverdue
} from '../src/types.js';
import {
  createMessageSearchAuthPrompt,
  getLarkAuthStatus,
  getMonitorGate,
  hasUserIdentity,
  isPendingAuthValid,
  isWatcherHealthy,
  loadAuthState,
  loadMonitorControl,
  loadWatcherStatus,
  personalMonitorPaths,
  saveAuthState,
  setMonitorDisabled,
  setMonitorEnabled,
  setMonitorPaused,
  startDeviceCodeCompletion
} from '../src/personal-monitor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workspaceDir = resolve(config.openclaw.stateDir);
const stateRootDir = resolve(workspaceDir, '..');
const workspaceStateDir = resolve(workspaceDir, 'state');
const latestExtractionPath = resolve(workspaceStateDir, 'flowmate-last-extraction.json');
const personalScanStatePath = resolve(workspaceStateDir, 'flowmate-personal-message-scan-state.json');
const latestOperationPath = resolve(workspaceStateDir, 'flowmate-last-operation.json');
const teamLatestOperationPath = resolve(workspaceStateDir, 'flowmate-team-last-operation.json');
const sessionStorePath = resolve(stateRootDir, 'agents', 'main', 'sessions', 'sessions.json');

let pendingManualAuthSession = null;

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    index += 1;
  }
  return args;
}

function ensureDir(dirPath) {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function readInputText(args) {
  if (args.input) {
    return readFileSync(resolve(args.input), 'utf8');
  }
  if (args.text) {
    return String(args.text);
  }
  if (args.stdin) {
    return readStdin();
  }
  return '';
}

function sanitizeVisibleReplyText(text) {
  if (!text) {
    return '';
  }

  return String(text)
    .replace(/\[\[reply_to_current\]\]/giu, '')
    .replace(/<\/arg_value>/giu, '')
    .replace(/\bNO_REPLY\b/giu, '')
    .replace(/\{"action"\s*:\s*"NO_REPLY"\s*\}/giu, '')
    .replace(/^\s*Note:\s*The previous agent run was aborted by the user\.[^\n]*\n*/gimu, '')
    .replace(/^\s*(说明|注意)[:：]\s*.*?(agent|运行).*?(中止|abort).*?\n*/gimu, '')
    .replace(/^\s*之前的\s*agent\s*运行被.*?\n*/gimu, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function tryReadJson(filePath, fallback = null) {
  if (!existsSync(filePath)) {
    return fallback;
  }

  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  ensureDir(dirname(filePath));
  writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function extractLatestUserTextFromSessionFile(sessionFile) {
  if (!sessionFile || !existsSync(sessionFile)) {
    return '';
  }

  const lines = readFileSync(sessionFile, 'utf8')
    .split(/\r?\n/u)
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const entry = JSON.parse(lines[index]);
      if (entry?.type !== 'message') {
        continue;
      }
      const message = entry.message;
      if (message?.role !== 'user' || !Array.isArray(message.content)) {
        continue;
      }
      const textParts = message.content
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text.trim())
        .filter(Boolean);
      if (textParts.length > 0) {
        return textParts.join('\n').trim();
      }
    } catch {
      // Ignore malformed lines.
    }
  }

  return '';
}

function unwrapOpenClawMessage(text) {
  if (!text) {
    return '';
  }

  const blockMatches = [
    ...text.matchAll(/\[message_id:[^\]]+\]\s*\n[^\n]+:\s*([\s\S]*?)(?=\n(?:\[message_id:|Conversation info|Sender \(|$))/gu)
  ];
  if (blockMatches.length > 0) {
    return blockMatches[blockMatches.length - 1][1].trim();
  }
  return text.trim();
}

function getLatestUserMessageText() {
  const store = tryReadJson(sessionStorePath, {});
  const sessionFile = store?.['agent:main:main']?.sessionFile;
  return unwrapOpenClawMessage(extractLatestUserTextFromSessionFile(sessionFile));
}

function loadWorkspaceUserProfile() {
  const userPath = resolve(workspaceDir, 'USER.md');
  const profile = {
    name: '',
    openId: ''
  };

  if (!existsSync(userPath)) {
    return profile;
  }

  const content = readFileSync(userPath, 'utf8');
  const openIdMatch = content.match(/ou_[A-Za-z0-9]+/u);
  if (openIdMatch) {
    profile.openId = openIdMatch[0];
  }

  const namePatterns = [
    /^\*\*(?:Name|名字|姓名|用户名字|用户名).+?\*\*:\s*(.+)$/gimu,
    /^\*\*.+?\*\*:\s*(.+)$/gimu
  ];

  for (const pattern of namePatterns) {
    const matches = [...content.matchAll(pattern)];
    for (const match of matches) {
      const candidate = String(match[1] || '')
        .trim()
        .replace(/^["“]|["”]$/gu, '');
      if (!candidate) {
        continue;
      }
      if (/ou_[A-Za-z0-9]+/u.test(candidate)) {
        continue;
      }
      if (/Asia\/|GMT|飞书 Open ID|Open ID|时区/u.test(candidate)) {
        continue;
      }
      profile.name = candidate;
      return profile;
    }
  }

  return profile;
}

function normalizeCommandText(text) {
  return String(text || '')
    .replace(/<at\b[^>]*><\/at>/giu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^@\S+\s*/u, '')
    .trim();
}

function stripCommitmentTarget(targetText) {
  return normalizeCommandText(
    String(targetText || '')
      .replace(/^(这条|这一条|刚刚那条|上一条|最新那条|该条)(承诺|事项|记录)?/u, '$1')
      .replace(/^(承诺|事项|记录)[:：]?\s*/u, '')
      .replace(/[。！!？?]$/u, '')
  );
}

function parseCommitmentOperation(text) {
  const normalized = normalizeCommandText(text);
  if (!normalized) {
    return null;
  }

  if (/^(撤回这条记录|撤回|撤销刚刚自动记录|撤销上一条|回滚刚才那条|撤销刚刚同步)$/u.test(normalized)) {
    return {
      action: 'undo-latest',
      reference: 'latest-automatic'
    };
  }

  if (/^(撤销刚刚自动记录|撤销刚刚同步|撤销上一条|撤销刚才那条|撤销最新那条|撤销这个记录|撤销这条记录|回滚刚刚那条)$/u.test(normalized)) {
    return {
      action: 'undo-latest',
      reference: 'latest-automatic'
    };
  }

  const deleteSuffixes = [
    '这个记录撤销',
    '这条记录撤销',
    '这个承诺撤销',
    '这条承诺撤销',
    '这个任务撤销',
    '这条任务撤销',
    '这个记录删除',
    '这条记录删除',
    '这个承诺删除',
    '这条承诺删除',
    '这个任务删除',
    '这条任务删除',
    '撤销',
    '删除',
    '删掉',
    '移除',
    '取消'
  ];
  for (const suffix of deleteSuffixes) {
    if (normalized.endsWith(suffix) && normalized.length > suffix.length) {
      const targetText = normalized
        .slice(0, -suffix.length)
        .replace(/^(请)?(帮我)?(把|将)/u, '')
        .trim();
      if (targetText && !/^(这个|这条|这一条|刚刚|刚才|上一条|最新)$/u.test(targetText)) {
        return {
          action: 'delete',
          targetText: stripCommitmentTarget(targetText)
        };
      }
    }
  }

  const deletePatterns = [
    /^(?:请)?(?:帮我)?(?:把|将)(.+?)(?:这个|这条|这一条)?(?:承诺|事项|记录|任务)?(?:撤销|删除|删掉|移除|取消)$/u,
    /^(?:请)?(?:帮我)?(?:撤销|删除|删掉|移除|取消)(?:这个|这条|这一条)?(?:承诺|事项|记录|任务)?[:：]?\s*(.+)$/u,
    /^(.+?)(?:这个|这条|这一条)?(?:承诺|事项|记录|任务)?(?:撤销|删除|删掉|移除|取消)$/u,
    /^(?:请)?(?:帮我)?(?:删除|删掉|移除)(?:这条|这一条|刚刚那条|上一条|最新那条)?(?:承诺|事项|记录)?[:：]?\s*(.*)$/u,
    /^(?:请)?(?:帮我)?把(.+?)(?:这条)?(?:承诺|事项|记录)?删除(?:掉)?$/u
  ];
  for (const pattern of deletePatterns) {
    const match = normalized.match(pattern);
    if (match) {
      return {
        action: 'delete',
        targetText: stripCommitmentTarget(match[1] || '')
      };
    }
  }

  const donePatterns = [
    /^(?:请)?(?:帮我)?把(.+?)(?:这条)?(?:承诺|事项|记录)?(?:标记为|设为|改成)?完成(?:了)?$/u,
    /^(?:请)?(?:帮我)?(?:将|把)?(.+?)(?:这条)?(?:承诺|事项|记录)?处理为完成$/u
  ];
  for (const pattern of donePatterns) {
    const match = normalized.match(pattern);
    if (match) {
      return {
        action: 'update',
        targetText: stripCommitmentTarget(match[1] || ''),
        updates: {
          status: CommitmentStatus.DONE
        }
      };
    }
  }

  const blockedPatterns = [
    /^(?:请)?(?:帮我)?把(.+?)(?:这条)?(?:承诺|事项|记录)?(?:标记为|设为|改成)?阻塞(?:了)?$/u,
    /^(?:请)?(?:帮我)?把(.+?)(?:这条)?(?:承诺|事项|记录)?设为卡住$/u
  ];
  for (const pattern of blockedPatterns) {
    const match = normalized.match(pattern);
    if (match) {
      return {
        action: 'update',
        targetText: stripCommitmentTarget(match[1] || ''),
        updates: {
          status: CommitmentStatus.BLOCKED
        }
      };
    }
  }

  const delayPatterns = [
    /^(?:请)?(?:帮我)?把(.+?)(?:这条)?(?:承诺|事项|记录)?(?:延期到|延后到|改到|截止时间改到)\s*(.+)$/u,
    /^(?:请)?(?:帮我)?(?:将|把)?(.+?)(?:这条)?(?:承诺|事项|记录)?(?:改期到|顺延到)\s*(.+)$/u
  ];
  for (const pattern of delayPatterns) {
    const match = normalized.match(pattern);
    if (match) {
      return {
        action: 'update',
        targetText: stripCommitmentTarget(match[1] || ''),
        updates: {
          deadlineText: normalizeCommandText(match[2] || '')
        }
      };
    }
  }

  return null;
}

function inferCommandFromText(text) {
  const normalized = normalizeCommandText(text);
  if (!normalized) {
    return '';
  }

  const commitmentOperation = parseCommitmentOperation(normalized);
  if (commitmentOperation?.action === 'undo-latest') {
    return 'undo-latest';
  }
  if (commitmentOperation) {
    return 'commitment-manage';
  }

  if (/(撤回这条记录|撤回|撤销刚刚自动记录|撤销上一条|回滚刚才那条|撤销刚刚同步)/u.test(normalized)) {
    return 'undo-latest';
  }
  if (/^(监听状态|自动监听状态|现在在监听吗|授权状态)$/u.test(normalized)) {
    return 'monitor-status';
  }
  if (/(关闭监听|停止监听|停止自动监听|别再监听|关闭自动监听)/u.test(normalized)) {
    return 'monitor-disable';
  }
  if (/(恢复监听|开启监听|打开监听|继续监听|重新开始监听)/u.test(normalized)) {
    return 'monitor-enable';
  }
  if (/(暂停监听|先别监听|稍后再监听)/u.test(normalized)) {
    return 'monitor-pause';
  }
  if (/(重新授权|重新登录|重新认证|授权监听)/u.test(normalized)) {
    return 'monitor-reauthorize';
  }
  if (/(创建|刷新|生成).*(视图)|视图.*(创建|刷新|生成)|ensure[- ]?views?/iu.test(normalized)) {
    return 'ensure-views';
  }
  if (/(创建|刷新|生成).*(仪表盘|dashboard)|dashboard/iu.test(normalized)) {
    return 'ensure-dashboard';
  }
  if (/(同步|回写|刷新).*(状态|进展).*(账本|表格)|sync.*status/iu.test(normalized)) {
    return 'sync-linked-statuses';
  }
  if (/^(团队状态|团队扫描状态|团队总表状态|team status)$/iu.test(normalized)) {
    return 'team-status';
  }
  if (/^(团队来源|团队来源列表|团队扫描来源|team sources?)$/iu.test(normalized)) {
    return 'team-source-list';
  }
  if (/^(加入团队扫描|将本群加入团队扫描|把这个群加入团队扫描|把本群加入团队扫描)$/iu.test(normalized)) {
    return 'team-source-add-current';
  }
  if (/^(移除团队扫描|将本群移除团队扫描|把这个群移除团队扫描|把本群移除团队扫描)$/iu.test(normalized)) {
    return 'team-source-remove-current';
  }
  if (/(扫描团队|团队扫描|团队群扫描|team scan)/iu.test(normalized)) {
    return 'team-scan-once';
  }
  if (/(团队预警|团队提醒|重点事项预警|team warn)/iu.test(normalized)) {
    return 'team-warn';
  }
  if (/(任务事件|事件订阅|事件回写|task events?|event subscrib|team subscribe)/iu.test(normalized)) {
    return 'team-subscribe-task-events';
  }
  if (/(团队驾驶舱|团队仪表盘|刷新团队指标|team dashboard)/iu.test(normalized)) {
    return 'team-dashboard-refresh';
  }
  if (/(团队(日报|周报|摘要|总结)|推进摘要|team digest)/iu.test(normalized)) {
    return 'team-digest';
  }
  if (/(团队知识问答|问团队知识|查团队知识|基于团队证据|team qa|knowledge qa)/iu.test(normalized)) {
    return 'team-knowledge-qa';
  }
  if (/(待确认负责人|未分派事项|未识别负责人|unassigned)/iu.test(normalized)) {
    return 'team-unassigned-list';
  }
  if (/^(团队成员|团队成员列表|成员映射|team members?)$/iu.test(normalized)) {
    return 'team-member-list';
  }
  if (/(团队.*(状态回写|同步状态|进展同步)|team sync)/iu.test(normalized)) {
    return 'team-sync-statuses';
  }
  if (/(提取.*同步|同步.*提取|整理.*同步)/u.test(normalized)) {
    return 'extract-and-sync';
  }
  if (/(同步到飞书|同步承诺|创建任务|记录到账本|创建日历提醒)/u.test(normalized)) {
    return 'sync-latest';
  }
  if (/(提取|整理).*(承诺|待办|action items|Action Items)|会后.*(承诺|待办|纪要|action items)/iu.test(normalized)) {
    return 'extract';
  }
  if (
    /(账本|统计|还有多少|临期|逾期|工作量)/u.test(normalized)
    || /(查看|查询|显示|列出|我的|当前|现在|还有多少|多少|哪些).*(待办|事项|承诺|任务|账本)/u.test(normalized)
    || /(待办|事项|承诺|任务|账本).*(查看|查询|显示|列出|还有多少|多少|哪些)/u.test(normalized)
  ) {
    return 'stats';
  }
  if (isLikelyPersonalCommitmentMessage(normalized)) {
    return 'auto';
  }
  return '';
}

function inferP2PMode(text) {
  const normalized = normalizeCommandText(text);
  if (!normalized) {
    return 'chat';
  }

  const explicitCommand = inferCommandFromText(normalized);
  if ([
    'commitment-manage',
    'monitor-status',
    'monitor-disable',
    'monitor-enable',
    'monitor-pause',
    'monitor-reauthorize',
    'undo-latest',
    'ensure-views',
    'ensure-dashboard',
    'sync-linked-statuses',
    'team-status',
    'team-source-list',
    'team-source-add-current',
    'team-source-remove-current',
    'team-scan-once',
    'team-warn',
    'team-subscribe-task-events',
    'team-digest',
    'team-knowledge-qa',
    'team-unassigned-list',
    'team-reassign',
    'team-dashboard-refresh',
    'team-member-list',
    'team-sync-statuses',
    'sync-latest',
    'extract',
    'extract-and-sync',
    'stats'
  ].includes(explicitCommand)) {
    return explicitCommand;
  }

  if (isLikelyPersonalCommitmentMessage(normalized)) {
    return 'auto';
  }

  return 'chat';
}

function isAutoIgnoreText(text) {
  return /^(收到|好的|好|ok|OK|thanks|thank you|谢谢|辛苦了|收到啦|明白了|知道了)[!！。？?]*$/u.test(
    normalizeCommandText(text)
  ) || /^(已自动识别并同步这条承诺|承诺处理已完成|FlowMate已完成本轮自动处理)/u.test(normalizeCommandText(text));
}

function normalizeLine(line) {
  return String(line || '')
    .trim()
    .replace(/^#{1,6}\s+/u, '')
    .replace(/^[>*\-\u2022]+\s*/u, '')
    .replace(/^\d+[.)、]\s*/u, '')
    .trim();
}

function shouldSkipLine(line) {
  if (/^#{1,6}\s+/u.test(String(line || '').trim())) {
    return true;
  }
  const normalized = normalizeLine(line);
  if (!normalized) {
    return true;
  }
  return [
    /^会议纪要[:：]?$/u,
    /^会后整理[:：]?$/u,
    /^今天会上定一个[:：]?$/u,
    /^今天会议定一个[:：]?$/u,
    /^请帮我(提取|整理|同步).*/u
  ].some((pattern) => pattern.test(normalized));
}

function buildUtterances(text, requesterName, sourceType, sourceTitle) {
  const lines = String(text || '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return [];
  }

  const utterances = [];
  for (const rawLine of lines) {
    if (shouldSkipLine(rawLine)) {
      continue;
    }

    const line = normalizeLine(rawLine);
    const speakerMatch = line.match(/^([\u4e00-\u9fffA-Za-z0-9·_-]{1,20})[:：]\s*(.+)$/u);
    const speaker = speakerMatch ? speakerMatch[1].trim() : requesterName;
    const content = speakerMatch ? speakerMatch[2].trim() : line;
    if (!content) {
      continue;
    }

    utterances.push({
      speaker: speaker || requesterName,
      text: content,
      sourceType,
      sourceTitle,
      timestamp: new Date().toISOString()
    });
  }

  if (utterances.length > 0) {
    return utterances;
  }

  return [
    {
      speaker: requesterName,
      text: String(text || '').trim(),
      sourceType,
      sourceTitle,
      timestamp: new Date().toISOString()
    }
  ];
}

function countMeaningfulLines(text) {
  return String(text || '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean).length;
}

function looksCompleted(text) {
  return /(已经|已)(.*)(完成|改完|做完|发完|搞定|处理完)|昨天已经做完了/u.test(text);
}

function stillHasFutureAction(text) {
  return /(发你|发给|补上|补完|确认|联系|同步|提交|整理|跟进|处理|安排|回复|推进)/u.test(text);
}

function isPotentialCommitment(text) {
  if (/^(已自动识别并同步这条承诺|承诺处理已完成|FlowMate已完成本轮自动处理)/u.test(text)) {
    return false;
  }
  const firstPerson = /(我(来|会|先|去|负责|今天|明天|今晚|后天|本周|下周|回头|稍后|尽快))/u;
  const action = /(发|补|整理|确认|联系|同步|提交|跟进|处理|安排|完成|更新|推进|拉齐|回复)/u;
  const deadline = /(今天|明天|后天|今晚|本周|下周|月底|上午|下午|会后|\d+\s*(分钟|小时|天))/u;
  const ownerLead = /^([\u4e00-\u9fffA-Za-z·]{2,12})(负责|今天|明天|后天|本周|下周|会|来|先|补|提交|同步|跟进|处理)/u;
  const englishCommitment = /\b(i|we)\s+(will|shall|can|need to|am going to|are going to)\b/i.test(text);
  const englishAction = /\b(finish|complete|send|submit|follow up|sync|update|deliver|handle|prepare)\b/i.test(text);
  const englishDeadline = /\b(today|tomorrow|tonight|this week|next week|by\s+\w+)/i.test(text);
  return (firstPerson.test(text) && (action.test(text) || deadline.test(text))) ||
    (deadline.test(text) && action.test(text)) ||
    ownerLead.test(text) ||
    (englishCommitment && (englishAction || englishDeadline));
}

function buildAutoCandidateUtterances(utterances) {
  return utterances.filter((utterance) => {
    const text = normalizeCommandText(utterance.text);
    if (!text || isAutoIgnoreText(text)) {
      return false;
    }
    if (looksCompleted(text) && !stillHasFutureAction(text)) {
      return false;
    }
    return isPotentialCommitment(text);
  });
}

function isLikelyPersonalCommitmentMessage(text) {
  const normalized = normalizeCommandText(text);
  if (!normalized) {
    return false;
  }

  const firstPersonMarkers = /(我(来|会|先|负责|这边|今晚|明天|今天|下周|下午|上午|稍后|回头|尽快|去))/u;
  const deadlineMarkers = /(今天|明天|后天|今晚|本周|下周|月底|下午|上午|会后|\d+\s*(分钟|小时|天))/u;
  const actionMarkers = /(补完|补上|整理|确认|联系|同步|提交|跟进|安排|处理|发你|发出来|回复|推进)/u;
  const metaDiscussionMarkers = /(方向|场景描述|产品|功能|方案|系统|链路|架构|能力|团队重点事项|推进总表|自动化入口|官方智能伙伴)/u;

  if (metaDiscussionMarkers.test(normalized) && !firstPersonMarkers.test(normalized)) {
    return false;
  }

  const lineCount = countMeaningfulLines(normalized);
  if (lineCount >= 5 && !firstPersonMarkers.test(normalized)) {
    return false;
  }

  return (
    (firstPersonMarkers.test(normalized) && (deadlineMarkers.test(normalized) || actionMarkers.test(normalized))) ||
    (deadlineMarkers.test(normalized) && actionMarkers.test(normalized))
  );
}

function extractDeadlineTextFromLine(text) {
  const patterns = [
    /明天上午\d{1,2}点半?/u,
    /明天下午\d{1,2}点半?/u,
    /今天上午\d{1,2}点半?/u,
    /今天下午\d{1,2}点半?/u,
    /今晚\d{1,2}点半?/u,
    /下周[一二三四五六日天](上午|下午)?\d{0,2}点?半?/u,
    /本周[一二三四五六日天](上午|下午)?\d{0,2}点?半?/u,
    /月底(前|之前)?/u,
    /今天(上午|下午|晚上)?/u,
    /明天(上午|下午|晚上)?/u,
    /后天(上午|下午|晚上)?/u,
    /今晚/u,
    /by tomorrow afternoon/iu,
    /tomorrow afternoon/iu,
    /by tomorrow morning/iu,
    /tomorrow morning/iu,
    /by tomorrow/iu,
    /tomorrow/iu,
    /today/iu,
    /会后/u,
    /\d+\s*(分钟|小时|天)(内|后)?/u,
    /(上午|下午|晚上)\d{1,2}点半?/u,
    /\d{1,2}:\d{2}/u
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match[0];
    }
  }

  return '';
}

function setTime(date, hours, minutes = 0, seconds = 0, milliseconds = 0) {
  const target = new Date(date);
  target.setHours(hours, minutes, seconds, milliseconds);
  return target;
}

function chineseNumberToInt(text) {
  const digitMap = {
    零: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9
  };

  if (/^\d+$/u.test(text)) {
    return Number(text);
  }
  if (text === '十') {
    return 10;
  }
  if (text.includes('十')) {
    const [tensText, onesText] = text.split('十');
    const tens = tensText ? (digitMap[tensText] || 0) : 1;
    const ones = onesText ? (digitMap[onesText] || 0) : 0;
    return tens * 10 + ones;
  }
  return digitMap[text] ?? null;
}

function getWeekdayDate(baseDate, weekday, nextWeek = false) {
  const currentWeekday = baseDate.getDay() === 0 ? 7 : baseDate.getDay();
  let offset = weekday - currentWeekday;
  if (nextWeek || offset < 0) {
    offset += 7;
  }
  const target = new Date(baseDate);
  target.setDate(baseDate.getDate() + offset);
  return target;
}

function parseRelativeDeadline(text) {
  if (!text) {
    return null;
  }

  const normalized = String(text).trim();
  const now = new Date();
  const weekdayMap = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    日: 7,
    天: 7
  };

  const relativeHours = normalized.match(/([零一二两三四五六七八九十\d]+)\s*小时(?:内|后)?/u);
  if (relativeHours) {
    const hours = chineseNumberToInt(relativeHours[1]);
    if (hours !== null) {
      return new Date(now.getTime() + hours * 60 * 60 * 1000).toISOString();
    }
  }

  const relativeDays = normalized.match(/([零一二两三四五六七八九十\d]+)\s*天(?:内|后)?/u);
  if (relativeDays) {
    const days = chineseNumberToInt(relativeDays[1]);
    if (days !== null) {
      return setTime(new Date(now.getTime() + days * 24 * 60 * 60 * 1000), 18).toISOString();
    }
  }

  const halfHour = normalized.includes('半');
  const minute = halfHour ? 30 : 0;
  const explicitTime = normalized.match(/(上午|下午|晚上)?\s*(\d{1,2})点(半)?/u);
  const clockTime = normalized.match(/(\d{1,2}):(\d{2})/u);

  const applyExplicitTime = (date, fallbackHour = 18) => {
    if (explicitTime) {
      let hour = Number(explicitTime[2]);
      const prefix = explicitTime[1] || '';
      if ((prefix === '下午' || prefix === '晚上') && hour < 12) {
        hour += 12;
      }
      return setTime(date, hour, explicitTime[3] ? 30 : 0).toISOString();
    }
    if (clockTime) {
      return setTime(date, Number(clockTime[1]), Number(clockTime[2])).toISOString();
    }
    return setTime(date, fallbackHour, minute).toISOString();
  };

  if (/今天上午/u.test(normalized)) {
    return applyExplicitTime(now, 10);
  }
  if (/今天下午/u.test(normalized)) {
    return applyExplicitTime(now, 17);
  }
  if (/今天晚上|今晚/u.test(normalized)) {
    return applyExplicitTime(now, 21);
  }
  if (/今天/u.test(normalized)) {
    return setTime(now, 23, 59, 59, 999).toISOString();
  }

  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  if (/tomorrow afternoon/i.test(normalized)) {
    return setTime(tomorrow, 17).toISOString();
  }
  if (/tomorrow morning/i.test(normalized)) {
    return setTime(tomorrow, 10).toISOString();
  }
  if (/tomorrow/i.test(normalized)) {
    return setTime(tomorrow, 18).toISOString();
  }
  if (/today/i.test(normalized)) {
    return setTime(now, 23, 59, 59, 999).toISOString();
  }
  if (/明天上午/u.test(normalized)) {
    return applyExplicitTime(tomorrow, 10);
  }
  if (/明天下午/u.test(normalized)) {
    return applyExplicitTime(tomorrow, 17);
  }
  if (/明天晚上/u.test(normalized)) {
    return applyExplicitTime(tomorrow, 21);
  }
  if (/明天/u.test(normalized)) {
    return applyExplicitTime(tomorrow, 18);
  }

  const dayAfterTomorrow = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
  if (/后天/u.test(normalized)) {
    return applyExplicitTime(dayAfterTomorrow, 18);
  }

  const thisWeekMatch = normalized.match(/本周([一二三四五六日天])/u);
  if (thisWeekMatch) {
    const target = getWeekdayDate(now, weekdayMap[thisWeekMatch[1]], false);
    return applyExplicitTime(target, 18);
  }

  const nextWeekMatch = normalized.match(/下周([一二三四五六日天])/u);
  if (nextWeekMatch) {
    const target = getWeekdayDate(now, weekdayMap[nextWeekMatch[1]], true);
    return applyExplicitTime(target, 18);
  }

  if (/月底/u.test(normalized)) {
    return setTime(new Date(now.getFullYear(), now.getMonth() + 1, 0), 18).toISOString();
  }

  if (/会后/u.test(normalized)) {
    return new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();
  }

  if (explicitTime) {
    return applyExplicitTime(now, 18);
  }
  if (clockTime) {
    return applyExplicitTime(now, 18);
  }

  return null;
}

function resolveOwnerFromText(text, speaker, requesterName) {
  if (/^(我|自己|本人)/u.test(text)) {
    return requesterName;
  }

  const responsibleOwner = text.match(/^([\u4e00-\u9fffA-Za-z·]{2,12})负责/u);
  if (responsibleOwner) {
    return responsibleOwner[1];
  }

  const explicitOwner = text.match(
    /^([\u4e00-\u9fffA-Za-z·]{2,12})(?=(今天|明天|后天|本周|下周|月底|会后|负责|先|会|来|补|提交|同步|跟进|处理))/u
  );
  if (explicitOwner) {
    return explicitOwner[1];
  }

  if (speaker && speaker !== '会议记录') {
    return speaker;
  }

  return requesterName;
}

function buildCommitmentTitle(text, owner, deadlineText, requesterName) {
  let title = String(text || '').trim().replace(/[。！!？?]$/u, '');
  title = title.replace(/^[\u4e00-\u9fffA-Za-z0-9·_\-\s]{1,40}[:：]\s*/u, '');
  if (owner && title.startsWith(owner)) {
    title = title.slice(owner.length).trim();
  }
  if (owner === requesterName && title.startsWith('我')) {
    title = title.slice(1).trim();
  }
  if (deadlineText) {
    title = title.replace(deadlineText, '').trim();
  }

  title = title
    .replace(/^(i|we)\s+(will|shall|can|need to|am going to|are going to)\s+/iu, '')
    .replace(/\bby\s+tomorrow\s+(morning|afternoon)?\b/iu, '')
    .replace(/\btomorrow\s+(morning|afternoon)?\b/iu, '')
    .replace(/^(来|先|负责|会|去|尽快)/u, '')
    .replace(/^(把|将)/u, '')
    .replace(/\s+/gu, ' ')
    .trim();

  return title;
}

function normalizeOwner(commitment, requesterName, requesterOpenId) {
  const owner = String(commitment.owner || '').trim();
  const aliases = new Set(['我', '自己', '本人', '当前用户', '待确认']);
  if (!owner || aliases.has(owner)) {
    const speaker = commitment.evidence?.[0]?.speaker || '';
    const resolvedOwner = speaker && speaker !== '会议记录' ? speaker : requesterName;
    return {
      ...commitment,
      owner: resolvedOwner,
      ownerOpenId: resolvedOwner === requesterName ? requesterOpenId : commitment.ownerOpenId || ''
    };
  }

  return {
    ...commitment,
    owner,
    ownerOpenId: owner === requesterName ? requesterOpenId : commitment.ownerOpenId || ''
  };
}

function normalizeOwnerAlias(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, '');
}

function loadTeamConfigForOwnerResolution() {
  return tryReadJson(resolve(workspaceStateDir, 'flowmate-team-config.json'), {});
}

function flattenTeamMembers(teamConfig) {
  const members = Array.isArray(teamConfig?.members) ? teamConfig.members : [];
  return members
    .map((member) => ({
      name: String(member.name || '').trim(),
      openId: String(member.openId || member.open_id || '').trim(),
      aliases: [
        member.name,
        member.openId,
        ...(Array.isArray(member.aliases) ? member.aliases : [])
      ].map(normalizeOwnerAlias).filter(Boolean)
    }))
    .filter((member) => member.name && member.openId);
}

async function searchUserOpenIdByName(owner) {
  const query = String(owner || '').trim();
  if (!query || query.length > 50) {
    return '';
  }

  try {
    const result = await larkCliJson([
      'contact',
      '+search-user',
      '--as',
      'user',
      '--query',
      query,
      '--has-chatted',
      '--page-size',
      '5',
      '--format',
      'json'
    ]);
    const users = Array.isArray(result?.data?.users)
      ? result.data.users
      : (Array.isArray(result?.users) ? result.users : []);
    const exact = users.find((user) => {
      const name = user?.name || user?.localized_name || user?.en_name || '';
      return normalizeOwnerAlias(name) === normalizeOwnerAlias(query);
    });
    const matched = exact || (users.length === 1 ? users[0] : null);
    return matched?.open_id || matched?.openId || matched?.user_id || '';
  } catch {
    return '';
  }
}

function buildDedupeKey(commitment) {
  const fingerprintText = [
    commitment.ownerOpenId || commitment.owner || '',
    commitment.title || '',
    commitment.deadlineText || commitment.deadline || ''
  ].map((part) => normalizeOwnerAlias(part)).join('|');

  return `team_${createHash('sha1').update(fingerprintText).digest('hex').slice(0, 20)}`;
}

async function enrichTeamCommitments(commitments, args = {}) {
  if (args['operation-scope'] !== 'team') {
    return commitments;
  }

  const teamConfig = loadTeamConfigForOwnerResolution();
  const members = flattenTeamMembers(teamConfig);
  const now = new Date().toISOString();

  const enriched = [];
  for (const commitment of commitments) {
    const ownerKey = normalizeOwnerAlias(commitment.owner);
    const mapped = members.find((member) => member.aliases.includes(ownerKey));
    const searchedOpenId = commitment.ownerOpenId || mapped?.openId || await searchUserOpenIdByName(commitment.owner);
    const ownerOpenId = searchedOpenId || commitment.ownerOpenId || '';
    const owner = mapped?.name || commitment.owner || '';
    const sourceToken = [
      commitment.sourceType || '',
      commitment.sourceTitle || '',
      commitment.sourceMessageId || '',
      commitment.sourceLink || ''
    ].filter(Boolean).join(' | ');

    enriched.push({
      ...commitment,
      owner,
      ownerOpenId,
      dedupeKey: commitment.dedupeKey || buildDedupeKey({ ...commitment, owner, ownerOpenId }),
      sourceCollection: commitment.sourceCollection || sourceToken,
      assignedAt: commitment.assignedAt || (ownerOpenId ? now : ''),
      lastSyncedAt: now
    });
  }

  return enriched;
}

function shouldTrackCommitment(commitment) {
  if (!commitment) {
    return false;
  }
  return commitment.status !== CommitmentStatus.DONE;
}

function buildHeuristicCommitments(utterances, requesterName, requesterOpenId, sourceType, sourceTitle) {
  const commitments = [];

  for (const utterance of utterances) {
    const text = normalizeCommandText(utterance.text);
    if (!text) {
      continue;
    }
    if (looksCompleted(text) && !stillHasFutureAction(text)) {
      continue;
    }
    if (!isPotentialCommitment(text)) {
      continue;
    }

    const deadlineText = extractDeadlineTextFromLine(text);
    const owner = resolveOwnerFromText(text, utterance.speaker, requesterName);
    const title = buildCommitmentTitle(text, owner, deadlineText, requesterName);
    if (!title) {
      continue;
    }

    const blocked = /(卡住|依赖|待确认|权限|风险|可能来不及|不确定|有阻塞)/u.test(text);
    const riskReason = blocked ? text : '';

    commitments.push(
      createCommitment({
        title,
        owner,
        ownerOpenId: owner === requesterName ? requesterOpenId : '',
        deadlineText,
        deadline: parseRelativeDeadline(deadlineText),
        priority: deadlineText ? Priority.P1 : Priority.P2,
        status: blocked ? CommitmentStatus.BLOCKED : CommitmentStatus.PENDING,
        sourceType,
        sourceTitle,
        evidence: [
          createEvidence({
            sourceType,
            sourceTitle,
            quote: text,
            speaker: utterance.speaker || owner,
            timestamp: utterance.timestamp || new Date().toISOString()
          })
        ],
        confidence: deadlineText || owner ? Confidence.HIGH : Confidence.MEDIUM,
        riskReason
      })
    );
  }

  return commitments;
}

function extractFirstJsonArray(text) {
  const trimmed = String(text || '').trim().replace(/^```json\s*/iu, '').replace(/^```\s*/iu, '').replace(/\s*```$/u, '');
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  return trimmed;
}

function normalizeStatus(status) {
  const value = String(status || '').trim().toLowerCase();
  if ([CommitmentStatus.PENDING, CommitmentStatus.CONFIRMED, CommitmentStatus.IN_PROGRESS, CommitmentStatus.BLOCKED, CommitmentStatus.DONE].includes(value)) {
    return value;
  }
  if (value === 'in progress') {
    return CommitmentStatus.IN_PROGRESS;
  }
  return CommitmentStatus.PENDING;
}

function normalizeConfidence(confidence) {
  const value = String(confidence || '').trim().toLowerCase();
  if ([Confidence.HIGH, Confidence.MEDIUM, Confidence.LOW].includes(value)) {
    return value;
  }
  return Confidence.MEDIUM;
}

async function extractCommitmentsWithModel(utterances, requesterName, requesterOpenId, sourceType, sourceTitle) {
  const systemPrompt = [
    '你是 FlowMate 的承诺提取助手。',
    '你的任务是从会议纪要、聊天记录或跟进消息里提取明确的个人承诺。',
    '只输出 JSON 数组，不要输出解释。',
    '每一项包含字段：title, owner, deadlineText, deadline, confidence, status, riskReason, evidence。',
    'evidence 必须包含 quote 和 speaker，quote 要尽量直接引用原文。',
    '如果没有承诺，返回 []。'
  ].join('\n');

  const prompt = [
    '请从以下发言中提取明确的承诺：',
    '',
    ...utterances.map((utterance, index) => `${index + 1}. [${utterance.speaker}] ${utterance.text}`)
  ].join('\n');

  const response = await modelClient.complete(prompt, systemPrompt);
  const jsonText = extractFirstJsonArray(response);
  const parsed = JSON.parse(jsonText);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .map((raw) => {
      const quote = String(raw?.evidence?.quote || raw?.quote || raw?.title || '').trim();
      const speaker = String(raw?.evidence?.speaker || raw?.speaker || raw?.owner || requesterName).trim();
      const owner = normalizeOwner(
        createCommitment({
          owner: String(raw?.owner || '').trim() || speaker,
          ownerOpenId: '',
          evidence: [createEvidence({ quote, speaker })]
        }),
        requesterName,
        requesterOpenId
      ).owner;
      const deadlineText = String(raw?.deadlineText || '').trim() || extractDeadlineTextFromLine(quote || raw?.title || '');
      const title = buildCommitmentTitle(String(raw?.title || quote || '').trim(), owner, deadlineText, requesterName);
      if (!title) {
        return null;
      }

      return createCommitment({
        title,
        owner,
        ownerOpenId: owner === requesterName ? requesterOpenId : '',
        deadlineText,
        deadline: raw?.deadline ? String(raw.deadline) : parseRelativeDeadline(deadlineText),
        priority: deadlineText ? Priority.P1 : Priority.P2,
        status: normalizeStatus(raw?.status),
        sourceType,
        sourceTitle,
        evidence: [
          createEvidence({
            sourceType,
            sourceTitle,
            quote: quote || title,
            speaker,
            timestamp: new Date().toISOString()
          })
        ],
        confidence: normalizeConfidence(raw?.confidence),
        riskReason: String(raw?.riskReason || '').trim()
      });
    })
    .filter(Boolean);
}

function buildCommitmentCache(commitments) {
  const seen = new Set();
  const deduped = [];

  for (const commitment of commitments) {
    const key = `${commitment.owner || ''}::${commitment.title || ''}::${commitment.deadlineText || ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push({
      ...commitment,
      updatedAt: new Date().toISOString()
    });
  }

  return deduped;
}

function summarizeCommitment(commitment) {
  return {
    id: commitment.id,
    title: commitment.title,
    owner: commitment.owner,
    ownerOpenId: commitment.ownerOpenId || '',
    deadlineText: commitment.deadlineText || '',
    status: commitment.status,
    confidence: commitment.confidence,
    dedupeKey: commitment.dedupeKey || ''
  };
}

function saveLatestExtraction(payload) {
  writeJson(latestExtractionPath, payload);
}

function getOperationPath(args = {}) {
  return args['operation-scope'] === 'team' ? teamLatestOperationPath : latestOperationPath;
}

function saveLatestOperation(payload, args = {}) {
  writeJson(getOperationPath(args), payload);
}

function buildSourceContextFromArgs(args, fallbackMessageText = '') {
  return {
    sourceLink: String(args['source-link'] || '').trim(),
    sourceMessageId: String(args['source-message-id'] || '').trim(),
    sourceChatId: String(args['source-chat-id'] || '').trim(),
    sourceThreadId: String(args['source-thread-id'] || '').trim(),
    rawMessageText: String(args['raw-message-text'] || fallbackMessageText || '').trim(),
    conversationSummary: String(args['conversation-summary'] || '').trim(),
    conversationContext: String(args['conversation-context'] || '').trim()
  };
}

function enrichCommitmentWithSourceContext(commitment, sourceContext = {}) {
  const normalizedEvidence = Array.isArray(commitment.evidence)
    ? commitment.evidence.map((evidence) => ({
      ...evidence,
      sourceLink: sourceContext.sourceLink || evidence.sourceLink || ''
    }))
    : [];

  return {
    ...commitment,
    sourceLink: sourceContext.sourceLink || commitment.sourceLink || '',
    sourceMessageId: sourceContext.sourceMessageId || commitment.sourceMessageId || '',
    sourceChatId: sourceContext.sourceChatId || commitment.sourceChatId || '',
    sourceThreadId: sourceContext.sourceThreadId || commitment.sourceThreadId || '',
    rawMessageText: sourceContext.rawMessageText || commitment.rawMessageText || commitment.evidence?.[0]?.quote || '',
    conversationSummary: sourceContext.conversationSummary || commitment.conversationSummary || '',
    conversationContext: sourceContext.conversationContext || commitment.conversationContext || '',
    evidence: normalizedEvidence
  };
}

function loadLatestOperation(args = {}) {
  const payload = tryReadJson(getOperationPath(args), null);
  if (!payload) {
    throw new Error('目前还没有可撤销的 FlowMate 自动操作。');
  }
  return payload;
}

function loadLatestExtraction() {
  const payload = tryReadJson(latestExtractionPath, null);
  if (!payload) {
    throw new Error('还没有可同步的承诺，请先执行一次提取。');
  }
  return payload;
}

function loadPersonalScanState() {
  const state = tryReadJson(personalScanStatePath, null);
  if (!state || typeof state !== 'object') {
    return {
      lastScanAt: '',
      processedMessageIds: []
    };
  }

  return {
    lastScanAt: typeof state.lastScanAt === 'string' ? state.lastScanAt : '',
    processedMessageIds: Array.isArray(state.processedMessageIds) ? state.processedMessageIds.filter((item) => typeof item === 'string') : []
  };
}

function savePersonalScanState(state) {
  writeJson(personalScanStatePath, state);
}

function toIsoDateTime(value) {
  if (!value) {
    return '';
  }
  if (typeof value === 'number') {
    const millis = value > 1e12 ? value : value * 1000;
    return new Date(millis).toISOString();
  }

  const text = String(value).trim();
  if (!text) {
    return '';
  }
  if (/^\d+$/u.test(text)) {
    const numeric = Number(text);
    const millis = numeric > 1e12 ? numeric : numeric * 1000;
    return new Date(millis).toISOString();
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }
  return parsed.toISOString();
}

function formatFeishuDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteMinutes = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absoluteMinutes / 60)).padStart(2, '0');
  const offsetRemainMinutes = String(absoluteMinutes % 60).padStart(2, '0');

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${sign}${offsetHours}:${offsetRemainMinutes}`;
}

function buildPersonalScanWindow(args, state) {
  const now = new Date();
  const lookbackMinutes = Number(args['lookback-minutes'] || 120);
  const overlapSeconds = Number(args['overlap-seconds'] || 180);

  if (args.start) {
    return {
      start: formatFeishuDateTime(toIsoDateTime(args.start) || new Date(now.getTime() - lookbackMinutes * 60 * 1000)),
      end: formatFeishuDateTime(args.end ? toIsoDateTime(args.end) || now : now)
    };
  }

  if (state.lastScanAt) {
    const lastScanTime = new Date(state.lastScanAt).getTime();
    if (!Number.isNaN(lastScanTime)) {
      return {
        start: formatFeishuDateTime(new Date(Math.max(0, lastScanTime - overlapSeconds * 1000))),
        end: formatFeishuDateTime(now)
      };
    }
  }

  return {
    start: formatFeishuDateTime(new Date(now.getTime() - lookbackMinutes * 60 * 1000)),
    end: formatFeishuDateTime(now)
  };
}

function normalizeMessageContent(raw) {
  if (!raw) {
    return '';
  }
  if (typeof raw === 'string') {
    return raw.trim();
  }
  if (typeof raw === 'object') {
    if (typeof raw.content === 'string') {
      return raw.content.trim();
    }
    if (typeof raw.text === 'string') {
      return raw.text.trim();
    }
    if (typeof raw.body?.text === 'string') {
      return raw.body.text.trim();
    }
    if (typeof raw.message?.content === 'string') {
      return raw.message.content.trim();
    }
  }
  return '';
}

function normalizeScannedMessages(result) {
  const rawMessages = result?.messages || result?.data?.messages || result?.data?.items || result?.items || [];
  if (!Array.isArray(rawMessages)) {
    return [];
  }

  return rawMessages
    .map((item) => {
      const messageId = item?.message_id || item?.messageId || item?.id || '';
      const senderOpenId = item?.sender?.id || item?.sender?.open_id || item?.sender_id || item?.senderOpenId || item?.from_id || '';
      const senderName = item?.sender?.name || item?.sender_name || item?.from_name || '';
      const content = normalizeMessageContent(item);
      const createTime = toIsoDateTime(item?.create_time || item?.createTime || item?.timestamp || item?.time);
      const chatId = item?.chat_id || item?.chatId || '';
      const chatName = item?.chat_name || item?.chatName || item?.chat_partner?.name || '';
      const chatType = item?.chat_type || item?.chatType || '';
      const threadId = item?.thread_id || item?.threadId || '';
      if (!messageId || !content) {
        return null;
      }
      return {
        messageId,
        senderOpenId,
        senderName,
        content,
        createTime,
        chatId,
        chatName,
        chatType,
        threadId
      };
    })
    .filter(Boolean);
}

async function searchPersonalMessages({ senderOpenId, start, end, pageSize, chatType }) {
  const args = [
    'im',
    '+messages-search',
    '--as',
    'user',
    '--sender',
    senderOpenId,
    '--start',
    start,
    '--end',
    end,
    '--page-size',
    String(pageSize || 50),
    '--page-all',
    '--format',
    'json'
  ];

  if (chatType) {
    args.push('--chat-type', chatType);
  }

  return normalizeScannedMessages(await larkCliJson(args));
}

function normalizeChatHistoryMessages(result) {
  const rawMessages = result?.messages || result?.data?.messages || result?.data?.items || result?.items || [];
  if (!Array.isArray(rawMessages)) {
    return [];
  }

  return rawMessages
    .map((item) => {
      const messageId = item?.message_id || item?.messageId || item?.id || '';
      const content = normalizeMessageContent(item);
      if (!messageId || !content) {
        return null;
      }

      return {
        messageId,
        senderOpenId: item?.sender?.id || item?.sender?.open_id || item?.sender_id || item?.senderOpenId || item?.from_id || '',
        senderName: item?.sender?.name || item?.sender_name || item?.from_name || '',
        content,
        createTime: toIsoDateTime(item?.create_time || item?.createTime || item?.timestamp || item?.time),
        chatId: item?.chat_id || item?.chatId || '',
        chatName: item?.chat_name || item?.chatName || item?.chat_partner?.name || '',
        chatType: item?.chat_type || item?.chatType || '',
        threadId: item?.thread_id || item?.threadId || ''
      };
    })
    .filter(Boolean);
}

async function listChatMessages({ chatId, start, end, pageSize = 50, sort = 'asc' }) {
  if (!chatId) {
    return [];
  }

  const result = await larkCliJson([
    'im',
    '+chat-messages-list',
    '--as',
    'user',
    '--chat-id',
    chatId,
    '--start',
    start,
    '--end',
    end,
    '--page-size',
    String(pageSize),
    '--sort',
    sort,
    '--format',
    'json'
  ]);

  return normalizeChatHistoryMessages(result);
}

function truncateInlineText(text, limit = 140) {
  const normalized = normalizeCommandText(text);
  if (!normalized) {
    return '';
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

function formatContextLine(message, targetMessageId = '') {
  const time = message?.createTime ? String(message.createTime).slice(11, 16) : '';
  const speaker = message?.senderName || message?.senderOpenId || 'unknown';
  const prefix = message?.messageId === targetMessageId ? '>>' : '-';
  const parts = [prefix];
  if (time) {
    parts.push(`[${time}]`);
  }
  parts.push(`${speaker}: ${truncateInlineText(message?.content || '', 180)}`);
  return parts.join(' ');
}

function buildSourceLink(message) {
  if (message?.chatId && message?.messageId) {
    return `chat:${message.chatId}#message:${message.messageId}`;
  }
  if (message?.messageId) {
    return `message:${message.messageId}`;
  }
  return '';
}

function buildConversationSummary(message, before = [], after = []) {
  const chatLabel = message?.chatName || message?.chatId || 'unknown-chat';
  const threadLabel = message?.threadId ? `thread ${message.threadId}` : 'no-thread';
  return `${chatLabel} | ${message?.chatType || 'unknown'} | before ${before.length} / after ${after.length} | ${threadLabel}`;
}

function buildConversationContextText(message, before = [], after = []) {
  const lines = [
    `目标消息ID: ${message?.messageId || ''}`,
    `聊天ID: ${message?.chatId || ''}`,
    `话题ID: ${message?.threadId || ''}`,
    `消息时间: ${message?.createTime || ''}`,
    `聊天名称: ${message?.chatName || ''}`,
    '',
    '前文:',
    ...(before.length > 0 ? before.map((item) => formatContextLine(item, message?.messageId)) : ['- 无']),
    '',
    '目标消息:',
    formatContextLine(message, message?.messageId),
    '',
    '后文:',
    ...(after.length > 0 ? after.map((item) => formatContextLine(item, message?.messageId)) : ['- 无'])
  ];

  return lines.join('\n').trim();
}

async function buildMessageContextBundle(message, { radius = 5, pageSize = 50 } = {}) {
  const fallback = {
    sourceLink: buildSourceLink(message),
    conversationSummary: buildConversationSummary(message, [], []),
    conversationContext: buildConversationContextText(message, [], []),
    rawMessageText: message?.content || '',
    sourceMessageId: message?.messageId || '',
    sourceChatId: message?.chatId || '',
    sourceThreadId: message?.threadId || ''
  };

  if (!message?.chatId || !message?.createTime) {
    return fallback;
  }

  const messageTime = new Date(message.createTime);
  if (Number.isNaN(messageTime.getTime())) {
    return fallback;
  }

  try {
    const history = await listChatMessages({
      chatId: message.chatId,
      start: formatFeishuDateTime(new Date(messageTime.getTime() - 3 * 60 * 60 * 1000)),
      end: formatFeishuDateTime(new Date(messageTime.getTime() + 3 * 60 * 60 * 1000)),
      pageSize,
      sort: 'asc'
    });

    if (history.length === 0) {
      return fallback;
    }

    let targetIndex = history.findIndex((item) => item.messageId === message.messageId);
    if (targetIndex < 0) {
      targetIndex = history.findIndex((item) => item.content === message.content && item.createTime === message.createTime);
    }
    if (targetIndex < 0) {
      return fallback;
    }

    const before = history.slice(Math.max(0, targetIndex - radius), targetIndex);
    const after = history.slice(targetIndex + 1, targetIndex + 1 + radius);

    return {
      ...fallback,
      conversationSummary: buildConversationSummary(message, before, after),
      conversationContext: buildConversationContextText(message, before, after)
    };
  } catch {
    return fallback;
  }
}

function buildMessageSourceTitle(message) {
  if (message.chatName) {
    return `飞书聊天：${message.chatName}`;
  }
  if (message.chatId) {
    return `飞书聊天：${message.chatId}`;
  }
  return '飞书聊天';
}

function buildTrimmedProcessedIds(ids, limit = 500) {
  return ids.slice(Math.max(0, ids.length - limit));
}

function parsePauseMinutes(text) {
  const normalized = normalizeCommandText(text);
  const hourMatch = normalized.match(/(\d+)\s*(小时|h|hour)/iu);
  if (hourMatch) {
    return Number(hourMatch[1]) * 60;
  }

  const minuteMatch = normalized.match(/(\d+)\s*(分钟|m|min)/iu);
  if (minuteMatch) {
    return Number(minuteMatch[1]);
  }

  if (/今晚/u.test(normalized) && /再监听|恢复/u.test(normalized)) {
    const now = new Date();
    const target = new Date(now);
    target.setHours(19, 0, 0, 0);
    return Math.max(30, Math.round((target.getTime() - now.getTime()) / 60000));
  }

  return 120;
}

function summarizeMonitorControl(control) {
  if (!control.enabled) {
    return 'disabled';
  }
  if (control.pausedUntil) {
    const pausedUntil = new Date(control.pausedUntil);
    if (Number.isFinite(pausedUntil.getTime()) && pausedUntil.getTime() > Date.now()) {
      return 'paused';
    }
  }
  return 'enabled';
}

async function triggerReauthorizationPrompt({ notifyUser = false } = {}) {
  const prompt = await createMessageSearchAuthPrompt();
  const expiresAt = new Date(Date.now() + Number(prompt.expires_in || 600) * 1000).toISOString();
  const authState = {
    status: 'waiting_authorization',
    startedAt: new Date().toISOString(),
    expiresAt,
    verificationUrl: prompt.verification_url || '',
    deviceCode: prompt.device_code || '',
    requestedBy: 'assistant-entry'
  };

  pendingManualAuthSession = authState;
  saveAuthState(authState);

  if (authState.deviceCode) {
    startDeviceCodeCompletion(authState.deviceCode, (completion) => {
      if (pendingManualAuthSession?.deviceCode === authState.deviceCode) {
        pendingManualAuthSession = {
          ...pendingManualAuthSession,
          completionClosedAt: completion.closedAt,
          completionExitCode: completion.exitCode,
          completionError: completion.error
        };
        saveAuthState(pendingManualAuthSession);
      }
    });
  }

  if (notifyUser) {
    const profile = loadWorkspaceUserProfile();
    if (profile.openId) {
      const writer = new FeishuWriter();
      await writer.sendBotMessage(
        profile.openId,
        ['FlowMate 需要重新授权个人消息搜索权限。', '授权完成后，自动监听会自己恢复。', '', `授权链接：${authState.verificationUrl}`].join('\n')
      );
    }
  }

  return {
    ok: true,
    authorizationRequired: true,
    verificationUrl: authState.verificationUrl,
    expiresAt: authState.expiresAt
  };
}

function buildScanNotificationMessage(summary) {
  const lines = [
    'FlowMate 已完成本轮自动处理：',
    `- 扫描新消息：${summary.newMessageCount} 条`,
    `- 识别承诺：${summary.autoTriggeredCount} 条`,
    `- 已写入承诺账本：${summary.syncedCount} 条`,
    `- 已创建任务：${summary.taskCreatedCount} 条`,
    `- 已创建日历提醒：${summary.calendarCreatedCount} 条`
  ];

  if (summary.commitmentTitles.length > 0) {
    lines.push('', '本轮事项：');
    for (const title of summary.commitmentTitles) {
      lines.push(`- ${title}`);
    }
  }

  return lines.join('\n');
}

function buildStatsFromCommitments(commitments) {
  return {
    total: commitments.length,
    pending: commitments.filter((item) => item.status === CommitmentStatus.PENDING).length,
    confirmed: commitments.filter((item) => item.status === CommitmentStatus.CONFIRMED).length,
    inProgress: commitments.filter((item) => item.status === CommitmentStatus.IN_PROGRESS).length,
    blocked: commitments.filter((item) => item.status === CommitmentStatus.BLOCKED).length,
    done: commitments.filter((item) => item.status === CommitmentStatus.DONE).length,
    overdue: commitments.filter((item) => isOverdue(item)).length,
    dueSoon: commitments.filter((item) => isDueSoon(item, 24)).length,
    noDeadline: commitments.filter((item) => !item.deadline).length,
    byConfidence: {
      high: commitments.filter((item) => item.confidence === Confidence.HIGH).length,
      medium: commitments.filter((item) => item.confidence === Confidence.MEDIUM).length,
      low: commitments.filter((item) => item.confidence === Confidence.LOW).length
    }
  };
}

function summarizeSyncState(sync) {
  const results = Array.isArray(sync?.results) ? sync.results : [];
  if (results.length === 0) {
    return Number(sync?.total || 0) === 0 ? 'skipped' : 'failed';
  }

  const persistedCount = results.filter((item) => item.bitable?.ok || item.task?.ok || item.calendar?.ok).length;
  if (persistedCount === 0) {
    return 'failed';
  }
  if (persistedCount === results.length) {
    return 'synced';
  }
  return 'partial';
}

function formatExecutionError(error) {
  const parts = [error?.message || String(error)];
  const stderr = String(error?.stderr || '').trim();
  const stdout = String(error?.stdout || '').trim();
  if (stderr) {
    parts.push(`stderr=${stderr.slice(0, 800)}`);
  }
  if (stdout) {
    parts.push(`stdout=${stdout.slice(0, 800)}`);
  }
  return parts.join(' | ');
}

function applyOperationScopeToWriter(writer, args = {}) {
  if (args['operation-scope'] === 'team') {
    const teamConfig = tryReadJson(resolve(workspaceStateDir, 'flowmate-team-config.json'), {});
    if (teamConfig?.tableId) {
      writer.bitableTableId = teamConfig.tableId;
      writer.schemaProfile = null;
      writer.ensuredLedgerFields = false;
    }
  }
  return writer;
}

async function syncCommitments(commitments, args = {}) {
  const writer = new FeishuWriter();
  applyOperationScopeToWriter(writer, args);
  const results = [];

  for (const commitment of commitments) {
    const result = {
      id: commitment.id,
      title: commitment.title,
      bitable: {
        ok: false,
        error: null,
        recordId: '',
        existed: false
      },
      task: {
        ok: false,
        error: null,
        taskId: '',
        skipped: false
      },
      calendar: {
        ok: false,
        error: null,
        eventId: '',
        calendarId: '',
        skipped: true
      }
    };

    try {
      const bitableResult = await writer.syncCommitmentToBitable(commitment);
      result.bitable.ok = true;
      result.bitable.recordId = bitableResult.recordId || '';
      result.bitable.existed = Boolean(bitableResult.existed);
      if (result.bitable.recordId) {
        commitment.bitableRecordId = result.bitable.recordId;
      }
      if (!commitment.feishuTaskId && bitableResult.taskId) {
        commitment.feishuTaskId = bitableResult.taskId;
      }
    } catch (error) {
      result.bitable.error = formatExecutionError(error);
    }

    try {
      const taskResult = await writer.syncCommitmentsToTask(commitment);
      result.task.ok = true;
      result.task.taskId = taskResult.taskId || '';
      result.task.skipped = Boolean(taskResult.skipped);
      if (result.task.taskId) {
        commitment.feishuTaskId = result.task.taskId;
        if (commitment.bitableRecordId) {
          try {
            await writer.updateCommitmentInBitable(commitment.bitableRecordId, commitment);
          } catch {
            // Best effort only.
          }
        }
      }
    } catch (error) {
      result.task.error = formatExecutionError(error);
    }

    try {
      const calendarResult = await writer.ensureCalendarReminder(commitment);
      result.calendar.ok = true;
      result.calendar.eventId = calendarResult.eventId || '';
      result.calendar.calendarId = calendarResult.calendarId || '';
      result.calendar.skipped = Boolean(calendarResult.skipped);
      if (result.calendar.eventId) {
        commitment.calendarEventId = result.calendar.eventId;
      }
      if (result.calendar.calendarId) {
        commitment.calendarId = result.calendar.calendarId;
      }
      if (commitment.bitableRecordId && (commitment.calendarEventId || commitment.calendarId)) {
        try {
          await writer.updateCommitmentInBitable(commitment.bitableRecordId, commitment);
        } catch {
          // Best effort only.
        }
      }
    } catch (error) {
      result.calendar.error = formatExecutionError(error);
      result.calendar.skipped = false;
    }

    results.push(result);
  }

  return {
    ok: true,
    total: commitments.length,
    bitableSuccessCount: results.filter((item) => item.bitable.ok).length,
    taskSuccessCount: results.filter((item) => item.task.ok && !item.task.skipped).length,
    calendarSuccessCount: results.filter((item) => item.calendar.ok && !item.calendar.skipped).length,
    results
  };
}

function buildOperationPayload({ trigger = 'manual', sourceTitle = '', messageId = '', sync = null, commitments = [] } = {}) {
  const items = [];
  const syncResults = Array.isArray(sync?.results) ? sync.results : [];

  for (const syncResult of syncResults) {
    const commitment = commitments.find((item) => item.id === syncResult.id) || {};
    items.push({
      id: syncResult.id,
      title: syncResult.title,
      bitableRecordId: syncResult.bitable?.recordId || '',
      bitableCreated: Boolean(syncResult.bitable?.ok && !syncResult.bitable?.existed),
      taskId: syncResult.task?.taskId || '',
      taskCreated: Boolean(syncResult.task?.ok && !syncResult.task?.skipped),
      calendarEventId: syncResult.calendar?.eventId || '',
      calendarCalendarId: syncResult.calendar?.calendarId || '',
      calendarCreated: Boolean(syncResult.calendar?.ok && !syncResult.calendar?.skipped),
      owner: commitment.owner || '',
      deadline: commitment.deadline || '',
      sourceMessageId: commitment.sourceMessageId || '',
      sourceChatId: commitment.sourceChatId || '',
      sourceThreadId: commitment.sourceThreadId || ''
    });
  }

  return {
    savedAt: new Date().toISOString(),
    trigger,
    sourceTitle,
    messageId,
    items
  };
}

async function handleExtract(args, { syncAfter = false } = {}) {
  const profile = loadWorkspaceUserProfile();
  const requesterName = args['requester-name'] || profile.name || '当前用户';
  const requesterOpenId = args['requester-openid'] || profile.openId || '';
  const sourceType = args['source-type'] || SourceType.MEETING;
  const sourceTitle = args['source-title'] || '会议整理';
  const text = String(readInputText(args).trim() || getLatestUserMessageText()).trim();

  if (!text) {
    throw new Error('没有收到可分析的内容。');
  }

  const utterances = buildUtterances(text, requesterName, sourceType, sourceTitle);
  let extracted = buildHeuristicCommitments(utterances, requesterName, requesterOpenId, sourceType, sourceTitle);

  if (extracted.length === 0) {
    try {
      extracted = await Promise.race([
        extractCommitmentsWithModel(utterances, requesterName, requesterOpenId, sourceType, sourceTitle),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('model_timeout')), 45000);
        })
      ]);
    } catch {
      extracted = [];
    }
  }

  const sourceContext = buildSourceContextFromArgs(args, text);
  let trackable = buildCommitmentCache(
    extracted
      .filter(shouldTrackCommitment)
      .map((commitment) => normalizeOwner(commitment, requesterName, requesterOpenId))
      .map((commitment) => enrichCommitmentWithSourceContext(commitment, sourceContext))
  );
  trackable = await enrichTeamCommitments(trackable, args);

  const cachePayload = {
    extractedAt: new Date().toISOString(),
    requesterName,
    requesterOpenId,
    sourceType,
    sourceTitle,
    storageMode: 'cache-only',
    commitments: trackable
  };
  saveLatestExtraction(cachePayload);

  const response = {
    ok: true,
    action: syncAfter ? 'extract-and-sync' : 'extract',
    requesterName,
    sourceType,
    sourceTitle,
    extractedCount: trackable.length,
    commitments: trackable.map(summarizeCommitment),
    storageMode: 'cache-only',
    syncState: syncAfter ? 'syncing' : 'not_synced',
    userFacingHint: syncAfter ? '已提取承诺，正在同步到飞书。' : '已提取并缓存本轮承诺，尚未同步到飞书。',
    latestExtractionPath
  };

  if (syncAfter) {
    response.sync = await syncCommitments(trackable, args);
    response.syncState = summarizeSyncState(response.sync);
    response.userFacingHint =
      response.extractedCount === 0
        ? '这轮没有识别到需要同步的新承诺。'
        : response.syncState === 'synced'
          ? '已提取承诺并同步到飞书。'
          : response.syncState === 'partial'
            ? '承诺已提取，但只有一部分同步到了飞书。'
            : '承诺已提取，但同步到飞书失败了。';

    saveLatestOperation(
      buildOperationPayload({
        trigger: 'extract-and-sync',
        sourceTitle,
        sync: response.sync,
        commitments: trackable
      }),
      args
    );

    cachePayload.syncedAt = new Date().toISOString();
    cachePayload.sync = response.sync;
    saveLatestExtraction(cachePayload);
  }

  return response;
}

async function handleAuto(args) {
  const profile = loadWorkspaceUserProfile();
  const requesterName = args['requester-name'] || profile.name || '当前用户';
  const requesterOpenId = args['requester-openid'] || profile.openId || '';
  const sourceType = args['source-type'] || SourceType.CHAT;
  const sourceTitle = args['source-title'] || '飞书自动监听';
  const text = normalizeCommandText(readInputText(args).trim() || getLatestUserMessageText());

  if (!text) {
    throw new Error('没有收到可分析的飞书消息。');
  }

  const inferredCommand = inferCommandFromText(text);
  if (inferredCommand && inferredCommand !== 'auto') {
    const delegatedArgs = {
      ...args,
      text,
      'requester-name': requesterName,
      'requester-openid': requesterOpenId,
      'source-type': sourceType,
      'source-title': sourceTitle
    };

    if (inferredCommand === 'monitor-disable') return handleMonitorDisable(delegatedArgs);
    if (inferredCommand === 'monitor-enable') return handleMonitorEnable(delegatedArgs);
    if (inferredCommand === 'monitor-pause') return handleMonitorPause(delegatedArgs);
    if (inferredCommand === 'monitor-status') return handleMonitorStatus();
    if (inferredCommand === 'monitor-reauthorize') return handleMonitorReauthorize(delegatedArgs);
    if (inferredCommand === 'commitment-manage') return handleCommitmentManage(delegatedArgs);
    if (inferredCommand === 'undo-latest') return handleUndoLatest(delegatedArgs);
    if (inferredCommand === 'ensure-views') return handleEnsureViews();
    if (inferredCommand === 'ensure-dashboard') return handleEnsureDashboard();
    if (inferredCommand === 'sync-linked-statuses') return handleSyncLinkedStatuses();
    if (inferredCommand.startsWith('team-')) return handleTeamCommand(inferredCommand, delegatedArgs);
    if (inferredCommand === 'stats') return handleStats();
    if (inferredCommand === 'sync-latest') return handleSyncLatest();
    if (inferredCommand === 'extract') return handleExtract(delegatedArgs);
    if (inferredCommand === 'extract-and-sync') return handleExtract(delegatedArgs, { syncAfter: true });
  }

  if (isAutoIgnoreText(text)) {
    return {
      ok: true,
      action: 'auto',
      autoTriggered: false,
      sourceType,
      sourceTitle,
      storageMode: 'cache-only',
      syncState: 'skipped',
      detectedCount: 0,
      userFacingHint: '这条消息更像确认或简短回复，我先不入账。'
    };
  }

  const utterances = buildUtterances(text, requesterName, sourceType, sourceTitle);
  const candidates = buildAutoCandidateUtterances(utterances);
  if (candidates.length === 0) {
    return {
      ok: true,
      action: 'auto',
      autoTriggered: false,
      sourceType,
      sourceTitle,
      storageMode: 'cache-only',
      syncState: 'skipped',
      detectedCount: 0,
      userFacingHint: '这条消息里暂时没有识别到需要登记的新承诺。'
    };
  }

  const extractResult = await handleExtract(
    {
      ...args,
      text,
      'requester-name': requesterName,
      'requester-openid': requesterOpenId,
      'source-type': sourceType,
      'source-title': sourceTitle
    },
    { syncAfter: true }
  );

  return {
    ...extractResult,
    action: 'auto',
    autoTriggered: true,
    candidateCount: candidates.length,
    detectedCount: extractResult.extractedCount || 0,
    sourceType,
    sourceTitle,
    userFacingHint:
      extractResult.extractedCount === 0
        ? '这条消息没有可跟进的新承诺，我先不入账。'
        : extractResult.syncState === 'synced'
          ? '已自动识别并同步这条承诺。'
          : extractResult.syncState === 'partial'
            ? '已识别到这条承诺，但只完成了部分同步。'
            : '已识别到这条承诺，但同步到飞书失败了。'
  };
}

async function handleSyncLatest() {
  const latest = loadLatestExtraction();
  const commitments = Array.isArray(latest.commitments) ? latest.commitments : [];
  if (commitments.length === 0) {
    throw new Error('最近一次提取结果里没有可同步的承诺。');
  }

  const sync = await syncCommitments(commitments);
  saveLatestOperation(
    buildOperationPayload({
      trigger: 'sync-latest',
      sourceTitle: latest.sourceTitle,
      sync,
      commitments
    })
  );

  latest.syncedAt = new Date().toISOString();
  latest.sync = sync;
  saveLatestExtraction(latest);

  return {
    ok: true,
    action: 'sync-latest',
    sourceTitle: latest.sourceTitle,
    storageMode: 'cache-only',
    syncState: summarizeSyncState(sync),
    syncedCount: commitments.length,
    sync,
    userFacingHint:
      summarizeSyncState(sync) === 'synced'
        ? '已将最近一次提取结果同步到飞书。'
        : summarizeSyncState(sync) === 'partial'
          ? '最近一次提取结果只完成了部分同步。'
          : '最近一次提取结果同步失败了。'
  };
}

async function handleStats() {
  const writer = new FeishuWriter();
  const schema = await writer.getSchemaProfile();
  const records = writer.normalizeBitableRecords(await writer.listBitableRecords());
  const commitments = records.map((record) => writer.buildCommitmentFromRecord(record, schema));

  return {
    ok: true,
    action: 'stats',
    ledgerSource: 'feishu-bitable',
    latestExtractionPath,
    stats: buildStatsFromCommitments(commitments)
  };
}

async function handleMonitorStatus() {
  const control = loadMonitorControl();
  const authState = loadAuthState();
  const watcher = loadWatcherStatus();
  const auth = await getLarkAuthStatus();
  const gate = getMonitorGate();

  return {
    ok: true,
    action: 'monitor-status',
    monitorState: summarizeMonitorControl(control),
    monitorControl: control,
    gateState: gate.state,
    auth: {
      identity: auth?.identity || '',
      hasUserIdentity: hasUserIdentity(auth),
      note: auth?.note || '',
      pendingAuthorization: isPendingAuthValid(authState),
      authState
    },
    watcher: {
      ...watcher,
      healthy: isWatcherHealthy(watcher)
    },
    statePaths: personalMonitorPaths,
    userFacingHint:
      !control.enabled
        ? '自动监听当前处于关闭状态。'
        : gate.state === 'paused'
          ? `自动监听已暂停，恢复时间：${control.pausedUntil}。`
          : watcher?.state === 'error' || !isWatcherHealthy(watcher)
            ? '自动监听开着，但扫描器当前不健康，需要恢复扫描进程。'
            : hasUserIdentity(auth)
              ? '自动监听正在运行，授权状态正常。'
              : '自动监听正在等待重新授权。'
  };
}

async function handleMonitorDisable(args) {
  const profile = loadWorkspaceUserProfile();
  const updatedBy = args['requester-name'] || profile.name || 'current-user';
  const reason = normalizeCommandText(readInputText(args).trim()) || 'manual_disable';
  const control = setMonitorDisabled(reason, updatedBy);

  return {
    ok: true,
    action: 'monitor-disable',
    monitorControl: control,
    userFacingHint: '自动监听已关闭。'
  };
}

async function handleMonitorEnable(args) {
  const profile = loadWorkspaceUserProfile();
  const updatedBy = args['requester-name'] || profile.name || 'current-user';
  const reason = normalizeCommandText(readInputText(args).trim()) || 'manual_enable';
  const control = setMonitorEnabled(reason, updatedBy);

  return {
    ok: true,
    action: 'monitor-enable',
    monitorControl: control,
    userFacingHint: '自动监听已恢复。'
  };
}

async function handleMonitorPause(args) {
  const profile = loadWorkspaceUserProfile();
  const updatedBy = args['requester-name'] || profile.name || 'current-user';
  const text = normalizeCommandText(readInputText(args).trim());
  const minutes = Number(args.minutes || parsePauseMinutes(text));
  const control = setMonitorPaused({
    minutes,
    reason: text || `pause_${minutes}_minutes`,
    updatedBy
  });

  return {
    ok: true,
    action: 'monitor-pause',
    monitorControl: control,
    pausedMinutes: minutes,
    userFacingHint: `自动监听已暂停到 ${control.pausedUntil}。`
  };
}

async function handleMonitorReauthorize(args) {
  const result = await triggerReauthorizationPrompt({
    notifyUser: !args.silent
  });

  return {
    ok: true,
    action: 'monitor-reauthorize',
    ...result,
    userFacingHint: '已发起重新授权，授权完成后自动监听会自行恢复。'
  };
}

function buildStatsReply(stats) {
  if (!stats) {
    return '目前还没有可用的承诺账本统计。';
  }

  const lines = [
    `当前承诺总数：${stats.total || 0} 条`,
    `待处理：${stats.pending || 0} 条`,
    `进行中：${stats.inProgress || 0} 条`,
    `已完成：${stats.done || 0} 条`,
    `已阻塞：${stats.blocked || 0} 条`
  ];

  if (typeof stats.dueSoon === 'number') {
    lines.push(`临期：${stats.dueSoon} 条`);
  }
  if (typeof stats.overdue === 'number') {
    lines.push(`逾期：${stats.overdue} 条`);
  }

  return lines.join('\n');
}

function buildMonitorStatusReply(result) {
  return [
    `监听状态：${result?.monitorState || 'unknown'}`,
    `授权身份：${result?.auth?.identity || 'unknown'}`,
    `扫描器：${result?.watcher?.state || 'unknown'}`,
    result?.watcher?.lastLoopAt ? `最近扫描：${result.watcher.lastLoopAt}` : '',
    result?.userFacingHint || ''
  ]
    .filter(Boolean)
    .join('\n');
}

function buildReplyFromCommandResult(result) {
  if (!result || typeof result !== 'object') {
    return 'FlowMate 已处理，但没有可展示的结果。';
  }

  if (typeof result.replyText === 'string' && result.replyText.trim()) {
    return sanitizeVisibleReplyText(result.replyText);
  }

  if (result.ok === false) {
    return result.userFacingHint || result.error || 'FlowMate 执行失败。';
  }

  switch (result.action) {
    case 'stats':
      return buildStatsReply(result.stats);
    case 'monitor-status':
      return buildMonitorStatusReply(result);
    case 'monitor-disable':
    case 'monitor-enable':
    case 'monitor-pause':
    case 'monitor-reauthorize':
    case 'commitment-manage':
    case 'ensure-views':
    case 'ensure-dashboard':
    case 'sync-linked-statuses':
    case 'team-status':
    case 'team-source-list':
    case 'team-source-add':
    case 'team-source-add-current':
    case 'team-source-remove':
    case 'team-source-remove-current':
    case 'team-source-enable':
    case 'team-source-disable':
    case 'team-scan-once':
    case 'team-warn':
    case 'team-sync-statuses':
    case 'team-subscribe-task-events':
    case 'team-dashboard-refresh':
    case 'team-digest':
    case 'team-knowledge-qa':
    case 'team-unassigned-list':
    case 'team-reassign':
    case 'team-member-add':
    case 'team-member-list':
    case 'team-member-remove':
    case 'undo-latest':
      return result.userFacingHint || '操作已完成。';
    case 'extract':
      return result.extractedCount > 0
        ? `已提取 ${result.extractedCount} 条承诺，暂未同步到飞书。`
        : '这段内容里没有识别到需要登记的新承诺。';
    case 'extract-and-sync':
    case 'sync-latest':
    case 'auto':
      return result.userFacingHint || '承诺处理已完成。';
    default:
      return result.userFacingHint || 'FlowMate 已处理完成。';
  }
}

async function loadLedgerCommitments(writer) {
  const schema = await writer.getSchemaProfile();
  const records = writer.normalizeBitableRecords(await writer.listBitableRecords());
  const commitments = records.map((record) => writer.buildCommitmentFromRecord(record, schema));
  return {
    schema,
    commitments
  };
}

function normalizeCommitmentMatchText(value) {
  return normalizeCommandText(value).toLowerCase().replace(/\s+/gu, '');
}

function isLatestCommitmentReference(targetText) {
  const normalized = normalizeCommandText(targetText);
  if (!normalized) {
    return true;
  }

  return /^(这条|这一条|刚刚那条|上一条|最新那条|该条|这个|刚才那个)$/u.test(normalized);
}

async function resolveCommitmentsForOperation(writer, targetText) {
  const { schema, commitments } = await loadLedgerCommitments(writer);
  if (commitments.length === 0) {
    return {
      schema,
      commitments: [],
      error: '账本里还没有可操作的承诺。'
    };
  }

  if (isLatestCommitmentReference(targetText)) {
    let latest = null;
    try {
      latest = loadLatestOperation();
    } catch {
      latest = null;
    }

    const latestItems = Array.isArray(latest?.items) ? latest.items : [];
    if (latestItems.length === 1) {
      const item = latestItems[0];
      const matched = commitments.find((commitment) =>
        commitment.id === item.id ||
        commitment.bitableRecordId === item.bitableRecordId ||
        commitment.title === item.title
      );
      if (matched) {
        return {
          schema,
          commitments: [matched]
        };
      }
    }

    if (latestItems.length > 1) {
      return {
        schema,
        commitments: [],
        error: `最近一次自动记录里有 ${latestItems.length} 条承诺，请把标题再说具体一点。`,
        ambiguous: latestItems.map((item) => item.title).filter(Boolean)
      };
    }
  }

  const keyword = normalizeCommitmentMatchText(targetText);
  if (!keyword) {
    return {
      schema,
      commitments: [],
      error: '我还不知道你要操作哪一条承诺，请把标题说具体一点。'
    };
  }

  const scored = commitments
    .map((commitment) => {
      const title = normalizeCommitmentMatchText(commitment.title);
      const evidence = normalizeCommitmentMatchText(commitment.rawMessageText || commitment.evidence?.[0]?.quote || '');
      const source = normalizeCommitmentMatchText(commitment.sourceTitle || '');
      let score = 0;
      if (commitment.id === targetText) {
        score = 100;
      } else if (title === keyword) {
        score = 90;
      } else if (title.includes(keyword)) {
        score = 70;
      } else if (evidence.includes(keyword)) {
        score = 60;
      } else if (source.includes(keyword)) {
        score = 40;
      }
      return {
        commitment,
        score
      };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score);

  if (scored.length === 0) {
    return {
      schema,
      commitments: [],
      error: `没有在账本里找到和“${targetText}”对应的承诺。`
    };
  }

  if (scored.length > 1 && scored[0].score === scored[1].score) {
    return {
      schema,
      commitments: [],
      error: `我找到多条可能匹配“${targetText}”的承诺，请再说具体一点。`,
      ambiguous: scored.slice(0, 5).map((item) => item.commitment.title)
    };
  }

  return {
    schema,
    commitments: [scored[0].commitment]
  };
}

async function deleteTrackedCommitment(writer, commitment) {
  const outcome = {
    id: commitment.id,
    title: commitment.title,
    bitableRemoved: false,
    taskRemoved: false,
    calendarRemoved: false,
    errors: []
  };

  let calendarId = commitment.calendarId || '';
  let calendarEventId = commitment.calendarEventId || '';
  if ((!calendarId || !calendarEventId) && commitment.title && commitment.deadline) {
    try {
      const existingEvent = await writer.findExistingCalendarReminder(commitment);
      calendarId = calendarId || existingEvent?.calendarId || '';
      calendarEventId = calendarEventId || existingEvent?.eventId || '';
    } catch (error) {
      outcome.errors.push(`查找日程失败：${error.message}`);
    }
  }

  if (calendarId && calendarEventId) {
    try {
      await writer.deleteCalendarEvent(calendarId, calendarEventId);
      outcome.calendarRemoved = true;
    } catch (error) {
      outcome.errors.push(`删除日程失败：${error.message}`);
    }
  }

  if (commitment.feishuTaskId) {
    try {
      await writer.deleteTask(commitment.feishuTaskId);
      outcome.taskRemoved = true;
    } catch (error) {
      outcome.errors.push(`删除任务失败：${error.message}`);
    }
  }

  if (commitment.bitableRecordId) {
    try {
      await writer.deleteBitableRecord(commitment.bitableRecordId);
      outcome.bitableRemoved = true;
    } catch (error) {
      outcome.errors.push(`删除账本记录失败：${error.message}`);
    }
  }

  return outcome;
}

async function updateTrackedCommitment(writer, schema, commitment, updates) {
  const previous = { ...commitment };
  const next = {
    ...commitment,
    updatedAt: new Date().toISOString()
  };

  if (updates.status) {
    next.status = updates.status;
  }

  if (updates.deadlineText) {
    const parsedDeadline = parseRelativeDeadline(updates.deadlineText);
    if (!parsedDeadline) {
      throw new Error(`暂时没法解析“${updates.deadlineText}”这个时间。`);
    }
    next.deadlineText = updates.deadlineText;
    next.deadline = parsedDeadline;
  } else if (updates.deadline) {
    const parsedDeadline = toIsoDateTime(updates.deadline);
    if (!parsedDeadline) {
      throw new Error(`暂时没法解析“${updates.deadline}”这个时间。`);
    }
    next.deadlineText = updates.deadline;
    next.deadline = parsedDeadline;
  }

  if (!next.bitableRecordId) {
    throw new Error('这条承诺缺少账本记录 ID，暂时无法更新。');
  }

  await writer.updateCommitmentInBitable(next.bitableRecordId, next, schema);

  const outcome = {
    id: next.id,
    title: next.title,
    bitableUpdated: true,
    taskUpdated: false,
    taskCreated: false,
    calendarUpdated: false,
    calendarCreated: false,
    calendarDeleted: false,
    status: next.status,
    deadline: next.deadline || '',
    errors: []
  };

  if (next.feishuTaskId) {
    try {
      await writer.updateTask(next.feishuTaskId, next);
      outcome.taskUpdated = true;
      if (next.status === CommitmentStatus.DONE) {
        await writer.completeTask(next.feishuTaskId);
      }
    } catch (error) {
      outcome.errors.push(`更新任务失败：${error.message}`);
    }
  } else {
    try {
      const taskResult = await writer.syncCommitmentsToTask(next);
      if (taskResult?.taskId) {
        next.feishuTaskId = taskResult.taskId;
        outcome.taskCreated = true;
      }
    } catch (error) {
      outcome.errors.push(`创建任务失败：${error.message}`);
    }
  }

  let calendarId = previous.calendarId || next.calendarId || '';
  let calendarEventId = previous.calendarEventId || next.calendarEventId || '';
  if ((!calendarId || !calendarEventId) && previous.title && previous.deadline) {
    try {
      const existingEvent = await writer.findExistingCalendarReminder(previous);
      calendarId = calendarId || existingEvent?.calendarId || '';
      calendarEventId = calendarEventId || existingEvent?.eventId || '';
    } catch (error) {
      outcome.errors.push(`查找日程失败：${error.message}`);
    }
  }

  if (next.deadline && calendarId && calendarEventId) {
    try {
      await writer.updateCalendarEvent(calendarId, calendarEventId, next);
      next.calendarId = calendarId;
      next.calendarEventId = calendarEventId;
      outcome.calendarUpdated = true;
    } catch (error) {
      try {
        await writer.deleteCalendarEvent(calendarId, calendarEventId);
        outcome.calendarDeleted = true;
        const created = await writer.createCalendarReminder(next);
        if (created?.eventId) {
          next.calendarEventId = created.eventId;
          next.calendarId = created.calendarId || '';
          outcome.calendarCreated = true;
          outcome.calendarUpdated = true;
        }
      } catch (fallbackError) {
        outcome.errors.push(`更新日程失败：${error.message}；回退重建也失败：${fallbackError.message}`);
      }
    }
  } else if (next.deadline) {
    try {
      const created = await writer.ensureCalendarReminder(next);
      if (created?.eventId) {
        next.calendarEventId = created.eventId;
        next.calendarId = created.calendarId || '';
        outcome.calendarCreated = !created.existed;
        outcome.calendarUpdated = true;
      }
    } catch (error) {
      outcome.errors.push(`创建日程失败：${error.message}`);
    }
  }

  if (
    outcome.taskCreated
    || outcome.taskUpdated
    || outcome.calendarUpdated
    || outcome.calendarCreated
    || outcome.calendarDeleted
  ) {
    try {
      await writer.updateCommitmentInBitable(next.bitableRecordId, next, schema);
    } catch (error) {
      outcome.errors.push(`回写关联 ID 失败：${error.message}`);
    }
  }

  return {
    outcome,
    commitment: next
  };
}

async function handleCommitmentManage(args) {
  const operation = args.action
    ? {
      action: String(args.action).trim(),
      targetText: String(args.target || args['target-text'] || '').trim(),
      reference: String(args.reference || '').trim(),
      updates: {
        ...(args.status ? { status: String(args.status).trim() } : {}),
        ...(args['deadline-text'] ? { deadlineText: String(args['deadline-text']).trim() } : {}),
        ...(args.deadline ? { deadline: String(args.deadline).trim() } : {})
      }
    }
    : parseCommitmentOperation(readInputText(args).trim());
  if (!operation) {
    throw new Error('这条消息里没有识别到可执行的承诺操作。');
  }

  if (operation.action === 'undo-latest') {
    return await handleUndoLatest(args);
  }

  const writer = new FeishuWriter();
  if (args['operation-scope'] === 'team') {
    const teamConfig = tryReadJson(resolve(workspaceStateDir, 'flowmate-team-config.json'), {});
    if (teamConfig?.tableId) {
      writer.bitableTableId = teamConfig.tableId;
      writer.schemaProfile = null;
      writer.ensuredLedgerFields = false;
    }
  }
  const resolved = await resolveCommitmentsForOperation(writer, operation.targetText);
  if (resolved.error) {
    return {
      ok: false,
      action: 'commitment-manage',
      operation,
      ...resolved,
      userFacingHint: resolved.ambiguous?.length
        ? `${resolved.error}\n候选项：\n- ${resolved.ambiguous.join('\n- ')}`
        : resolved.error
    };
  }

  const target = resolved.commitments[0];
  if (!target) {
    return {
      ok: false,
      action: 'commitment-manage',
      operation,
      userFacingHint: '没有找到可操作的承诺。'
    };
  }

  if (operation.action === 'delete') {
    const deleted = await deleteTrackedCommitment(writer, target);
    const successCount = [deleted.bitableRemoved, deleted.taskRemoved, deleted.calendarRemoved].filter(Boolean).length;
    const latestOperation = loadLatestOperation(args);
    const latestItems = Array.isArray(latestOperation.items) ? latestOperation.items : [];
    const touchesLatest = latestItems.some((item) => {
      return Boolean(
        item.id === target.id
        || item.bitableRecordId === target.bitableRecordId
        || item.taskId === target.feishuTaskId
        || item.calendarEventId === target.calendarEventId
        || normalizeCommitmentMatchText(item.title).includes(normalizeCommitmentMatchText(target.title))
        || normalizeCommitmentMatchText(target.title).includes(normalizeCommitmentMatchText(item.title))
      );
    });
    if (touchesLatest && deleted.errors.length === 0) {
      saveLatestOperation({
        ...latestOperation,
        undoneAt: new Date().toISOString(),
        undone: [deleted]
      }, args);
    }
    return {
      ok: deleted.errors.length === 0,
      action: 'commitment-manage',
      operation,
      deleted,
      userFacingHint: deleted.errors.length === 0
        ? `已删除承诺“${target.title}”，并清理对应的账本、任务、日程。`
        : successCount > 0
          ? `承诺“${target.title}”已部分删除，但还有失败项：${deleted.errors.join('；')}`
          : `承诺“${target.title}”删除失败：${deleted.errors.join('；')}`
    };
  }

  const updated = await updateTrackedCommitment(writer, resolved.schema, target, operation.updates || {});
  const updatedParts = [];
  if (operation.updates?.status === CommitmentStatus.DONE) {
    updatedParts.push('状态改为已完成');
  } else if (operation.updates?.status === CommitmentStatus.BLOCKED) {
    updatedParts.push('状态改为已阻塞');
  }
  if (operation.updates?.deadlineText) {
    updatedParts.push(`截止时间改为 ${operation.updates.deadlineText}`);
  } else if (operation.updates?.deadline) {
    updatedParts.push(`截止时间改为 ${operation.updates.deadline}`);
  }

  return {
    ok: updated.outcome.errors.length === 0,
    action: 'commitment-manage',
    operation,
    updated: updated.outcome,
    userFacingHint: updated.outcome.errors.length === 0
      ? `已更新承诺“${target.title}”：${updatedParts.join('，') || '内容已同步'}。`
      : `承诺“${target.title}”已部分更新，但还有失败项：${updated.outcome.errors.join('；')}`
  };
}

async function handleUndoLatest(args = {}) {
  const writer = new FeishuWriter();
  if (args['operation-scope'] === 'team') {
    const teamConfig = tryReadJson(resolve(workspaceStateDir, 'flowmate-team-config.json'), {});
    if (teamConfig?.tableId) {
      writer.bitableTableId = teamConfig.tableId;
      writer.schemaProfile = null;
      writer.ensuredLedgerFields = false;
    }
  }
  const operation = loadLatestOperation(args);

  if (!Array.isArray(operation.items) || operation.items.length === 0) {
    return {
      ok: true,
      action: 'undo-latest',
      undoneCount: 0,
      undone: [],
      userFacingHint: '最近没有可撤销的自动操作。'
    };
  }

  if (operation.undoneAt) {
    return {
      ok: true,
      action: 'undo-latest',
      undoneCount: 0,
      undone: [],
      alreadyUndoneAt: operation.undoneAt,
      userFacingHint: `最近一次自动处理已经在 ${operation.undoneAt} 撤销过了，没有新的可撤销记录。`
    };
  }

  const undone = [];
  for (const item of operation.items) {
    const deletion = await deleteTrackedCommitment(writer, {
      id: item.id,
      title: item.title,
      bitableRecordId: item.bitableCreated ? item.bitableRecordId : '',
      feishuTaskId: item.taskCreated ? item.taskId : '',
      calendarEventId: item.calendarCreated ? item.calendarEventId : '',
      calendarId: item.calendarCreated ? item.calendarCalendarId : '',
      deadline: item.deadline || ''
    });
    undone.push(deletion);
  }

  saveLatestOperation({
    ...operation,
    undoneAt: new Date().toISOString(),
    undone
  });

  return {
    ok: undone.every((item) => item.errors.length === 0),
    action: 'undo-latest',
    undoneCount: undone.length,
    undone,
    userFacingHint: undone.length === 0
      ? '最近没有可撤销的自动处理。'
      : undone.every((item) => item.errors.length === 0)
        ? `已撤销最近一次自动处理，共 ${undone.length} 条。`
        : `最近一次自动处理已部分撤销，但还有失败项：${undone.flatMap((item) => item.errors).join('；')}`
  };
}

async function handleEnsureViews() {
  const writer = new FeishuWriter();
  const ensured = await writer.ensurePersonalLedgerViews();
  return {
    ok: true,
    action: 'ensure-views',
    ...ensured,
    userFacingHint: '承诺账本视图已准备好。'
  };
}

async function handleEnsureDashboard() {
  const writer = new FeishuWriter();
  const ensured = await writer.ensurePersonalLedgerDashboard();
  return {
    ok: true,
    action: 'ensure-dashboard',
    ...ensured,
    userFacingHint: '个人仪表盘已准备好。'
  };
}

async function handleSyncLinkedStatuses() {
  const writer = new FeishuWriter();
  const result = await writer.syncLinkedStatuses();
  return {
    ok: true,
    action: 'sync-linked-statuses',
    ...result,
    userFacingHint: `已回写 ${result.updatedCount} 条关联状态更新。`
  };
}

function buildChatStateContext() {
  const monitorControl = loadMonitorControl();
  const watcher = loadWatcherStatus();
  const authState = loadAuthState();
  const latestExtraction = tryReadJson(latestExtractionPath, {});
  const latestScan = loadPersonalScanState();

  return {
    model: config.zai.model,
    monitorState: summarizeMonitorControl(monitorControl),
    watcherState: watcher?.state || '',
    watcherHealthy: isWatcherHealthy(watcher),
    lastWatcherLoopAt: watcher?.lastLoopAt || '',
    pendingAuthorization: isPendingAuthValid(authState),
    latestExtractionAt: latestExtraction?.savedAt || latestExtraction?.extractedAt || '',
    latestScanAt: latestScan?.lastScanAt || '',
    personalAutomationPath: 'personal message scan -> rules filter -> commitment extraction -> bitable -> task -> calendar -> bot notification'
  };
}

function tryLocalChatReply(userText, stateContext) {
  const text = normalizeCommandText(userText);

  if (/^(你好|嗨|hi|hello|在吗)[!！。？?]*$/iu.test(text)) {
    return '你好，我是 FlowMate。你可以直接问我问题，也可以把会议纪要、聊天记录或承诺发给我处理。';
  }

  if (/(你现在是调用模型进行回复的吗|是不是调用模型|你用的是什么模型)/u.test(text)) {
    return `是，普通问答当前会走 ${stateContext.model} 模型。固定控制命令和监听控制不依赖模型。`;
  }

  if (/(你知道飞书是什么吗|飞书是什么)/u.test(text)) {
    return '飞书是企业协作平台，包含即时通讯、会议、文档、多维表格、任务和日历等能力。FlowMate 主要利用它来做承诺识别、账本记录、任务创建和提醒闭环。';
  }

  if (/(你是谁|你能做什么|你有什么能力)/u.test(text)) {
    return '我是 FlowMate，负责承诺识别和闭环执行。我可以做私聊问答、承诺提取、同步承诺到账本、创建任务和日历提醒，也能控制和查看个人消息自动监听状态。';
  }

  if (
    /(为什么.*(没识别|没提取|没抓到|没有识别|没有提取)|其他聊天框.*承诺.*为什么)/u.test(text) ||
    (text.includes('其他聊天框') && text.includes('承诺') && text.includes('为什么'))
  ) {
    if (stateContext.monitorState === 'disabled') {
      return '这次没识别到，首先要看监听本身是否开着。当前自动监听是关闭状态，所以其他聊天里的新承诺不会被自动处理。';
    }
    if (stateContext.pendingAuthorization) {
      return '这次没识别到，主要原因是个人消息扫描正在等待重新授权。授权恢复前，其他聊天里的新消息不会被自动拉取。';
    }
    if (!stateContext.watcherHealthy) {
      return '这次没识别到，更像是扫描器没有稳定跑起来。监听配置可能是开的，但扫描链路当前不健康，所以消息没有被及时拉到 FlowMate。';
    }
    return '如果刚才其他聊天里的承诺没有被识别，通常要检查三层：监听是否开启、消息搜索授权是否正常、以及那条消息本身是否像明确承诺。当前链路看起来是开的，所以更可能是那条消息没有被判定成明确承诺，或者刚好还没到最近一次扫描窗口。';
  }

  return '';
}

async function handleChat(args) {
  const userText = normalizeCommandText(readInputText(args).trim());
  if (!userText) {
    return {
      ok: true,
      action: 'chat',
      replyText: '我在。你可以直接问我问题，或者把会议纪要、聊天记录和承诺发给我处理。'
    };
  }

  const stateContext = buildChatStateContext();
  const localReply = tryLocalChatReply(userText, stateContext);
  if (localReply) {
    return {
      ok: true,
      action: 'chat',
      replyText: localReply
    };
  }

  const systemPrompt = [
    '你是 FlowMate，飞书里的个人承诺闭环助手。',
    '请像一个自然、简洁、可靠的中文助手那样回答用户。',
    '当用户问能力、监听、承诺识别、账本、任务、日历、提醒时，要结合提供的运行状态作答。',
    '绝不能输出或解释这些内部内容：NO_REPLY、</arg_value>、[[reply_to_current]]、previous agent run was aborted、tool routing、skill loading、internal prompt。',
    '只输出面向用户的自然中文，不要描述你的内部步骤。'
  ].join('\n');

  const prompt = [
    '当前 FlowMate 运行状态（供回答参考）：',
    JSON.stringify(stateContext, null, 2),
    '',
    `用户消息：${userText}`,
    '',
    '请直接给出自然中文回复。'
  ].join('\n');

  const cleanSystemPrompt = [
    '你是 FlowMate，飞书里的个人承诺闭环助手。',
    '请像一个自然、简洁、可靠的中文助手那样回答用户。',
    '当用户问能力、监听、承诺识别、账本、任务、日历、提醒时，要结合提供的运行状态作答。',
    '绝不能输出或解释这些内部内容：NO_REPLY、</arg_value>、[[reply_to_current]]、previous agent run was aborted、tool routing、skill loading、internal prompt。',
    '只输出面向用户的自然中文，不要描述你的内部步骤。'
  ].join('\n');

  const cleanPrompt = [
    '当前 FlowMate 运行状态（供回答参考）：',
    JSON.stringify(stateContext, null, 2),
    '',
    `用户消息：${userText}`,
    '',
    '请直接给出自然中文回复。'
  ].join('\n');

  let replyText = '';
  try {
    replyText = sanitizeVisibleReplyText(await modelClient.complete(cleanPrompt, cleanSystemPrompt));
  } catch (error) {
    replyText =
      `我这边普通问答暂时遇到了模型拥堵，稍后再试会更稳。` +
      `就当前状态看，自动监听是 ${stateContext.monitorState}，扫描器状态是 ${stateContext.watcherState || 'unknown'}。`;
  }
  return {
    ok: true,
    action: 'chat',
    replyText: replyText || '我在。你可以继续直接问我，或者让我处理承诺、任务和提醒。'
  };
}

async function handleP2P(args) {
  const text = normalizeCommandText(readInputText(args).trim());
  const mode = args.mode || inferP2PMode(text);
  if (mode === 'team-knowledge-qa' && !args.question && !args.query) {
    args.question = text
      .replace(/^(团队知识问答|问团队知识|查团队知识|基于团队证据|team qa|knowledge qa)[:：]?\s*/iu, '')
      .trim() || text;
  }
  let result;

  if (mode === 'chat') {
    result = await handleChat(args);
  } else if (mode === 'auto') {
    result = await handleAuto(args);
  } else if (mode === 'extract') {
    result = await handleExtract(args);
  } else if (mode === 'extract-and-sync') {
    result = await handleExtract(args, { syncAfter: true });
  } else if (mode === 'sync-latest') {
    result = await handleSyncLatest();
  } else if (mode === 'stats') {
    result = await handleStats();
  } else if (mode === 'monitor-status') {
    result = await handleMonitorStatus();
  } else if (mode === 'monitor-disable') {
    result = await handleMonitorDisable(args);
  } else if (mode === 'monitor-enable') {
    result = await handleMonitorEnable(args);
  } else if (mode === 'monitor-pause') {
    result = await handleMonitorPause(args);
  } else if (mode === 'monitor-reauthorize') {
    result = await handleMonitorReauthorize(args);
  } else if (mode === 'commitment-manage') {
    result = await handleCommitmentManage(args);
  } else if (mode === 'undo-latest') {
    result = await handleUndoLatest(args);
  } else if (mode === 'ensure-views') {
    result = await handleEnsureViews();
  } else if (mode === 'ensure-dashboard') {
    result = await handleEnsureDashboard();
  } else if (mode === 'sync-linked-statuses') {
    result = await handleSyncLinkedStatuses();
  } else if (mode.startsWith('team-')) {
    result = await handleTeamCommand(mode, args);
  } else {
    result = await handleChat(args);
  }

  return {
    ...result,
    mode,
    replyText: sanitizeVisibleReplyText(buildReplyFromCommandResult(result))
  };
}

async function handleScanPersonalMessages(args) {
  const profile = loadWorkspaceUserProfile();
  const requesterName = args['requester-name'] || profile.name || '当前用户';
  const requesterOpenId = args['requester-openid'] || profile.openId || '';
  const writer = new FeishuWriter();

  if (!requesterOpenId) {
    throw new Error('缺少当前用户 Open ID，无法扫描个人消息。');
  }

  const state = loadPersonalScanState();
  const window = buildPersonalScanWindow(args, state);
  const chatType = args['chat-type'] || '';
  const pageSize = Number(args['page-size'] || 50);
  const fetchedMessages = await searchPersonalMessages({
    senderOpenId: requesterOpenId,
    start: window.start,
    end: window.end,
    pageSize,
    chatType
  });

  const processedSet = new Set(state.processedMessageIds);
  const messages = fetchedMessages
    .filter((message) => !processedSet.has(message.messageId))
    .sort((left, right) => new Date(left.createTime || 0).getTime() - new Date(right.createTime || 0).getTime());

  const results = [];
  const nextProcessedIds = [...state.processedMessageIds];
  const notificationTitles = [];
  const operationItems = [];
  let taskCreatedCount = 0;
  let calendarCreatedCount = 0;
  let notificationResult = null;
  let linkedStatusSync = null;

  for (const message of messages) {
    const explicitMessageCommand = inferCommandFromText(message.content);
    if (explicitMessageCommand && explicitMessageCommand !== 'auto') {
      results.push({
        messageId: message.messageId,
        chatId: message.chatId,
        chatName: message.chatName,
        createTime: message.createTime,
        autoTriggered: false,
        extractedCount: 0,
        syncState: 'skipped',
        hint: '这条消息是 FlowMate 操作命令，已跳过自动承诺识别。'
      });
      processedSet.add(message.messageId);
      nextProcessedIds.push(message.messageId);
      continue;
    }

    if (!isLikelyPersonalCommitmentMessage(message.content)) {
      results.push({
        messageId: message.messageId,
        chatId: message.chatId,
        chatName: message.chatName,
        createTime: message.createTime,
        autoTriggered: false,
        extractedCount: 0,
        syncState: 'skipped',
        hint: '这条消息更像讨论、提问或背景描述，我先不把它当作个人承诺。'
      });
      processedSet.add(message.messageId);
      nextProcessedIds.push(message.messageId);
      continue;
    }

    try {
      const contextBundle = await buildMessageContextBundle(message);
      const result = await handleAuto({
        ...args,
        text: message.content,
        'requester-name': requesterName,
        'requester-openid': requesterOpenId,
        'source-type': SourceType.CHAT,
        'source-title': buildMessageSourceTitle(message),
        'source-link': contextBundle.sourceLink,
        'source-message-id': contextBundle.sourceMessageId,
        'source-chat-id': contextBundle.sourceChatId,
        'source-thread-id': contextBundle.sourceThreadId,
        'raw-message-text': contextBundle.rawMessageText,
        'conversation-summary': contextBundle.conversationSummary,
        'conversation-context': contextBundle.conversationContext
      });

      results.push({
        messageId: message.messageId,
        chatId: message.chatId,
        chatName: message.chatName,
        createTime: message.createTime,
        autoTriggered: Boolean(result.autoTriggered),
        extractedCount: result.extractedCount || result.detectedCount || 0,
        syncState: result.syncState || '',
        hint: result.userFacingHint || ''
      });

      if (result.autoTriggered && result.syncState === 'synced') {
        const latest = loadLatestExtraction();
        const commitments = Array.isArray(latest?.commitments) ? latest.commitments : [];
        notificationTitles.push(...commitments.map((item) => item.title));

        const syncResults = Array.isArray(result?.sync?.results) ? result.sync.results : [];
        taskCreatedCount += syncResults.filter((item) => item.task?.ok && !item.task?.skipped).length;
        calendarCreatedCount += syncResults.filter((item) => item.calendar?.ok && !item.calendar?.skipped).length;

        operationItems.push(
          ...buildOperationPayload({
            trigger: 'scan-personal-messages',
            sourceTitle: buildMessageSourceTitle(message),
            messageId: message.messageId,
            sync: result.sync,
            commitments
          }).items
        );
      }
    } catch (error) {
      results.push({
        messageId: message.messageId,
        chatId: message.chatId,
        chatName: message.chatName,
        createTime: message.createTime,
        autoTriggered: false,
        extractedCount: 0,
        syncState: 'failed',
        error: error.message
      });
    }

    processedSet.add(message.messageId);
    nextProcessedIds.push(message.messageId);
  }

  const nextState = {
    lastScanAt: window.end,
    processedMessageIds: buildTrimmedProcessedIds(nextProcessedIds)
  };
  savePersonalScanState(nextState);

  const autoTriggeredCount = results.filter((item) => item.autoTriggered).length;
  const syncedCount = results.filter((item) => item.syncState === 'synced').length;
  const skippedCount = results.filter((item) => item.syncState === 'skipped').length;
  const failedCount = results.filter((item) => item.syncState === 'failed').length;

  try {
    linkedStatusSync = await writer.syncLinkedStatuses();
  } catch {
    linkedStatusSync = null;
  }

  if (syncedCount > 0) {
    try {
      await writer.ensurePersonalLedgerViews();
      await writer.ensurePersonalLedgerDashboard();
    } catch {
      // Best effort only.
    }

    saveLatestOperation({
      savedAt: new Date().toISOString(),
      trigger: 'scan-personal-messages',
      items: operationItems
    }, args);

    notificationResult = await writer.sendBotMessage(
      requesterOpenId,
      buildScanNotificationMessage({
        newMessageCount: messages.length,
        autoTriggeredCount,
        syncedCount,
        taskCreatedCount,
        calendarCreatedCount,
        commitmentTitles: [...new Set(notificationTitles)]
      })
    );
  }

  return {
    ok: true,
    action: 'scan-personal-messages',
    scanMode: 'user-identity-pull',
    sourceScope: chatType || 'all-visible-chats',
    requesterName,
    requesterOpenId,
    scanWindow: window,
    statePath: personalScanStatePath,
    fetchedCount: fetchedMessages.length,
    newMessageCount: messages.length,
    autoTriggeredCount,
    syncedCount,
    skippedCount,
    failedCount,
    linkedStatusUpdatedCount: linkedStatusSync?.updatedCount || 0,
    taskCreatedCount,
    calendarCreatedCount,
    botNotificationSent: Boolean(notificationResult?.ok),
    results
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const contextText = normalizeCommandText(readInputText(args).trim() || getLatestUserMessageText());
  const command = args._[0] || inferCommandFromText(contextText) || (isLikelyPersonalCommitmentMessage(contextText) ? 'auto' : 'extract');

  if (!args.input && !args.text && contextText) {
    args.text = contextText;
  }

  let result;
  if (command === 'extract') {
    result = await handleExtract(args);
  } else if (command === 'auto') {
    result = await handleAuto(args);
  } else if (command === 'monitor-disable') {
    result = await handleMonitorDisable(args);
  } else if (command === 'monitor-enable') {
    result = await handleMonitorEnable(args);
  } else if (command === 'monitor-pause') {
    result = await handleMonitorPause(args);
  } else if (command === 'monitor-status') {
    result = await handleMonitorStatus(args);
  } else if (command === 'monitor-reauthorize') {
    result = await handleMonitorReauthorize(args);
  } else if (command === 'commitment-manage') {
    result = await handleCommitmentManage(args);
  } else if (command === 'undo-latest') {
    result = await handleUndoLatest(args);
  } else if (command === 'ensure-views') {
    result = await handleEnsureViews();
  } else if (command === 'ensure-dashboard') {
    result = await handleEnsureDashboard();
  } else if (command === 'sync-linked-statuses') {
    result = await handleSyncLinkedStatuses();
  } else if (command.startsWith('team-')) {
    result = await handleTeamCommand(command, args);
  } else if (command === 'extract-and-sync') {
    result = await handleExtract(args, { syncAfter: true });
  } else if (command === 'sync-latest') {
    result = await handleSyncLatest();
  } else if (command === 'scan-personal-messages' || command === 'scan-personal') {
    result = await handleScanPersonalMessages(args);
  } else if (command === 'p2p-handle' || command === 'chat') {
    result = command === 'chat' ? await handleChat(args) : await handleP2P(args);
  } else if (command === 'stats') {
    result = await handleStats();
  } else {
    throw new Error(`不支持的命令: ${command}`);
  }

  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error.message
      },
      null,
      2
    )
  );
  process.exit(1);
});
