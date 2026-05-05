import { CommitmentStatus, SourceType } from './types.js';

export class CardGenerator {
  constructor(ledger) {
    this.ledger = ledger;
  }

  generatePostMeetingCard(commitments, meetingInfo = {}) {
    const { title = '会议承诺', time = new Date().toLocaleString('zh-CN'), participantCount = 0 } = meetingInfo;

    const pending = commitments.filter(c => c.status === CommitmentStatus.PENDING);
    const inProgress = commitments.filter(c => c.status === CommitmentStatus.IN_PROGRESS);
    const done = commitments.filter(c => c.status === CommitmentStatus.DONE);

    const highPriority = commitments.filter(c => this._isHighPriority(c.priority));
    const dueSoon = commitments.filter(c => {
      if (!c.deadline) return false;
      const diff = new Date(c.deadline) - new Date();
      return diff > 0 && diff < 24 * 60 * 60 * 1000;
    });

    const evidenceSummary = this._buildEvidenceSummary(commitments);

    return {
      card_type: 'card',
      header: {
        title: { tag: 'plain_text', content: `📋 ${title}` },
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
                { tag: 'markdown', content: `**📊 承诺总数**\n# ${commitments.length}` }
              ]
            },
            {
              tag: 'column',
              width: 'stretch',
              elements: [
                { tag: 'markdown', content: `**⏳ 执行中**\n# ${inProgress.length}` }
              ]
            },
            {
              tag: 'column',
              width: 'stretch',
              elements: [
                { tag: 'markdown', content: `**✅ 已完成**\n# ${done.length}` }
              ]
            },
            {
              tag: 'column',
              width: 'stretch',
              elements: [
                { tag: 'markdown', content: `**🔥 高优先级**\n# ${highPriority.length}` }
              ]
            }
          ]
        },
        { tag: 'hr' },
        {
          tag: 'markdown',
          content: `**📅 会议时间**: ${time}\n**👥 涉及人数**: ${participantCount}人`
        },
        { tag: 'hr' },
        {
          tag: 'markdown',
          content: '**📝 承诺详情**'
        },
        ...commitments.slice(0, 5).map(c => this._commitmentToMarkdown(c)),
        ...(commitments.length > 5 ? [{
          tag: 'markdown',
          content: `_...还有 ${commitments.length - 5} 项承诺_`
        }] : []),
        { tag: 'hr' },
        {
          tag: 'markdown',
          content: '**🔗 证据链摘要**'
        },
        ...evidenceSummary.slice(0, 3).map(e => ({
          tag: 'markdown',
          content: `• ${this._evidenceSourceLabel(e)}: ${e.quote.substring(0, 50)}...`
        })),
        {
          tag: 'note',
          elements: [
            { tag: 'plain_text', content: '由 FlowMate 自动生成' }
          ]
        }
      ]
    };
  }

  generateReminderCard(commitment) {
    const now = new Date();
    const deadline = new Date(commitment.deadline);
    const diffHours = Math.round((deadline - now) / (1000 * 60 * 60));
    const diffDays = Math.round(diffHours / 24);

    let urgency = 'blue';
    let urgencyText = '📅 ';
    if (diffHours < 2) {
      urgency = 'red';
      urgencyText = '🚨 紧急! ';
    } else if (diffHours < 24) {
      urgency = 'orange';
      urgencyText = '⚠️ 今日到期 ';
    } else if (diffDays <= 3) {
      urgency = 'yellow';
      urgencyText = '⏰ 临期 ';
    }

    const evidenceText = commitment.evidence && commitment.evidence.length > 0
      ? `\n\n**🔗 证据**: "${commitment.evidence[0].quote.substring(0, 80)}..."`
      : '';

    return {
      card_type: 'card',
      header: {
        title: { tag: 'plain_text', content: `${urgencyText}承诺提醒` },
        template: urgency
      },
      elements: [
        {
          tag: 'markdown',
          content: `**📌 ${commitment.title}**`
        },
        {
          tag: 'markdown',
          content: `**👤 负责人**: ${commitment.owner || '未指定'}\n**⏰ 截止时间**: ${commitment.deadline}\n**⏱️ 剩余时间**: ${diffHours}小时 (${diffDays}天)`
        },
        {
          tag: 'markdown',
          content: `**📊 状态**: ${this._statusText(commitment.status)}\n**🎯 置信度**: ${commitment.confidence}${evidenceText}`
        },
        { tag: 'hr' },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '✅ 标记完成' },
              type: 'primary'
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '⏸️ 延后一天' },
              type: 'default'
            }
          ]
        },
        {
          tag: 'note',
          elements: [
            { tag: 'plain_text', content: 'FlowMate 智能提醒' }
          ]
        }
      ]
    };
  }

  generateEveningReviewCard(stats) {
    const { date = new Date().toLocaleDateString('zh-CN'), pending = 0, done = 0, overdue = 0, newCommitments = 0 } = stats;

    const completionRate = pending + done > 0 ? Math.round((done / (pending + done)) * 100) : 0;

    let emoji = '📊';
    let message = '继续加油！';
    if (completionRate >= 80) {
      emoji = '🎉';
      message = '表现优秀！';
    } else if (completionRate >= 50) {
      emoji = '💪';
      message = '保持节奏！';
    } else if (completionRate >= 20) {
      emoji = '📈';
      message = '稳步推进！';
    } else if (pending > 10) {
      emoji = '🤔';
      message = '承诺过多，考虑精简';
    }

    return {
      card_type: 'card',
      header: {
        title: { tag: 'plain_text', content: `${emoji} 晚间复盘 - ${date}` },
        template: 'purple'
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
                { tag: 'markdown', content: `**📋 今日新增**\n# ${newCommitments}` }
              ]
            },
            {
              tag: 'column',
              width: 'stretch',
              elements: [
                { tag: 'markdown', content: `**✅ 已完成**\n# ${done}` }
              ]
            },
            {
              tag: 'column',
              width: 'stretch',
              elements: [
                { tag: 'markdown', content: `**⏳ 待完成**\n# ${pending}` }
              ]
            },
            {
              tag: 'column',
              width: 'stretch',
              elements: [
                { tag: 'markdown', content: `**🚨 逾期**\n# ${overdue}` }
              ]
            }
          ]
        },
        { tag: 'hr' },
        {
          tag: 'markdown',
          content: `**📊 完成率**: ${completionRate}%\n**💬 ${message}**`
        },
        { tag: 'hr' },
        {
          tag: 'markdown',
          content: '**💡 建议**'
        },
        {
          tag: 'markdown',
          content: this._generateSuggestion(stats)
        },
        {
          tag: 'note',
          elements: [
            { tag: 'plain_text', content: 'FlowMate 每日自动生成' }
          ]
        }
      ]
    };
  }

  generateCommitmentDetailCard(commitment) {
    const statusColors = {
      [CommitmentStatus.PENDING]: 'grey',
      [CommitmentStatus.IN_PROGRESS]: 'blue',
      [CommitmentStatus.CONFIRMED]: 'green',
      [CommitmentStatus.BLOCKED]: 'red',
      [CommitmentStatus.DONE]: 'purple'
    };

    return {
      card_type: 'card',
      header: {
        title: { tag: 'plain_text', content: `📌 承诺详情` },
        template: statusColors[commitment.status] || 'blue'
      },
      elements: [
        {
          tag: 'markdown',
          content: `**${commitment.title}**`
        },
        {
          tag: 'column_set',
          flex_mode: 'none',
          background_style: 'grey',
          columns: [
            {
              tag: 'column',
              width: 'stretch',
              elements: [
                { tag: 'markdown', content: `**👤** ${commitment.owner || '未指定'}` }
              ]
            },
            {
              tag: 'column',
              width: 'stretch',
              elements: [
                { tag: 'markdown', content: `**📊** ${this._statusText(commitment.status)}` }
              ]
            }
          ]
        },
        {
          tag: 'column_set',
          flex_mode: 'none',
          background_style: 'grey',
          columns: [
            {
              tag: 'column',
              width: 'stretch',
              elements: [
                { tag: 'markdown', content: `**⏰** ${commitment.deadline || '无期限'}` }
              ]
            },
            {
              tag: 'column',
              width: 'stretch',
              elements: [
                { tag: 'markdown', content: `**🎯** ${commitment.confidence || 'medium'}` }
              ]
            }
          ]
        },
        ...(commitment.priority ? [{
          tag: 'markdown',
          content: `**🔥 优先级**: ${commitment.priority}`
        }] : []),
        { tag: 'hr' },
        {
          tag: 'markdown',
          content: '**🔗 证据链**'
        },
        ...(commitment.evidence || []).map(e => ({
          tag: 'markdown',
          content: `> "${e.quote}"\n• 来源: ${this._evidenceSourceLabel(e)} • ${e.speaker || '未知'} • ${e.timestamp || ''}`
        })),
        { tag: 'hr' },
        {
          tag: 'note',
          elements: [
            { tag: 'plain_text', content: `FlowMate | ID: ${commitment.id}` }
          ]
        }
      ]
    };
  }

  _buildEvidenceSummary(commitments) {
    const evidenceMap = new Map();
    for (const c of commitments) {
      if (c.evidence) {
        for (const e of c.evidence) {
          const key = `${this._evidenceSourceLabel(e)}-${e.speaker}`;
          if (!evidenceMap.has(key)) {
            evidenceMap.set(key, e);
          }
        }
      }
    }
    return Array.from(evidenceMap.values());
  }

  _commitmentToMarkdown(c) {
    const statusIcon = {
      [CommitmentStatus.PENDING]: '⏳',
      [CommitmentStatus.IN_PROGRESS]: '🔄',
      [CommitmentStatus.CONFIRMED]: '✅',
      [CommitmentStatus.BLOCKED]: '🚫',
      [CommitmentStatus.DONE]: '🎉'
    }[c.status] || '📋';

    const deadline = c.deadline ? `\n⏰ ${c.deadline}` : '\n⏰ 无期限';
    const owner = c.owner ? ` | 👤 ${c.owner}` : '';

    return {
      tag: 'markdown',
      content: `${statusIcon} **${c.title}**${deadline}${owner}`
    };
  }

  _statusText(status) {
    const texts = {
      [CommitmentStatus.PENDING]: '待确认',
      [CommitmentStatus.IN_PROGRESS]: '进行中',
      [CommitmentStatus.CONFIRMED]: '已确认',
      [CommitmentStatus.BLOCKED]: '已阻塞',
      [CommitmentStatus.DONE]: '已完成'
    };
    return texts[status] || status;
  }

  _generateSuggestion(stats) {
    if (stats.overdue > 0) {
      return `• 你有 ${stats.overdue} 项承诺已逾期，建议优先处理`;
    }
    if (stats.pending > 15) {
      return `• 你的待完成承诺过多(${stats.pending}项)，建议评估是否可以精简或委托`;
    }
    if (stats.done === 0 && stats.pending > 0) {
      return `• 今天没有完成任何承诺，建议从最简单的开始`;
    }
    if (stats.newCommitments > 10) {
      return `• 今天新增了 ${stats.newCommitments} 项承诺，建议控制承诺数量`;
    }
    return '• 继续保持，当前节奏良好';
  }

  _isHighPriority(priority) {
    return priority === 'high' || priority === 'P0' || priority === 'P1';
  }

  _evidenceSourceLabel(evidence) {
    return evidence.sourceTitle || evidence.sourceType || '未知来源';
  }
}
