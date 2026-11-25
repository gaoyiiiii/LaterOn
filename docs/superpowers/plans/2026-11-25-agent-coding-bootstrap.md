# Agent-coding Bootstrap Implementation Plan

> **For agentic workers:** Use the native in-session workflow to complete each step and verify it before committing.

**Goal:** Add concise project rules and persistent task memory for LaterOn.

**Architecture:** Document only observed project facts. Keep the current work as one active slice in `.agent/MEMORY.md`, then close it after validation.

**Tech Stack:** Chrome Manifest V3 extension using native JavaScript, CSS, HTML, and localized message files; no package or test configuration was found.

**Spec:** `docs/superpowers/specs/2026-11-25-agent-coding-bootstrap-design.md`

## Global Constraints

- Do not change extension behavior, install dependencies, or create a test framework.
- Do not invent project-configured tests or architecture facts.
- Stage and commit only the files created for this agent-coding setup; leave the existing extension files uncommitted.

## Review Focus

- Existing extension files must remain untouched; verify the staged file list before committing.
- `manifest.json` must remain valid JSON; parse it during verification.
- All JavaScript files must pass the available syntax check; if Node.js is unavailable, report that limitation.
- Project rules must accurately state that no test/build scripts are configured.
- The task memory must show one active slice during work and mark it complete only after verification.

---

### Task 1: Add project rules and task memory

**Files:**
- Create: `AGENTS.md`
- Create: `.agent/MEMORY.md`

- [x] 新增项目规则与任务记忆骨架

### Task 2: Verify and commit the setup

**Files:**
- Verify: `AGENTS.md`, `.agent/MEMORY.md`, design, and plan documents
- Verify: `manifest.json` and JavaScript syntax
- Commit: only the setup documents and project rules

- [x] 验证接入范围并提交规范文件
