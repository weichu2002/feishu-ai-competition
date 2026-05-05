import { larkCliJson } from './lark-cli.js';
import { config } from './config.js';

export const FLOWMATE_LEDGER_FIELDS = {
  id: '承诺ID',
  title: '承诺标题',
  owner: '负责人',
  ownerOpenId: '负责人OpenID',
  deadlineText: '截止时间文本',
  deadline: '标准截止时间',
  status: '状态',
  priority: '优先级',
  sourceType: '来源类型',
  sourceTitle: '来源标题',
  sourceLink: '来源链接',
  evidence: '证据原文',
  confidence: '置信度',
  nextAction: '下一步动作',
  riskReason: '风险原因',
  taskId: '飞书任务ID',
  calendarEventId: '飞书日程ID',
  calendarId: '飞书日历ID',
  sourceMessageId: '来源消息ID',
  sourceChatId: '来源聊天ID',
  sourceThreadId: '来源话题ID',
  rawMessageText: '承诺原文',
  conversationSummary: '上下文摘要',
  conversationContext: '对话上下文',
  dedupeKey: '去重指纹',
  sourceCollection: '来源集合',
  lastReminderAt: '最近提醒时间',
  reminderCount: '提醒次数',
  assignedAt: '分派时间',
  lastSyncedAt: '最近同步时间',
  createdAt: '创建时间',
  updatedAt: '更新时间'
};

const TASK_BOARD_FIELDS = {
  owner: '任务执行人',
  status: '进展',
  priority: '重要紧急程度',
  actualCompletionDate: '实际完成日期',
  summary: '任务情况总结',
  latestProgress: '最新进展记录',
  title: '任务描述',
  startDate: '开始日期',
  deadline: '预计完成日期'
};

const TASK_BOARD_STATUS = {
  pending: '待开始',
  in_progress: '进行中',
  confirmed: '进行中',
  blocked: '已停滞',
  done: '已完成'
};

const TASK_BOARD_PRIORITY = {
  P0: '重要紧急',
  P1: '重要紧急',
  P2: '重要不紧急',
  P3: '不紧急不重要'
};

const PERSONAL_LEDGER_VIEWS = [
  { name: '全部承诺', type: 'grid' },
  { name: '待处理', type: 'grid' },
  { name: '已完成', type: 'grid' },
  { name: '已阻塞', type: 'grid' }
];

const PERSONAL_DASHBOARD_NAME = 'FlowMate 个人驾驶舱';

export class FeishuWriter {
  constructor() {
    this.bitableAppToken = config.feishu.appToken || null;
    this.bitableTableId = config.feishu.tableId || null;
    this.taskId = config.feishu.taskId || null;
    this.schemaProfile = null;
    this.ensuredLedgerFields = false;
  }

  async syncCommitmentToBitable(commitment) {
    if (!this.bitableAppToken || !this.bitableTableId) {
      throw new Error('Bitable not configured');
    }

    const schema = await this.getSchemaProfile();
    await this.ensureFlowmateLedgerFields(schema);
    const existing = await this.findExistingBitableRecord(commitment, schema);

    if (existing?.recordId) {
      const existingTaskId = commitment.feishuTaskId || this.getExistingTaskId(existing, schema) || '';
      const result = await this.updateCommitmentInBitable(existing.recordId, {
        ...commitment,
        bitableRecordId: existing.recordId,
        feishuTaskId: existingTaskId
      }, schema);

      return {
        ...result,
        recordId: existing.recordId,
        existed: true,
        taskId: existingTaskId,
        fields: existing.fields
      };
    }

    const result = await larkCliJson([
      'base',
      '+record-upsert',
      '--as', 'user',
      '--base-token', this.bitableAppToken,
      '--table-id', this.bitableTableId,
      '--json', JSON.stringify(this.buildBitableFields(commitment, schema))
    ]);

    return {
      ...result,
      recordId: extractRecordId(result),
      existed: false,
      taskId: commitment.feishuTaskId || ''
    };
  }

  async updateCommitmentInBitable(recordId, updates, schema = null) {
    if (!this.bitableAppToken || !this.bitableTableId) {
      throw new Error('Bitable not configured');
    }

    const profile = schema || await this.getSchemaProfile();
    await this.ensureFlowmateLedgerFields(profile);

    return await larkCliJson([
      'base',
      '+record-upsert',
      '--as', 'user',
      '--base-token', this.bitableAppToken,
      '--table-id', this.bitableTableId,
      '--record-id', recordId,
      '--json', JSON.stringify(this.buildBitableFields(updates, profile, { partial: true }))
    ]);
  }

  async syncCommitmentsToTask(commitment) {
    if (!this.taskId) {
      throw new Error('Task not configured');
    }

    if (commitment.feishuTaskId) {
      return {
        ok: true,
        skipped: true,
        taskId: commitment.feishuTaskId
      };
    }

    const result = await larkCliJson([
      'task',
      'subtasks',
      'create',
      '--as', 'user',
      '--params', JSON.stringify({ task_guid: this.taskId }),
      '--data', JSON.stringify(this.buildTaskPayload(commitment))
    ]);

    return {
      ...result,
      taskId: findValue(result, ['guid', 'task_guid', 'taskId']) || ''
    };
  }

  async completeTask(taskId) {
    return await larkCliJson([
      'task',
      '+complete',
      '--as', 'user',
      '--task-id', taskId
    ]);
  }

  async updateTask(taskId, commitment) {
    if (!taskId) {
      return { ok: true, skipped: true };
    }

    return await larkCliJson([
      'task',
      '+update',
      '--as', 'user',
      '--task-id', taskId,
      '--summary', `[FlowMate] ${commitment.title}`,
      '--description', this.buildTaskDescription(commitment),
      ...(commitment.deadline ? ['--due', commitment.deadline] : [])
    ]);
  }

