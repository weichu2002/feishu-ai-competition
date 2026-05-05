import { config, getMaskedApiKey } from './config.js';
import { createCommitment, createEvidence, CommitmentStatus, Confidence, SourceType, parseRelativeTime } from './types.js';

export class ModelClient {
  constructor() {
    this.apiKey = config.zai.apiKey;
    this.model = config.zai.model;
    this.fallbackModel = config.zai.fallbackModel;
    this.apiUrl = config.zai.apiUrl;
  }

  getMaskedKey() {
    return getMaskedApiKey();
  }

  buildMessages(prompt, systemPrompt = '') {
    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });
    return messages;
  }

  resolveCandidateModels() {
    return [...new Set([this.model, this.fallbackModel].map((item) => String(item || '').trim()).filter(Boolean))];
  }

  async requestCompletion(model, messages) {
    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.1
      })
    });

    const rawText = await response.text();
    if (!response.ok) {
      const error = new Error(`Model API error: ${response.status} - ${rawText}`);
      error.status = response.status;
      error.body = rawText;
      error.model = model;
      throw error;
    }

    const data = JSON.parse(rawText);
    return data.choices?.[0]?.message?.content || '';
  }

  shouldFallbackToNextModel(error) {
    const status = Number(error?.status || 0);
    const body = String(error?.body || error?.message || '');
    return status === 429 || status >= 500 || body.includes('"code":"1305"') || body.includes('访问量过大');
  }

  async complete(prompt, systemPrompt = '') {
    const messages = this.buildMessages(prompt, systemPrompt);
    const errors = [];

    for (const model of this.resolveCandidateModels()) {
      try {
        return await this.requestCompletion(model, messages);
      } catch (error) {
        errors.push(`[${model}] ${error.message}`);
        if (!this.shouldFallbackToNextModel(error)) {
          throw error;
        }
      }
    }

    throw new Error(errors.join(' | '));
  }

  async extractCommitments(utterances) {
    const systemPrompt = `你是 FlowMate 的承诺抽取助手。
你的任务是从给定的会议记录或群聊发言中，抽取其中包含的个人承诺。

定义：
- 承诺：某人对某个任务的明确保证，包含截止时间或完成标志
- 证据：承诺的原文引用，必须逐字来自原文

抽取规则：
1. 只抽取明确或较明确的承诺，普通讨论不抽取
2. evidence.quote 必须逐字来自原文，不许编造
3. 不确定的 owner 或 deadline 要标记为"待确认"，不许编造
4. 普通讨论（如"我觉得可以"、"好的"）不抽取为承诺
5. 低置信度承诺（如有"可能"、"也许"等）标记为 pending

输出格式：
只输出合法的 JSON 数组，不要有任何解释文字。格式如下：
[
  {
    "title": "承诺内容摘要（30字以内）",
    "owner": "负责人姓名",
    "deadlineText": "截止时间文本原文",
    "deadline": "ISO 8601 格式日期时间，或 null 表示待确认",
    "confidence": "high | medium | low",
    "status": "pending | confirmed | blocked | done",
    "riskReason": "风险原因，如果有的话",
    "evidence": {
      "quote": "原文逐字引用",
      "speaker": "发言人"
    }
  }
]

注意：
- 只输出 JSON，不要有 markdown 代码块标记
- 如果没有找到任何承诺，返回空数组 []
- 每条承诺必须有 evidence.quote`;

    const prompt = `请从以下发言记录中抽取所有承诺：

${utterances.map((u, i) => `${i + 1}. [${u.speaker}] ${u.text}`).join('\n')}

请逐条分析并抽取承诺。`;

    const response = await this.complete(prompt, systemPrompt);

    let jsonStr = response.trim();
    jsonStr = jsonStr.replace(/^```json\s*/i, '');
    jsonStr = jsonStr.replace(/^```\s*/i, '');
    jsonStr = jsonStr.replace(/\s*```$/i, '');

    try {
      const commitments = JSON.parse(jsonStr);
      return this.normalizeCommitments(commitments, utterances);
    } catch (e) {
      console.error('JSON parse failed:', e.message);
      console.error('Raw response:', response.substring(0, 500));
      throw e;
    }
  }

  normalizeCommitments(rawCommitments, utterances) {
    return rawCommitments.map(raw => {
      const sourceUtterance = this.findSourceUtterance(raw, utterances);
      const sourceType = this.mapSourceType(sourceUtterance?.sourceType);
      const deadlineText = raw.deadlineText || this.extractDeadlineText(raw.evidence?.quote || sourceUtterance?.text || raw.title);
      const deadline = this.normalizeDeadline(raw.deadline, deadlineText);
      const evidence = createEvidence({
        sourceType: sourceType,
        sourceTitle: sourceUtterance?.sourceTitle || '',
        sourceLink: sourceUtterance?.sourceLink || '',
        quote: raw.evidence?.quote || sourceUtterance?.text || raw.title,
        speaker: raw.evidence?.speaker || raw.owner || sourceUtterance?.speaker || 'Unknown',
        timestamp: sourceUtterance?.timestamp || new Date().toISOString()
      });

      return createCommitment({
        title: raw.title,
        owner: raw.owner || '待确认',
        deadlineText: deadlineText || '待确认',
        deadline: deadline,
        priority: raw.confidence === 'high' ? 'P1' : 'P2',
        status: this.normalizeStatus(raw.status, raw.riskReason),
        sourceType: sourceType,
        sourceTitle: sourceUtterance?.sourceTitle || '',
        sourceLink: sourceUtterance?.sourceLink || '',
        evidence: [evidence],
        confidence: raw.confidence || Confidence.MEDIUM,
        riskReason: raw.riskReason || ''
      });
    });
  }

  findSourceUtterance(raw, utterances) {
    if (!utterances?.length) {
      return null;
    }

    const speaker = raw.evidence?.speaker || raw.owner || '';
    const quote = raw.evidence?.quote || '';
    const title = raw.title || '';

    let bestUtterance = utterances[0];
    let bestScore = -1;

    for (const utterance of utterances) {
      let score = 0;
      const utteranceText = utterance.text || '';

      if (speaker && utterance.speaker === speaker) {
        score += 4;
      }

      if (quote) {
        if (utteranceText.includes(quote)) {
          score += 8;
        } else if (quote.includes(utteranceText)) {
          score += 6;
        }
      }

      if (title) {
        const titleText = this.normalizeText(title);
        const utteranceNormalized = this.normalizeText(utteranceText);
        if (titleText && utteranceNormalized.includes(titleText)) {
          score += 4;
        } else {
          score += this.calculateOverlapScore(titleText, utteranceNormalized);
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestUtterance = utterance;
      }
    }

    return bestUtterance;
  }

  normalizeText(text) {
    return (text || '')
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fff]/g, '');
  }

  calculateOverlapScore(a, b) {
    if (!a || !b) {
      return 0;
    }

    const chars = new Set(a.split(''));
    let score = 0;
    for (const char of chars) {
      if (b.includes(char)) {
        score += 0.2;
      }
    }
    return score;
  }

  mapSourceType(sourceType) {
    switch (sourceType) {
      case SourceType.CHAT:
      case 'chat':
        return SourceType.CHAT;
      case SourceType.DOCUMENT:
      case 'document':
        return SourceType.DOCUMENT;
      case SourceType.MINUTES:
      case 'minutes':
        return SourceType.MINUTES;
      default:
        return SourceType.MEETING;
    }
  }

  extractDeadlineText(text) {
    if (!text) {
      return '';
    }

    const patterns = [
      /明天上午前?/,
      /明天下午前?/,
      /今天下午前?/,
      /下周[一二三四五六日天]前?/,
      /本周[一二三四五六日天]前?/,
      /月底前?/,
      /会后/,
      /今晚/,
      /今天/,
      /明天/,
      /后天/,
      /下午/,
      /上午\d+点?/,
      /下午\d+点?/,
      /[零一二两三四五六七八九十\d]+小时/,
      /[零一二两三四五六七八九十\d]+天/
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        return match[0];
      }
    }

    return '';
  }

  normalizeDeadline(rawDeadline, deadlineText) {
    if (rawDeadline) {
      return rawDeadline;
    }

    if (!deadlineText || deadlineText === '待确认' || deadlineText === '会后') {
      return null;
    }

    return parseRelativeTime(deadlineText);
  }

  normalizeStatus(rawStatus, riskReason) {
    if (riskReason && (!rawStatus || rawStatus === CommitmentStatus.PENDING)) {
      return CommitmentStatus.BLOCKED;
    }

    if (rawStatus) {
      return rawStatus;
    }

    return CommitmentStatus.PENDING;
  }
}

export const modelClient = new ModelClient();
