@echo off
setlocal
set "OPENCLAW_STATE_DIR=E:\feishu-ai-competition\openclaw-state"
"C:\Program Files\nodejs\node.exe" "E:\feishu-ai-competition\openclaw-main\openclaw-main\openclaw.mjs" gateway run --verbose