  async sendBotMessage(userOpenId, text) {
    if (!userOpenId || !text) {
      return {
        ok: true,
        skipped: true
      };
    }

    return await larkCliJson([
      'im',
      '+messages-send',
      '--as', 'bot',
      '--user-id', userOpenId,
      '--text', text
    ]);
  }

  async listBitableRecords() {
    if (!this.bitableAppToken || !this.bitableTableId) {
      throw new Error('Bitable not configured');
    }

    return await larkCliJson([
      'base',
      '+record-list',
      '--as', 'user',
      '--base-token', this.bitableAppToken,
      '--table-id', this.bitableTableId,
      '--format', 'json'
    ]);
  }

  async listCalendarAgenda(start, end) {
    return await larkCliJson([
      'calendar',
      '+agenda',
      '--as', 'user',
      '--start', start,
      '--end', end
    ]);
  }

  async listBitableFields() {
    if (!this.bitableAppToken || !this.bitableTableId) {
      throw new Error('Bitable not configured');
    }

    return await larkCliJson([
      'base',
      '+field-list',
      '--as', 'user',
      '--base-token', this.bitableAppToken,
      '--table-id', this.bitableTableId
    ]);
  }

  async listBitableViews() {
    if (!this.bitableAppToken || !this.bitableTableId) {
      throw new Error('Bitable not configured');
    }

    return await larkCliJson([
      'base',
      '+view-list',
      '--as', 'user',
      '--base-token', this.bitableAppToken,
      '--table-id', this.bitableTableId
    ]);
  }

  async getSchemaProfile() {
    if (this.schemaProfile) {
      return this.schemaProfile;
    }

    const table = await larkCliJson([
      'base',
      '+table-get',
      '--as', 'user',
      '--base-token', this.bitableAppToken,
      '--table-id', this.bitableTableId
    ]);

    const tableInfo = table?.data?.table || {};
    const fieldNames = new Set((table?.data?.fields || []).map((field) => field.name));

    if (fieldNames.has(TASK_BOARD_FIELDS.title) && fieldNames.has(TASK_BOARD_FIELDS.status)) {
      this.schemaProfile = {
        name: 'task-board',
        primaryField: tableInfo.primary_field || TASK_BOARD_FIELDS.title
      };
      return this.schemaProfile;
    }

    this.schemaProfile = {
      name: 'flowmate-ledger',
      primaryField: FLOWMATE_LEDGER_FIELDS.title
    };
    return this.schemaProfile;
  }

  async ensurePersonalLedgerViews() {
    const viewsResult = await this.listBitableViews();
    const existingViews = Array.isArray(viewsResult?.data?.views)
      ? viewsResult.data.views
      : (Array.isArray(viewsResult?.data?.items) ? viewsResult.data.items : (Array.isArray(viewsResult?.data) ? viewsResult.data : []));
    const fieldResult = await this.listBitableFields();
    const fields = Array.isArray(fieldResult?.data?.fields)
      ? fieldResult.data.fields
      : (Array.isArray(fieldResult?.data?.items) ? fieldResult.data.items : (Array.isArray(fieldResult?.data) ? fieldResult.data : []));
    const fieldMap = new Map(fields.map((field) => [field.name, field.field_id || field.id || '']));
    const ensured = [];

    for (const target of PERSONAL_LEDGER_VIEWS) {
      let view = existingViews.find((item) => item?.view_name === target.name || item?.name === target.name);
      if (!view) {
        const created = await larkCliJson([
          'base',
          '+view-create',
          '--as', 'user',
          '--base-token', this.bitableAppToken,
          '--table-id', this.bitableTableId,
          '--json', JSON.stringify({ name: target.name, type: target.type })
        ]);
        view = created?.data?.views?.[0] || created?.data?.view || created?.data || {};
      }

      const viewId = view.view_id || view.id || '';
      if (viewId) {
        await this.tryConfigurePersonalView(viewId, target.name, fieldMap);
      }

      ensured.push({
        name: target.name,
        viewId
      });
    }

    return {
      ok: true,
      ensured
    };
  }

  async tryConfigurePersonalView(viewId, viewName, fieldMap) {
    const statusFieldId = fieldMap.get(TASK_BOARD_FIELDS.status) || fieldMap.get(FLOWMATE_LEDGER_FIELDS.status) || '';
    const deadlineFieldId = fieldMap.get(TASK_BOARD_FIELDS.deadline) || fieldMap.get(FLOWMATE_LEDGER_FIELDS.deadline) || '';
    const updatedFieldId = fieldMap.get(FLOWMATE_LEDGER_FIELDS.updatedAt) || '';

    if (statusFieldId && (viewName === '待处理' || viewName === '已完成' || viewName === '已阻塞')) {
      const statusValue =
        viewName === '待处理' ? (TASK_BOARD_STATUS.pending || 'todo') :
        viewName === '已完成' ? (TASK_BOARD_STATUS.done || 'done') :
        (TASK_BOARD_STATUS.blocked || 'blocked');

      try {
        await larkCliJson([
          'base',
          '+view-set-filter',
          '--as', 'user',
          '--base-token', this.bitableAppToken,
          '--table-id', this.bitableTableId,
          '--view-id', viewId,
          '--json', JSON.stringify({
            logic: 'and',
            conditions: [[statusFieldId, '==', statusValue]]
          })
        ]);
      } catch {
        // Best effort only.
      }
    }

    const sortField = deadlineFieldId || updatedFieldId;
    if (sortField) {
      try {
        await larkCliJson([
          'base',
          '+view-set-sort',
          '--as', 'user',
          '--base-token', this.bitableAppToken,
          '--table-id', this.bitableTableId,
          '--view-id', viewId,
          '--json', JSON.stringify({
            sort_config: [{ field: sortField, desc: false }]
          })
        ]);
      } catch {
        // Best effort only.
      }
    }
  }

