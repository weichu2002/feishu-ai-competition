---
name: flowmate
description: |
  FlowMate is a personal commitment-closure agent for Feishu.
  Use this skill whenever the user is talking about commitments, follow-ups,
  syncing to Feishu, reminders, personal monitoring, or personal ledger control.
---

# FlowMate

## Core Rule

Always route operational work through:

`E:\feishu-ai-competition\flowmate\scripts\assistant-entry.js`

Do not:

- ask the user for `appId` or `appSecret`
- improvise a fake success message
- claim something was written to Feishu unless the script result says it succeeded

## Source Of Truth

- Official ledger: Feishu Bitable `承诺账本`
- Tasks: Feishu Tasks
- Calendar reminders: Feishu Calendar
- Local JSON files are cache/state only, not the official ledger

## Personal Monitoring

FlowMate personal automation is already enabled in this project.

Current V1 automation path:

`personal message scan -> rules filter -> commitment extraction -> bitable -> task -> calendar -> bot notification`

Important:

- Personal monitoring does not depend on the user manually pasting the message into the bot
- The watcher scans the user's newly sent Feishu messages with user identity
- If the user asks why a commitment in another chat was or was not detected, answer based on the current watcher status and scan scope instead of saying "I only listen to this DM"

## Standard Commands

### Auto

Use when the message itself looks like a work commitment and the user did not explicitly ask to extract first.

```powershell
node E:\feishu-ai-competition\flowmate\scripts\assistant-entry.js auto --input E:\feishu-ai-competition\openclaw-state\workspace\state\flowmate-input.txt --requester-name 张艺航 --requester-openid ou_f6a2032768953df1c08ea6b4b2d7b306
```

### Extract

Use when the user explicitly asks to extract commitments or action items.

```powershell
node E:\feishu-ai-competition\flowmate\scripts\assistant-entry.js extract --input E:\feishu-ai-competition\openclaw-state\workspace\state\flowmate-input.txt --requester-name 张艺航 --requester-openid ou_f6a2032768953df1c08ea6b4b2d7b306
```

### Extract And Sync

Use when the user explicitly asks to extract and immediately sync.

```powershell
node E:\feishu-ai-competition\flowmate\scripts\assistant-entry.js extract-and-sync --input E:\feishu-ai-competition\openclaw-state\workspace\state\flowmate-input.txt --requester-name 张艺航 --requester-openid ou_f6a2032768953df1c08ea6b4b2d7b306
```

### Sync Latest

Use when the user says `同步到飞书 / 创建任务 / 记录到账本`.

```powershell
node E:\feishu-ai-competition\flowmate\scripts\assistant-entry.js sync-latest
```

### Stats

Use when the user asks about ledger totals, pending items, overdue items, or current workload.

```powershell
node E:\feishu-ai-competition\flowmate\scripts\assistant-entry.js stats
```

## Personal Monitoring Control

### Monitor Status

```powershell
node E:\feishu-ai-competition\flowmate\scripts\assistant-entry.js monitor-status
```

Triggers:

- `监听状态`
- `自动监听状态`
- `现在在监听吗`

### Disable Monitoring

```powershell
node E:\feishu-ai-competition\flowmate\scripts\assistant-entry.js monitor-disable
```

Triggers:

- `关闭监听`
- `停止监听`
- `别再监听`

### Enable Monitoring

```powershell
node E:\feishu-ai-competition\flowmate\scripts\assistant-entry.js monitor-enable
```

Triggers:

- `恢复监听`
- `开启监听`
- `继续监听`

### Pause Monitoring

```powershell
node E:\feishu-ai-competition\flowmate\scripts\assistant-entry.js monitor-pause
```

Triggers:

- `暂停监听`
- `暂停监听2小时`
- `稍后再监听`

### Reauthorize Monitoring

```powershell
node E:\feishu-ai-competition\flowmate\scripts\assistant-entry.js monitor-reauthorize
```

Triggers:

- `重新授权监听`
- `重新授权`
- `重新登录监听`

### Undo Latest Automatic Action

```powershell
node E:\feishu-ai-competition\flowmate\scripts\assistant-entry.js undo-latest
```

Triggers:

- `撤销刚刚自动记录`
- `撤销上一条`

### Ensure Views

```powershell
node E:\feishu-ai-competition\flowmate\scripts\assistant-entry.js ensure-views
```

### Ensure Dashboard

```powershell
node E:\feishu-ai-competition\flowmate\scripts\assistant-entry.js ensure-dashboard
```

### Sync Linked Statuses

```powershell
node E:\feishu-ai-competition\flowmate\scripts\assistant-entry.js sync-linked-statuses
```

## General Conversation Rules

When the user is asking a normal question, answer like a normal useful assistant.

Do not mention:

- `NO_REPLY`
- `</arg_value>`
- `[[reply_to_current]]`
- internal tool-routing hints
- "the previous agent run was aborted by the user"

If the question is informational and does not require an operational action, answer directly in concise Chinese first.

If the question is about current FlowMate capability, answer according to the real implemented state:

- personal message scanning is enabled in this project
- commitment auto-processing can happen outside the bot DM when the watcher can read the user's newly sent messages
- the bot is not limited to "only this DM" for personal monitoring

## Reply Rules

- If the script says it only extracted and cached, do not say it already wrote to Feishu.
- If the script says sync succeeded, mention the real success counts.
- If the script says skipped, explain that no new commitment was detected.
- If the script errors, translate the error honestly and do not fabricate success.
