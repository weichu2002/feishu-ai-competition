# FlowMate

FlowMate is a Feishu-native AI agent for commitment tracking, knowledge extraction, and team execution follow-up.

It is built for the Feishu AI Campus Challenge. The project focuses on a concrete office-collaboration problem: valuable decisions, promises, and action items are scattered across chats, Feishu Docs, Feishu Minutes, tasks, and calendars. FlowMate turns those fragmented signals into a structured, traceable, and actionable workflow.

## One-Line Summary

FlowMate converts scattered Feishu conversations, documents, and meeting minutes into a commitment ledger, Feishu tasks, calendar reminders, team dashboards, proactive summaries, and evidence-backed knowledge Q&A.

## Problem

In real work, many important commitments are not created in task software first. They usually appear as natural language:

- "I will send the draft tomorrow afternoon."
- "Please follow up with the customer before Friday."
- "After the meeting, someone needs to share the launch link."

Traditional task tools require users to manually create, update, and maintain tasks. Knowledge assistants can answer questions, but often do not close the loop from knowledge to execution.

FlowMate tries to solve this gap:

- Identify commitments from natural Feishu messages, Docs, and Minutes.
- Preserve source evidence and context.
- Create or update Feishu Bitable records, tasks, and calendar reminders.
- Let users control the bot directly inside Feishu.
- Support team-level source scanning and evidence-based Q&A.

## Product Positioning

FlowMate is not a generic chatbot. It is a workflow agent for "knowledge to execution".

The current product is closest to competition direction D, "team task hub and progress reconciliation", and also covers parts of direction A and B:

- Direction D: team key item tracking table, owner extraction, task creation, status tracking, warnings, and dashboard.
- Direction B: meeting minutes to Action Items to tasks and reminders.
- Direction A: daily/team summary, risk insights, and dashboard metrics.

## Core Features

### 1. Feishu Bot Conversation

Users can talk to FlowMate directly in Feishu. It supports both natural Q&A and deterministic control commands.

Examples:

```text
FlowMate 和普通待办软件有什么区别？
监听状态
关闭监听
恢复监听
```

### 2. Personal Commitment Auto-Capture

FlowMate can monitor visible Feishu messages and detect personal commitments.

Pipeline:

```text
Feishu message -> rule pre-filter -> context collection -> model extraction -> Bitable -> task -> calendar -> bot notification
```

Supported operations:

- Automatically detect commitments.
- Write structured records into Feishu Bitable.
- Create Feishu tasks.
- Create calendar reminders.
- Update existing commitments.
- Mark commitments as done or blocked.
- Delete or undo records, including linked Bitable/task/calendar cleanup.

### 3. Bot-Controlled Monitoring

The user can manage the watcher from Feishu without opening the terminal.

Supported commands:

```text
监听状态
关闭监听
恢复监听
暂停监听 2 小时
重新授权监听
```

### 4. Team Source Scanning

FlowMate supports team-level fixed sources:

- Feishu group messages.
- Feishu Docs.
- Feishu Doc comments.
- Feishu Minutes.

It can periodically scan configured sources and write extracted items into a team-level progress table.

### 5. Real Feishu Minutes Integration

FlowMate can read real Feishu Minutes through lark-cli, extract todos from meeting artifacts, and write them into the team table.

Verified demo case:

- Source: real Feishu Minutes.
- Extracted item: product launch information link sharing.
- Owner: 吴星辉.
- Output: team table record, Feishu task, dashboard refresh, evidence-backed Q&A.

### 6. Feishu Bitable as Source of Truth

FlowMate uses Feishu Bitable as the official ledger, not a local JSON file.

Current tables include:

- Personal commitment ledger.
- Team key item progress table.
- Team dashboard metrics table.

Tracked fields include:

- Title.
- Owner.
- Owner Open ID.
- Deadline text.
- Normalized deadline.
- Status.
- Priority.
- Source type.
- Source title.
- Source link.
- Evidence quote.
- Raw message text.
- Conversation summary.
- Conversation context.
- Feishu task ID.
- Feishu calendar event ID.
- Deduplication fingerprint.

### 7. Team Dashboard

FlowMate maintains dashboard-oriented metrics in Bitable:

- Total items.
- Pending items.
- Due soon.
- Overdue.
- Blocked.
- Done.
- By owner.
- By source type.
- Weekly additions.

### 8. Evidence-Based Knowledge Q&A

FlowMate can answer questions based on extracted team evidence instead of hallucinating.

Example:

```text
团队知识问答：根据最近的团队来源，FlowMate 现在有哪些待推进事项或风险？请给证据来源。
```

Expected answer:

- Summarizes the current pending item.
- Names the owner.
- Includes source evidence such as Feishu Minutes title and original quote.

### 9. Local Web Control Panel

FlowMate includes a local web control panel:

```text
http://127.0.0.1:18888/
```

Supported one-click actions:

- Start services.
- Stop services.
- Refresh status.
- Refresh team dashboard.
- Subscribe to task events.
- Real document source verification.
- Real Minutes source verification.
- Evidence Q&A verification.
- Full live regression.

After a one-click action completes, the Bot sends a Feishu confirmation message.

### 10. Regression and Live Verification

The project includes automated checks to avoid "fixing one feature and breaking another".

Important verification scripts:

```bash
npm run service:health
npm run self-test:core
npm run self-test:regression -- --live-feishu
npm run self-test:real-doc-source
npm run self-test:real-minutes-source
npm run self-test:team-knowledge-qa
```

## Technical Architecture

FlowMate follows a strict layered architecture.