  async ensurePersonalLedgerDashboard() {
    const result = await larkCliJson([
      'base',
      '+dashboard-list',
      '--as', 'user',
      '--base-token', this.bitableAppToken
    ]);
    const dashboards = Array.isArray(result?.data?.items) ? result.data.items : (Array.isArray(result?.data) ? result.data : []);
    const existing = dashboards.find((item) => item?.name === PERSONAL_DASHBOARD_NAME);
    if (existing) {
      return {
        ok: true,
        existed: true,
        dashboardId: existing.dashboard_id || existing.id || ''
      };
    }

    const created = await larkCliJson([
      'base',
      '+dashboard-create',
      '--as', 'user',
      '--base-token', this.bitableAppToken,
      '--name', PERSONAL_DASHBOARD_NAME
    ]);

    return {
      ok: true,
      existed: false,
      dashboardId: findValue(created, ['dashboard_id', 'id']) || ''
    };
  }

  async ensureFlowmateLedgerFields(schema = null) {
    const profile = schema || await this.getSchemaProfile();
    if (profile?.name !== 'flowmate-ledger' || this.ensuredLedgerFields) {
      return;
    }

    const fieldResult = await this.listBitableFields();
    const fields = Array.isArray(fieldResult?.data?.fields)
      ? fieldResult.data.fields
      : (Array.isArray(fieldResult?.data?.items) ? fieldResult.data.items : (Array.isArray(fieldResult?.data) ? fieldResult.data : []));
    const existingNames = new Set(fields.map((field) => field?.name).filter(Boolean));
    const requiredFields = [
      FLOWMATE_LEDGER_FIELDS.calendarEventId,
      FLOWMATE_LEDGER_FIELDS.calendarId,
      FLOWMATE_LEDGER_FIELDS.sourceMessageId,
      FLOWMATE_LEDGER_FIELDS.sourceChatId,
      FLOWMATE_LEDGER_FIELDS.sourceThreadId,
      FLOWMATE_LEDGER_FIELDS.rawMessageText,
      FLOWMATE_LEDGER_FIELDS.conversationSummary,
      FLOWMATE_LEDGER_FIELDS.conversationContext,
      FLOWMATE_LEDGER_FIELDS.dedupeKey,
      FLOWMATE_LEDGER_FIELDS.sourceCollection,
      FLOWMATE_LEDGER_FIELDS.lastReminderAt,
      FLOWMATE_LEDGER_FIELDS.reminderCount,
      FLOWMATE_LEDGER_FIELDS.assignedAt,
      FLOWMATE_LEDGER_FIELDS.lastSyncedAt
    ];

    for (const fieldName of requiredFields) {
      if (existingNames.has(fieldName)) {
        continue;
      }

      await larkCliJson([
        'base',
        '+field-create',
        '--as', 'user',
        '--base-token', this.bitableAppToken,
        '--table-id', this.bitableTableId,
        '--json', JSON.stringify({
          name: fieldName,
          type: 'text'
        })
      ]);
    }

    this.ensuredLedgerFields = true;
  }

  async findExistingBitableRecord(commitment, schema = null) {
    const profile = schema || await this.getSchemaProfile();
    const result = await this.listBitableRecords();
    const records = this.normalizeBitableRecords(result);

    if (profile.name === 'flowmate-ledger') {
      if (commitment.sourceMessageId) {
        const exactSourceMessage = records.find((record) =>
          record.fields[FLOWMATE_LEDGER_FIELDS.sourceMessageId] === commitment.sourceMessageId
        );
        if (exactSourceMessage) {
          return exactSourceMessage;
        }
      }

      if (commitment.dedupeKey) {
        const exactDedupe = records.find((record) =>
          record.fields[FLOWMATE_LEDGER_FIELDS.dedupeKey] === commitment.dedupeKey
        );
        if (exactDedupe) {
          return exactDedupe;
        }
      }

      const exactId = records.find((record) => record.fields[FLOWMATE_LEDGER_FIELDS.id] === commitment.id);
      if (exactId) {
        return exactId;
      }

      return records.find((record) =>
        record.fields[FLOWMATE_LEDGER_FIELDS.title] === commitment.title &&
        record.fields[FLOWMATE_LEDGER_FIELDS.owner] === commitment.owner
      ) || null;
    }

    return records.find((record) => {
      if (record.fields[TASK_BOARD_FIELDS.title] !== commitment.title) {
        return false;
      }

      const owners = record.rawFields[TASK_BOARD_FIELDS.owner];
      if (!commitment.owner && !commitment.ownerOpenId) {
        return true;
      }

      return this.matchTaskBoardOwner(owners, commitment);
    }) || null;
  }

  normalizeBitableRecords(result) {
    const fields = result?.data?.fields || [];
    const rows = result?.data?.data || [];
    const recordIds = result?.data?.record_id_list || [];

    return rows.map((row, index) => {
      const rawFields = {};
      const normalizedFields = {};

      fields.forEach((field, fieldIndex) => {
        rawFields[field] = row[fieldIndex];
        normalizedFields[field] = this.normalizeBitableCellValue(row[fieldIndex]);
      });

      return {
        recordId: recordIds[index] || '',
        rawFields,
        fields: normalizedFields
      };
    });
  }

