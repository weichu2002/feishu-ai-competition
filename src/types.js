export const SourceType = {
  MEETING: 'meeting',
  MINUTES: 'minutes',
  CHAT: 'chat',
  DOCUMENT: 'document',
  CALENDAR: 'calendar',
  TASK: 'task',
  MANUAL: 'manual'
};

export const CommitmentStatus = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  IN_PROGRESS: 'in_progress',
  BLOCKED: 'blocked',
  DONE: 'done',
  IGNORED: 'ignored'
};

export const Priority = {
  P0: 'P0',
  P1: 'P1',
  P2: 'P2',
  P3: 'P3'
};

export const Confidence = {
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low'
};

export function createEvidence(data) {
  return {
    sourceType: data.sourceType || SourceType.MANUAL,
    sourceTitle: data.sourceTitle || '',
    sourceLink: data.sourceLink || '',
    quote: data.quote || '',
    speaker: data.speaker || '',
    timestamp: data.timestamp || new Date().toISOString()
  };
}

export function createCommitment(data = {}) {
  const now = new Date().toISOString();
  return {
    id: data.id || generateId(),
    title: data.title || '',
    owner: data.owner || '',
    ownerOpenId: data.ownerOpenId || '',
    deadlineText: data.deadlineText || '',
    deadline: data.deadline || null,
    priority: data.priority || Priority.P2,
    status: data.status || CommitmentStatus.PENDING,
    sourceType: data.sourceType || SourceType.MANUAL,
    sourceTitle: data.sourceTitle || '',
    sourceLink: data.sourceLink || '',
    evidence: Array.isArray(data.evidence) ? data.evidence : [],
    confidence: data.confidence || Confidence.MEDIUM,
    nextAction: data.nextAction || '',
    riskReason: data.riskReason || '',
    feishuTaskId: data.feishuTaskId || '',
    bitableRecordId: data.bitableRecordId || '',
    createdAt: data.createdAt || now,
    updatedAt: data.updatedAt || now
  };
}

export function generateId() {
  return `cmt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

export function validateCommitment(commitment) {
  const errors = [];

  if (!commitment.title || commitment.title.trim() === '') {
    errors.push('承诺标题不能为空');
  }

  if (!commitment.evidence || commitment.evidence.length === 0) {
    errors.push('承诺必须有证据');
  }

  if (commitment.confidence === Confidence.LOW && commitment.status !== CommitmentStatus.PENDING) {
    errors.push('低置信度承诺只能 pending');
  }

  if (commitment.feishuTaskId && !commitment.bitableRecordId) {
    errors.push('写入飞书任务后必须回写 bitableRecordId');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

export function isFlowMateTestResource(sourceTitle) {
  if (!sourceTitle) return false;
  return sourceTitle.includes('FlowMate_') || sourceTitle.includes('[FlowMate测试]');
}

export function isOverdue(commitment) {
  if (!commitment.deadline) return false;
  if (commitment.status === CommitmentStatus.DONE) return false;
  return new Date(commitment.deadline) < new Date();
}

export function isDueSoon(commitment, hours = 24) {
  if (!commitment.deadline) return false;
  if (commitment.status === CommitmentStatus.DONE) return false;
  const deadline = new Date(commitment.deadline);
  const now = new Date();
  const diff = deadline - now;
  return diff > 0 && diff <= hours * 60 * 60 * 1000;
}

function chineseNumberToInt(text) {
  const digitMap = {
    '零': 0,
    '一': 1,
    '二': 2,
    '两': 2,
    '三': 3,
    '四': 4,
    '五': 5,
    '六': 6,
    '七': 7,
    '八': 8,
    '九': 9
  };

  if (/^\d+$/.test(text)) {
    return parseInt(text, 10);
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

function setTime(date, hours, minutes = 0, seconds = 0, milliseconds = 0) {
  const d = new Date(date);
  d.setHours(hours, minutes, seconds, milliseconds);
  return d;
}

function getWeekdayDate(baseDate, weekday, nextWeek = false) {
  const currentWeekday = baseDate.getDay() === 0 ? 7 : baseDate.getDay();
  let offset = weekday - currentWeekday;

  if (nextWeek || offset <= 0) {
    offset += 7;
  }

  const target = new Date(baseDate);
  target.setDate(baseDate.getDate() + offset);
  return target;
}

export function parseRelativeTime(text) {
  if (!text) return null;

  const now = new Date();
  const lower = text.toLowerCase();
  const weekdayMap = {
    '一': 1,
    '二': 2,
    '三': 3,
    '四': 4,
    '五': 5,
    '六': 6,
    '日': 7,
    '天': 7
  };

  const patterns = [
    { regex: /明天上午/i, getDate: () => setTime(new Date(now.getTime() + 24 * 60 * 60 * 1000), 10) },
    { regex: /明天下午/i, getDate: () => setTime(new Date(now.getTime() + 24 * 60 * 60 * 1000), 17) },
    { regex: /今天下午/i, getDate: () => setTime(now, 17) },
    { regex: /今天上午/i, getDate: () => setTime(now, 10) },
    { regex: /今晚/i, getDate: () => setTime(now, 23, 59, 59, 999) },
    { regex: /今天/i, getDate: () => setTime(now, 23, 59, 59, 999) },
    { regex: /明天/i, getDate: () => setTime(new Date(now.getTime() + 24 * 60 * 60 * 1000), 23, 59, 59, 999) },
    { regex: /后天/i, getDate: () => setTime(new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000), 23, 59, 59, 999) },
    {
      regex: /下周([一二三四五六日天])/i,
      getDate: (m) => setTime(getWeekdayDate(now, weekdayMap[m[1]], true), 18)
    },
    {
      regex: /本周([一二三四五六日天])/i,
      getDate: (m) => setTime(getWeekdayDate(now, weekdayMap[m[1]], false), 18)
    },
    {
      regex: /月底/i,
      getDate: () => setTime(new Date(now.getFullYear(), now.getMonth() + 1, 0), 18)
    },
    {
      regex: /([零一二两三四五六七八九十\d]+)小时/i,
      getDate: (m) => {
        const hours = chineseNumberToInt(m[1]);
        return hours === null ? null : new Date(now.getTime() + hours * 60 * 60 * 1000);
      }
    },
    {
      regex: /([零一二两三四五六七八九十\d]+)天/i,
      getDate: (m) => {
        const days = chineseNumberToInt(m[1]);
        return days === null ? null : setTime(new Date(now.getTime() + days * 24 * 60 * 60 * 1000), 18);
      }
    },
    { regex: /上午(\d+)点?/i, getDate: (m) => setTime(now, parseInt(m[1], 10), 0, 0, 0) },
    { regex: /下午(\d+)点?/i, getDate: (m) => setTime(now, parseInt(m[1], 10) + 12, 0, 0, 0) },
    { regex: /下午/i, getDate: () => setTime(now, 17) }
  ];

  for (const p of patterns) {
    const match = lower.match(p.regex);
    if (match) {
      const date = p.getDate(match);
      if (date) {
        return date.toISOString();
      }
    }
  }

  return null;
}