```text
Feishu
  |
  v
openclaw-lark
  - official Feishu communication channel
  - receives messages
  - sends Bot replies
  |
  v
OpenClaw Gateway
  - agent runtime
  - session/workspace/tool routing
  |
  v
FlowMate
  - intent routing
  - commitment extraction
  - context collection
  - deduplication
  - state orchestration
  - dashboard and QA logic
  |
  v
lark-cli
  - Feishu object operations
  - Bitable records
  - tasks
  - calendars
  - Docs
  - Minutes
```

### Key Boundary

- `openclaw-lark` is the official Feishu communication layer.
- `lark-cli` is the Feishu action layer.
- FlowMate owns product logic and orchestration.
- Feishu Bitable is the official data source.
- Local files are only cache, debug, or control state.

## Main Files

```text
flowmate/
  src/
    config.js                # environment and runtime config
    lark-cli.js              # lark-cli wrapper
    model-client.js          # LLM client
    feishu-write.js          # Bitable/task/calendar operations
    personal-monitor.js      # personal watcher control state
    team-monitor.js          # team source scanning and dashboard
    types.js                 # core domain types
  scripts/
    assistant-entry.js       # main Bot orchestration entry
    watch-personal-messages.js
    watch-team-sources.js
    flowmate-service.js      # service manager
    flowmate-control-panel.js
    team-entry.js
    self-test-*.mjs          # regression and live verification
  docs/
    ARCHITECTURE.md
    ARCHITECTURE_ADDENDUM.md
    ARCHITECTURE_PERSONAL_BOT_CONTROL.md
  eval/
    run-eval.js
  examples/
    meeting-minutes.json
  skills/
    flowmate/SKILL.md
```

## Requirements

- Node.js 20 or later.
- OpenClaw runtime.
- openclaw-lark plugin.
- lark-cli with Feishu authorization.
- Feishu Bitable, Task, Calendar, Docs, and Minutes permissions.
- Zhipu GLM API key or compatible model API.

## Setup

Install dependencies:

```bash
npm install
```

Copy environment template:

```bash
cp .env.example .env
```

Fill in required environment variables:

```bash
ZAI_API_KEY=
ZAI_MODEL=zai/glm-4.7-flash
FLOWMATE_OPENCLAW_STATE_DIR=
FLOWMATE_OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789
FLOWMATE_BITABLE_APP_TOKEN=
FLOWMATE_BITABLE_TABLE_ID=
FLOWMATE_TASK_ID=
```

Check lark-cli:

```bash
npm run check:lark
```

Start FlowMate services:

```bash
npm run service:start
```

Open local control panel:

```bash
npm run service:panel -- --open
```

Check health:

```bash
npm run service:health
```

## Demo Flow

Recommended recording flow:

1. Open the local control panel and refresh status.
2. Ask the Bot a natural question:

```text
FlowMate 和普通待办软件有什么区别？
```

3. Test monitor control:

```text
监听状态
关闭监听
恢复监听
```

4. Send a personal commitment:

```text
我明天下午5点前把 FlowMate 答辩演示稿第一版整理出来。
```

5. Update or delete the commitment:

```text
把这条延期到明天下午
把这条标记为完成
撤销刚刚自动记录
```

6. Click "真实文档验证" in the control panel.
7. Click "真实妙记验证" in the control panel.
8. Ask evidence-based team QA:

```text
团队知识问答：根据最近的团队来源，FlowMate 现在有哪些待推进事项或风险？请给证据来源。
```

9. Show Feishu Bitable team table and dashboard metrics.
10. Optionally run full live regression.

## Verified Capabilities

The following capabilities have been verified in live Feishu environment:

- Feishu Bot natural Q&A.
- Monitor status, disable, and resume commands.
- Personal commitment extraction from Feishu messages.
- Bitable record creation and update.
- Feishu task creation, update, completion, and deletion.
- Calendar reminder creation, update, and deletion.
- Undo latest automatic record.
- Specific commitment delete command.
- Real Feishu Doc source end-to-end verification.
- Real Feishu Minutes source end-to-end verification.
- Team knowledge Q&A with evidence.
- Team dashboard metric refresh.
- Local control panel Bot notification.

## Evaluation Ideas

FlowMate can be evaluated with both technical and product metrics:

- Commitment extraction accuracy.
- Owner extraction accuracy.
- Deduplication rate.
- Task creation success rate.
- Calendar creation success rate.
- Evidence citation accuracy.
- Hallucination rate in knowledge Q&A.
- Manual organization time saved.
- Number of user actions reduced from message to task.

## Security Notes

Do not commit:

- `.env`
- `node_modules/`
- local OpenClaw state
- Feishu auth files
- session logs
- personal user identity files
- real private meeting transcripts

Use `.env.example` and documentation instead.

## Future Roadmap

FlowMate is currently a working execution-closure agent, but it is not yet the final form of AI-native office work. Future versions can go deeper in several directions:

1. From "task extraction" to "organizational memory"

FlowMate should not only extract todos. It should gradually build a living project memory graph: decisions, commitments, risks, owners, deadlines, dependencies, and evidence links.

2. From "passive dashboard" to "active management copilot"

Instead of waiting for managers to open dashboards, FlowMate can proactively generate weekly risk briefings, detect blocked work, and ask the right person for clarification.

3. From "single-user verification" to "multi-member team loop"

The next milestone is robust multi-member mapping, assignment, notification, status tracking, and permission-aware collaboration across a real team.

4. From "source scanning" to "context-aware timing"

FlowMate should know when knowledge is useful: before a meeting, after a meeting, before a deadline, when a task is blocked, or when a similar historical case exists.

5. From "office automation" to "new work interface"

The long-term vision is that work does not start from manually creating forms and tasks. Work starts from natural collaboration, and AI agents transform it into structured, verifiable, and executable systems.

## License

This project is for competition and research demonstration.