  normalizeBitableCellValue(value) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        return '';
      }

      if (typeof value[0] === 'string') {
        return value.join('\n');
      }

      if (typeof value[0] === 'object') {
        return value
          .map((item) => item?.name || item?.id || '')
          .filter(Boolean)
          .join('\n');
      }
    }

    return value ?? '';
  }

  matchTaskBoardOwner(rawOwners, commitment) {
    if (!commitment.ownerOpenId) {
      if (!Array.isArray(rawOwners) || rawOwners.length === 0) {
        return true;
      }

      if (!commitment.owner) {
        return true;
      }

      return rawOwners.some((owner) => owner?.name === commitment.owner);
    }

    if (!Array.isArray(rawOwners) || rawOwners.length === 0) {
      return !commitment.owner && !commitment.ownerOpenId;
    }

    return rawOwners.some((owner) => {
      if (!owner || typeof owner !== 'object') {
        return false;
      }

      if (commitment.ownerOpenId && owner.id === commitment.ownerOpenId) {
        return true;
      }

      return Boolean(commitment.owner) && owner.name === commitment.owner;
    });
  }

  getExistingTaskId(existing, schema) {
    if (schema.name === 'flowmate-ledger') {
      return existing.fields[FLOWMATE_LEDGER_FIELDS.taskId] || '';
    }

    const summary = existing.fields[TASK_BOARD_FIELDS.summary] || '';
    const match = summary.match(/飞书任务ID[:：]\s*([a-z0-9-]+)/iu);
    return match?.[1] || '';
  }

  buildBitableFields(commitment, schema, { partial = false } = {}) {
    if (schema.name === 'task-board') {
      return this.buildTaskBoardFields(commitment, partial);
    }

    return this.buildFlowmateLedgerFields(commitment, partial);
  }

  buildFlowmateLedgerFields(commitment, partial) {
    const fields = {};
    const evidenceText = this.buildEvidenceText(commitment);

    this.assignField(fields, FLOWMATE_LEDGER_FIELDS.id, commitment.id, partial);
    this.assignField(fields, FLOWMATE_LEDGER_FIELDS.title, commitment.title, partial);
    this.assignField(fields, FLOWMATE_LEDGER_FIELDS.owner, commitment.owner, partial);
    this.assignField(fields, FLOWMATE_LEDGER_FIELDS.ownerOpenId, commitment.ownerOpenId, partial);
    this.assignField(fields, FLOWMATE_LEDGER_FIELDS.deadlineText, commitment.deadlineText, partial);
    this.assignField(fields, FLOWMATE_LEDGER_FIELDS.deadline, this.toTimestampString(commitment.deadline), partial);
    this.assignField(fields, FLOWMATE_LEDGER_FIELDS.status, this.mapLedgerStatus(commitment.status), partial);
    this.assignField(fields, FLOWMATE_LEDGER_FIELDS.priority, this.normalizePriority(commitment.priority), partial);
    this.assignField(fields, FLOWMATE_LEDGER_FIELDS.sourceType, this.getCommitmentSource(commitment), partial);
    this.assignField(fields, FLOWMATE_LEDGER_FIELDS.sourceTitle, commitment.sourceTitle, partial);
    this.assignField(fields, FLOWMATE_LEDGER_FIELDS.sourceLink, commitment.sourceLink, partial);
    this.assignField(fields, FLOWMATE_LEDGER_FIELDS.evidence, evidenceText, partial);
    this.assignField(fields, FLOWMATE_LEDGER_FIELDS.confidence, commitment.confidence, partial);
    this.assignField(fields, FLOWMATE_LEDGER_FIELDS.nextAction, commitment.nextAction, partial);
    this.assignField(fields, FLOWMATE_LEDGER_FIELDS.riskReason, commitment.riskReason, partial);
    this.assignField(fields, FLOWMATE_LEDGER_FIELDS.taskId, commitment.feishuTaskId, partial);
    this.assignField(fields, FLOWMATE_LEDGER_FIELDS.calendarEventId, commitment.calendarEventId, partial);
    this.assignField(fields, FLOWMATE_LEDGER_FIELDS.calendarId, commitment.calendarId, partial);
    this.assignField(fields, FLOWMATE_LEDGER_FIELDS.sourceMessageId, commitment.sourceMessageId, partial);
    this.assignField(fields, FLOWMATE_LEDGER_FIELDS.sourceChatId, commitment.sourceChatId, partial);
    this.assignField(fields, FLOWMATE_LEDGER_FIELDS.sourceThreadId, commitment.sourceThreadId, partial);
    this.assignField(fields, FLOWMATE_LEDGER_FIELDS.rawMessageText, commitment.rawMessageText, partial);
    this.assignField(fields, FLOWMATE_LEDGER_FIELDS.conversationSummary, commitment.conversationSummary, partial);
    this.assignField(fields, FLOWMATE_LEDGER_FIELDS.conversationContext, commitment.conversationContext, partial);
    this.assignField(fields, FLOWMATE_LEDGER_FIELDS.dedupeKey, commitment.dedupeKey, partial);
    this.assignField(fields, FLOWMATE_LEDGER_FIELDS.sourceCollection, commitment.sourceCollection, partial);
    this.assignField(fields, FLOWMATE_LEDGER_FIELDS.lastReminderAt, this.toTimestampString(commitment.lastReminderAt), partial);
    this.assignField(fields, FLOWMATE_LEDGER_FIELDS.reminderCount, commitment.reminderCount, partial);
    this.assignField(fields, FLOWMATE_LEDGER_FIELDS.assignedAt, this.toTimestampString(commitment.assignedAt), partial);
    this.assignField(fields, FLOWMATE_LEDGER_FIELDS.lastSyncedAt, this.toTimestampString(commitment.lastSyncedAt), partial);
    this.assignField(fields, FLOWMATE_LEDGER_FIELDS.createdAt, this.toTimestampString(commitment.createdAt), partial);
    this.assignField(fields, FLOWMATE_LEDGER_FIELDS.updatedAt, this.toTimestampString(commitment.updatedAt || new Date().toISOString()), partial);

    return fields;
  }

  buildTaskBoardFields(commitment, partial) {
    const fields = {};
    const now = new Date().toISOString();

    this.assignField(fields, TASK_BOARD_FIELDS.title, commitment.title, partial);

    if (commitment.ownerOpenId) {
      this.assignField(fields, TASK_BOARD_FIELDS.owner, [commitment.ownerOpenId], partial);
    }

    this.assignField(fields, TASK_BOARD_FIELDS.status, this.mapTaskBoardStatus(commitment.status), partial);
    this.assignField(fields, TASK_BOARD_FIELDS.priority, this.mapTaskBoardPriority(commitment.priority), partial);
    this.assignField(fields, TASK_BOARD_FIELDS.deadline, this.toBitableDateString(commitment.deadline), partial);
    this.assignField(fields, TASK_BOARD_FIELDS.summary, this.buildTaskBoardSummary(commitment), partial);
    this.assignField(fields, TASK_BOARD_FIELDS.latestProgress, this.buildTaskBoardProgress(commitment), partial);

    if (!partial) {
      this.assignField(fields, TASK_BOARD_FIELDS.startDate, this.toBitableDateString(commitment.createdAt || now), false);
    }

    if (commitment.status === 'done') {
      this.assignField(fields, TASK_BOARD_FIELDS.actualCompletionDate, this.toBitableDateString(commitment.updatedAt || now), partial);
    }

    return fields;
  }

  assignField(fields, name, value, partial) {
    if (value === undefined) {
      return;
    }

    if (partial && value === null) {
      return;
    }

    if (value === '') {
      return;
    }

    if (Array.isArray(value) && value.length === 0) {
      return;
    }

    fields[name] = value;
  }

  buildTaskPayload(commitment) {
    const payload = {
      summary: `[FlowMate] ${commitment.title}`,
      description: this.buildTaskDescription(commitment)
    };

    if (commitment.deadline) {
      payload.due = {
        timestamp: this.toTimestampString(commitment.deadline),
        is_all_day: false
      };
    }

    if (commitment.ownerOpenId) {
      payload.members = [{
        id: commitment.ownerOpenId,
        role: 'assignee',
        type: 'user'
      }];
    }

    return payload;
  }

  async createCalendarReminder(commitment) {
    if (!commitment?.deadline) {
      return {
        ok: true,
        skipped: true,
        reason: 'no_deadline',
        eventId: ''
      };
    }

    const { start, end } = this.buildCalendarTimeRange(commitment.deadline);
    const result = await larkCliJson([
      'calendar',
      '+create',
      '--as', 'user',
      '--summary', `[FlowMate] ${commitment.title}`,
      '--description', this.buildCalendarDescription(commitment),
      '--start', start,
      '--end', end
    ]);

    const eventId = findValue(result, ['event_id', 'eventId', 'id']) || '';
    let calendarId = findValue(result, ['calendar_id', 'calendarId', 'organizer_calendar_id']) || '';
    if (eventId && !calendarId) {
      const resolved = await this.findExistingCalendarReminder(commitment);
      calendarId = resolved?.calendarId || '';
    }

    return {
      ...result,
      eventId,
      calendarId
    };
  }

  async ensureCalendarReminder(commitment) {
    if (!commitment?.deadline) {
      return {
        ok: true,
        skipped: true,
        reason: 'no_deadline',
        eventId: ''
      };
    }

    const existing = await this.findExistingCalendarReminder(commitment);
    if (existing?.eventId) {
      return {
        ok: true,
        skipped: true,
        existed: true,
        eventId: existing.eventId,
        calendarId: existing.calendarId || ''
      };
    }

    return await this.createCalendarReminder(commitment);
  }

  async updateCalendarEvent(calendarId, eventId, commitment) {
    if (!calendarId || !eventId) {
      return { ok: true, skipped: true };
    }

    const { start, end } = this.buildCalendarTimeRange(commitment.deadline || new Date().toISOString());
    return await larkCliJson([
      'calendar',
      '+update',
      '--as', 'user',
      '--calendar-id', calendarId,
      '--event-id', eventId,
      '--summary', `[FlowMate] ${commitment.title}`,
      '--description', this.buildCalendarDescription(commitment),
      '--start', start,
      '--end', end
    ]);
  }

  async deleteBitableRecord(recordId) {
    if (!recordId) {
      return { ok: true, skipped: true };
    }

    return await larkCliJson([
      'base',
      '+record-delete',
      '--as', 'user',
      '--base-token', this.bitableAppToken,
      '--table-id', this.bitableTableId,
      '--record-id', recordId,
      '--yes'
    ]);
  }

  async deleteTask(taskId) {
    if (!taskId) {
      return { ok: true, skipped: true };
    }

    return await larkCliJson([
      'task',
      'tasks',
      'delete',
      '--as', 'user',
      '--params', JSON.stringify({ task_guid: taskId }),
      '--yes'
    ]);
  }

  async deleteCalendarEvent(calendarId, eventId) {
    if (!calendarId || !eventId) {
      return { ok: true, skipped: true };
    }

    return await larkCliJson([
      'calendar',
      'events',
      'delete',
      '--as', 'user',
      '--params', JSON.stringify({
        calendar_id: calendarId,
        event_id: eventId
      }),
      '--yes'
    ]);
  }

  async getTask(taskId) {
    if (!taskId) {
      return null;
    }

    return await larkCliJson([
      'task',
      'tasks',
      'get',
      '--as', 'user',
      '--params', JSON.stringify({
        task_guid: taskId,
        user_id_type: 'open_id'
      })
    ]);
  }

  async getCalendarEvent(calendarId, eventId) {
    if (!calendarId || !eventId) {
      return null;
    }

    return await larkCliJson([
      'calendar',
      'events',
      'get',
      '--as', 'user',
      '--params', JSON.stringify({
        calendar_id: calendarId,
        event_id: eventId,
        user_id_type: 'open_id'
      })
    ]);
  }

  buildEvidenceText(commitment) {
    return commitment.evidence?.map((evidence) => evidence.quote).join('\n') || '';
  }

  async findExistingCalendarReminder(commitment) {
    if (!commitment?.deadline) {
      return null;
    }

    const due = new Date(commitment.deadline);
    if (Number.isNaN(due.getTime())) {
      return null;
    }

    const start = new Date(due.getTime() - 24 * 60 * 60 * 1000);
    const end = new Date(due.getTime() + 24 * 60 * 60 * 1000);
    const agenda = await this.listCalendarAgenda(this.toIsoWithOffset(start), this.toIsoWithOffset(end));
    const events = Array.isArray(agenda?.data) ? agenda.data : [];
    const targetSummary = `[FlowMate] ${commitment.title}`;

    const matched = events.find((event) => event?.summary === targetSummary);
    if (!matched) {
      return null;
    }

    return {
      eventId: matched.event_id || matched.eventId || '',
      summary: matched.summary || '',
      calendarId: matched.calendar_id || matched.organizer_calendar_id || matched.calendarId || ''
    };
  }

  async syncLinkedStatuses() {
    const schema = await this.getSchemaProfile();
    const result = await this.listBitableRecords();
    const records = this.normalizeBitableRecords(result);
    const commitments = records.map((record) => this.buildCommitmentFromRecord(record, schema));
    const updates = [];

    for (const commitment of commitments) {
      let changed = false;
      const next = { ...commitment };

      if (commitment.feishuTaskId) {
        try {
          const task = await this.getTask(commitment.feishuTaskId);
          const taskInfo = task?.data?.task || task?.task || {};
          const mapped = this.mapExternalTaskStatus(taskInfo.status);
          if (mapped && mapped !== next.status) {
            next.status = mapped;
            changed = true;
          }
        } catch {
          // ignore single task failures
        }
      }

      if (commitment.deadline) {
        try {
          const event = await this.findExistingCalendarReminder(commitment);
          if (event?.eventId && event?.calendarId) {
            const detail = await this.getCalendarEvent(event.calendarId, event.eventId);
            const eventInfo = detail?.data?.event || detail?.event || {};
            const mapped = this.mapCalendarEventStatus(eventInfo.status);
            if (mapped && mapped !== next.status) {
              next.status = mapped;
              changed = true;
            }

            const endTimestamp = Number(eventInfo?.end_time?.timestamp || 0);
            if (endTimestamp) {
              const newDeadline = new Date(endTimestamp * 1000).toISOString();
              if (newDeadline !== next.deadline) {
                next.deadline = newDeadline;
                changed = true;
              }
            }
          }
        } catch {
          // ignore single event failures
        }
      }

      if (changed && commitment.bitableRecordId) {
        await this.updateCommitmentInBitable(commitment.bitableRecordId, {
          ...next,
          updatedAt: new Date().toISOString()
        }, schema);
        updates.push({
          id: commitment.id,
          title: commitment.title,
          recordId: commitment.bitableRecordId,
          status: next.status,
          deadline: next.deadline || ''
        });
      }
    }

    return {
      ok: true,
      updatedCount: updates.length,
      updates
    };
  }

  buildCommitmentFromRecord(record, schema) {
    if (schema?.name === 'task-board') {
      const rawOwners = Array.isArray(record.rawFields[TASK_BOARD_FIELDS.owner]) ? record.rawFields[TASK_BOARD_FIELDS.owner] : [];
      const firstOwner = rawOwners[0] || {};
      return {
        id: record.recordId,
        title: record.fields[TASK_BOARD_FIELDS.title] || '',
        owner: firstOwner.name || '',
        ownerOpenId: firstOwner.id || '',
        deadlineText: '',
        deadline: parseTaskBoardDeadline(record.fields[TASK_BOARD_FIELDS.deadline]),
        priority: this.reverseTaskBoardPriority(record.fields[TASK_BOARD_FIELDS.priority]),
        status: this.reverseTaskBoardStatus(record.fields[TASK_BOARD_FIELDS.status]),
        sourceType: 'chat',
        sourceTitle: '',
        sourceLink: '',
        evidence: [],
        confidence: 'medium',
        nextAction: '',
        riskReason: '',
        feishuTaskId: this.getExistingTaskId(record, schema),
        calendarEventId: '',
        calendarId: '',
        sourceMessageId: '',
        sourceChatId: '',
        sourceThreadId: '',
        rawMessageText: '',
        conversationSummary: '',
        conversationContext: '',
        bitableRecordId: record.recordId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    }

    return {
      id: record.fields[FLOWMATE_LEDGER_FIELDS.id] || record.recordId || '',
      title: record.fields[FLOWMATE_LEDGER_FIELDS.title] || '',
      owner: record.fields[FLOWMATE_LEDGER_FIELDS.owner] || '',
      ownerOpenId: record.fields[FLOWMATE_LEDGER_FIELDS.ownerOpenId] || '',
      deadlineText: record.fields[FLOWMATE_LEDGER_FIELDS.deadlineText] || '',
      deadline: parseLedgerDeadline(record.fields[FLOWMATE_LEDGER_FIELDS.deadline]),
      priority: this.normalizePriority(record.fields[FLOWMATE_LEDGER_FIELDS.priority]),
      status: record.fields[FLOWMATE_LEDGER_FIELDS.status] || 'pending',
      sourceType: record.fields[FLOWMATE_LEDGER_FIELDS.sourceType] || 'chat',
      sourceTitle: record.fields[FLOWMATE_LEDGER_FIELDS.sourceTitle] || '',
      sourceLink: record.fields[FLOWMATE_LEDGER_FIELDS.sourceLink] || '',
      evidence: [],
      confidence: record.fields[FLOWMATE_LEDGER_FIELDS.confidence] || 'medium',
      nextAction: record.fields[FLOWMATE_LEDGER_FIELDS.nextAction] || '',
      riskReason: record.fields[FLOWMATE_LEDGER_FIELDS.riskReason] || '',
      feishuTaskId: record.fields[FLOWMATE_LEDGER_FIELDS.taskId] || '',
      calendarEventId: record.fields[FLOWMATE_LEDGER_FIELDS.calendarEventId] || '',
      calendarId: record.fields[FLOWMATE_LEDGER_FIELDS.calendarId] || '',
      sourceMessageId: record.fields[FLOWMATE_LEDGER_FIELDS.sourceMessageId] || '',
      sourceChatId: record.fields[FLOWMATE_LEDGER_FIELDS.sourceChatId] || '',
      sourceThreadId: record.fields[FLOWMATE_LEDGER_FIELDS.sourceThreadId] || '',
      rawMessageText: record.fields[FLOWMATE_LEDGER_FIELDS.rawMessageText] || '',
      conversationSummary: record.fields[FLOWMATE_LEDGER_FIELDS.conversationSummary] || '',
      conversationContext: record.fields[FLOWMATE_LEDGER_FIELDS.conversationContext] || '',
      dedupeKey: record.fields[FLOWMATE_LEDGER_FIELDS.dedupeKey] || '',
      sourceCollection: record.fields[FLOWMATE_LEDGER_FIELDS.sourceCollection] || '',
      lastReminderAt: parseLedgerDeadline(record.fields[FLOWMATE_LEDGER_FIELDS.lastReminderAt]) || null,
      reminderCount: Number(record.fields[FLOWMATE_LEDGER_FIELDS.reminderCount] || 0),
      assignedAt: parseLedgerDeadline(record.fields[FLOWMATE_LEDGER_FIELDS.assignedAt]) || null,
      lastSyncedAt: parseLedgerDeadline(record.fields[FLOWMATE_LEDGER_FIELDS.lastSyncedAt]) || null,
      bitableRecordId: record.recordId,
      createdAt: parseLedgerDeadline(record.fields[FLOWMATE_LEDGER_FIELDS.createdAt]) || new Date().toISOString(),
      updatedAt: parseLedgerDeadline(record.fields[FLOWMATE_LEDGER_FIELDS.updatedAt]) || new Date().toISOString()
    };
  }

  buildTaskBoardSummary(commitment) {
    const parts = [
      `负责人：${commitment.owner || '未识别'}`,
      `状态：${this.mapTaskBoardStatus(commitment.status)}`,
      `优先级：${this.mapTaskBoardPriority(commitment.priority)}`
    ];

    if (commitment.deadlineText) {
      parts.push(`截止：${commitment.deadlineText}`);
    }

    if (commitment.sourceTitle) {
      parts.push(`来源：${commitment.sourceTitle}`);
    }

    if (commitment.riskReason) {
      parts.push(`风险：${commitment.riskReason}`);
    }

    if (commitment.conversationSummary) {
      parts.push(`上下文：${commitment.conversationSummary}`);
    }

    if (commitment.feishuTaskId) {
      parts.push(`飞书任务ID：${commitment.feishuTaskId}`);
    }

    return parts.join('\n');
  }

  buildTaskBoardProgress(commitment) {
    const evidence = this.buildEvidenceText(commitment);
    const lines = [];

    if (commitment.nextAction) {
      lines.push(`下一步：${commitment.nextAction}`);
    }

    if (evidence) {
      lines.push(`证据：${evidence}`);
    }

    const contextSnippet = this.truncateText(commitment.conversationContext, 500);
    if (contextSnippet) {
      lines.push(`上下文：${contextSnippet}`);
    }

    return lines.join('\n');
  }

  buildCalendarDescription(commitment) {
    const lines = [
      'FlowMate 承诺提醒',
      `事项：${commitment.title}`,
      `负责人：${commitment.owner || '未识别'}`,
      commitment.deadlineText ? `截止：${commitment.deadlineText}` : '',
      commitment.sourceTitle ? `来源：${commitment.sourceTitle}` : '',
      commitment.evidence?.[0]?.quote ? `证据：${commitment.evidence[0].quote}` : '',
      commitment.conversationSummary ? `上下文：${commitment.conversationSummary}` : '',
      this.truncateText(commitment.conversationContext, 800) ? `对话信息：${this.truncateText(commitment.conversationContext, 800)}` : ''
    ].filter(Boolean);

    return lines.join('\n');
  }

  buildCalendarTimeRange(deadline) {
    const due = new Date(deadline);
    const start = new Date(due.getTime() - 30 * 60 * 1000);
    return {
      start: this.toIsoWithOffset(start),
      end: this.toIsoWithOffset(due)
    };
  }

  buildCalendarTimestampRange(deadline) {
    const due = new Date(deadline);
    const start = new Date(due.getTime() - 30 * 60 * 1000);
    return {
      start: this.toCalendarApiTime(start),
      end: this.toCalendarApiTime(due)
    };
  }

  mapLedgerStatus(status) {
    const statusMap = {
      pending: 'pending',
      in_progress: 'in_progress',
      confirmed: 'confirmed',
      blocked: 'blocked',
      done: 'done'
    };

    return statusMap[status] || status || 'pending';
  }

  mapTaskBoardStatus(status) {
    return TASK_BOARD_STATUS[status] || TASK_BOARD_STATUS.pending;
  }

  mapTaskBoardPriority(priority) {
    return TASK_BOARD_PRIORITY[this.normalizePriority(priority)] || TASK_BOARD_PRIORITY.P2;
  }

  reverseTaskBoardPriority(priority) {
    const matched = Object.entries(TASK_BOARD_PRIORITY).find(([, label]) => label === priority);
    return matched?.[0] || 'P2';
  }

  reverseTaskBoardStatus(status) {
    const matched = Object.entries(TASK_BOARD_STATUS).find(([, label]) => label === status);
    return matched?.[0] || 'pending';
  }

  mapExternalTaskStatus(status) {
    if (status === 'done') {
      return 'done';
    }
    if (status === 'todo') {
      return 'pending';
    }
    return '';
  }

  mapCalendarEventStatus(status) {
    if (status === 'cancelled') {
      return 'blocked';
    }
    return '';
  }

  getCommitmentSource(commitment) {
    return commitment.sourceType || commitment.source || 'manual';
  }

  normalizePriority(priority) {
    const mapping = {
      high: 'P1',
      medium: 'P2',
      low: 'P3',
      P0: 'P0',
      P1: 'P1',
      P2: 'P2',
      P3: 'P3'
    };

    return mapping[priority] || 'P2';
  }

  toTimestampString(value) {
    if (!value) {
      return '';
    }

    return String(new Date(value).getTime());
  }

  toIsoWithOffset(value) {
    const date = new Date(value);
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

  toBitableDateString(value) {
    if (!value) {
      return '';
    }

    const date = new Date(value);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}/${month}/${day}`;
  }

  toCalendarApiTime(value) {
    const date = new Date(value);
    return {
      timestamp: String(Math.floor(date.getTime() / 1000)),
      timezone: 'Asia/Shanghai'
    };
  }

  buildTaskDescription(commitment) {
    const lines = [
      `## ${commitment.title}`,
      '',
      `状态: ${commitment.status || 'pending'}`,
      `优先级: ${this.normalizePriority(commitment.priority)}`,
      `置信度: ${commitment.confidence || 'medium'}`
    ];

    if (commitment.deadline) {
      lines.push(`截止时间: ${commitment.deadline}`);
    }

    if (commitment.sourceTitle) {
      lines.push(`来源: ${commitment.sourceTitle}`);
    }

    if (commitment.rawMessageText) {
      lines.push(`承诺原文: ${commitment.rawMessageText}`);
    }

    if (commitment.conversationSummary) {
      lines.push(`上下文摘要: ${commitment.conversationSummary}`);
    }

    if (commitment.evidence && commitment.evidence.length > 0) {
      lines.push('');
      lines.push('## 证据链');

      for (const evidence of commitment.evidence) {
        const evidenceSource = evidence.sourceTitle || evidence.sourceType || '未知来源';
        lines.push(`> "${evidence.quote}"`);
        lines.push(`> - ${evidenceSource}, ${evidence.speaker || '未知'}`);
        lines.push('');
      }
    }

    const contextSnippet = this.truncateText(commitment.conversationContext, 2000);
    if (contextSnippet) {
      lines.push('## 对话上下文');
      lines.push(contextSnippet);
      lines.push('');
    }

    lines.push('---');
    lines.push('由 FlowMate 自动创建');
    return lines.join('\n');
  }

  truncateText(text, limit = 500) {
    const normalized = String(text || '').trim();
    if (!normalized) {
      return '';
    }
    if (normalized.length <= limit) {
      return normalized;
    }
    return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
  }
}

