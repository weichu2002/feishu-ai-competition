# FlowMate Personal Bot Control Supplement

This document supplements the existing architecture files:

- `E:\feishu-ai-competition\flowmate\docs\ARCHITECTURE.md`
- `E:\feishu-ai-competition\flowmate\docs\ARCHITECTURE_ADDENDUM.md`

It does not replace them. It adds the missing control-plane requirements for the personal version of FlowMate.

## Goal

The personal FlowMate bot is not complete if it can only:

- scan messages
- extract commitments
- write to the ledger
- create tasks
- create calendar reminders

It must also let the user control the monitor itself.

## Required Personal Bot Control Loop

The personal bot must support these user intents:

1. disable monitoring
2. pause monitoring for a period
3. resume monitoring
4. inspect monitoring status
5. trigger re-authorization

This creates a full personal closed loop:

`user message -> personal scan -> extraction -> ledger/task/calendar -> proactive bot feedback`

plus:

`user control command -> monitor control state -> watcher behavior changes -> bot status feedback`

## State Model

The watcher must follow explicit shared state instead of hidden process behavior.

### Control State

Shared control state must include:

- `enabled`
- `pausedUntil`
- `updatedAt`
- `updatedBy`
- `reason`

### Auth State

Shared auth state must include:

- whether user identity is currently valid
- whether re-authorization is pending
- authorization URL
- expiration time

### Watcher Status

Watcher heartbeat/status must include:

- `pid`
- `state`
- `intervalSeconds`
- `startedAt`
- `lastLoopAt`
- `lastResultAt`
- `lastErrorAt`
- `lastError`

## Behavior Rules

### Disable

When the user says `关闭监听` or equivalent:

- keep the watcher process alive if already running
- stop all new scans
- preserve auth state
- preserve previous scan state

### Pause

When the user says `暂停监听两小时` or equivalent:

- keep the watcher process alive
- do not scan during the pause window
- automatically resume after `pausedUntil`

### Resume

When the user says `恢复监听`:

- clear disabled/pause restrictions
- allow the next watcher loop to continue scanning

### Status

When the user asks for `监听状态`:

- report monitor state
- report auth state
- report watcher health
- report whether monitoring is actually active

### Re-authorization

When the user says `重新授权监听`:

- generate a new authorization URL
- persist the pending authorization state
- pause auto-monitoring until authorization is completed
- automatically resume after successful authorization

## Product Principle

The personal version of FlowMate should feel like a controllable assistant, not a runaway background script.

So the first post-V1 priority is:

- controlability
- inspectability
- recoverability

Only after that should the project continue toward:

- richer Bitable views
- dashboard
- rollback/undo
- task status writeback
- calendar status writeback
- team-level expansion

## Personal Bot V1.1 Completion Scope

After the control loop, the personal bot must also gain these product-layer abilities:

1. `undo latest automatic action`
2. `ensure personal ledger views`
3. `ensure personal dashboard`
4. `write task status back to the ledger`
5. `write calendar status or deadline changes back to the ledger`

These are not optional polish items. They are part of the personal closed loop.

## Why These Abilities Matter

### Undo Latest

Automatic extraction can still misfire.
The user must be able to roll back the latest automatic FlowMate action without touching the terminal manually.

Rollback must cover:

- Bitable record
- created task
- created calendar reminder

### Personal Views

The ledger should not be a raw table only.
The personal bot should ensure the ledger contains usable views such as:

- all commitments
- open commitments
- done commitments
- blocked commitments

### Personal Dashboard

The bot should be able to ensure a lightweight personal dashboard exists so the user can inspect the ledger visually instead of only through chat output.

### Linked Status Writeback

The personal ledger is only trustworthy if downstream execution systems can write back into it.

That means:

- task completion should update ledger status
- blocked task state should update ledger status
- calendar reminder changes should update ledger deadline or state when relevant

## Personal Runtime Principle

The watcher should not only discover new commitments.
It should also perform low-cost periodic maintenance work:

- discover new commitments
- keep views/dashboard ready
- sync linked task/calendar status back into the ledger

This keeps the personal FlowMate bot closed-loop even when the user does nothing after the original commitment is captured.