export const feishuWriter = new FeishuWriter();

function findValue(target, keys) {
  if (!target || typeof target !== 'object') {
    return '';
  }

  for (const key of keys) {
    if (typeof target[key] === 'string' && target[key]) {
      return target[key];
    }
  }

  for (const value of Object.values(target)) {
    if (value && typeof value === 'object') {
      const nested = findValue(value, keys);
      if (nested) {
        return nested;
      }
    }
  }

  return '';
}

function extractRecordId(result) {
  const direct = findValue(result, ['record_id', 'recordId']);
  if (direct) {
    return direct;
  }

  const nested = result?.data?.record?.record_id_list?.[0];
  if (typeof nested === 'string' && nested) {
    return nested;
  }

  return '';
}

function parseLedgerDeadline(value) {
  if (!value) {
    return null;
  }

  const num = Number(value);
  if (Number.isFinite(num) && num > 0) {
    return new Date(num).toISOString();
  }

  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function parseTaskBoardDeadline(value) {
  if (!value) {
    return null;
  }

  const text = String(value).trim();
  const slashDate = text.match(/^(\d{4})\/(\d{2})\/(\d{2})$/u);
  if (slashDate) {
    const [, year, month, day] = slashDate;
    return new Date(`${year}-${month}-${day}T23:59:59+08:00`).toISOString();
  }

  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}
