# 已分组网页卡片显示当前组别 Implementation Plan

> **For agentic workers:** Use inline execution in the current workspace. The user approved this approach; do not delegate subagents.

**Goal:** Newly created library cards show the saved project name in their existing membership selector.

**Architecture:** Keep the current card template and project selector. After populating selector options in `createCard`, assign the value from `item.projectId`, matching the existing `updateCard` behavior.

**Tech Stack:** Chrome Extension Manifest V3, native JavaScript, HTML, and CSS.

**Spec:** `docs/superpowers/specs/2026-11-25-group-card-project-label-design.md`

## Global Constraints

- Change only the group-card initialization slice recorded in `.agent/MEMORY.md`.
- Add no dependencies and preserve the existing DOM and styling.
- Run the manifest JSON and root JavaScript syntax checks from `AGENTS.md`.
- The repository has no automated test suite; syntax checks must not be reported as functional tests.

---

### Task 1: Fix and verify the group selector on new cards

**Files:**
- Modify: `library.js` in `createCard`
- Modify: `.agent/MEMORY.md` to close the current slice and record the result
- Verify: `manifest.json` and all root `*.js` files using the commands in `AGENTS.md`

**Interfaces:**
- Consumes: each saved item's `projectId`, already used by `updateCard`
- Produces: the existing `.project-select` initially selecting the saved project or the inbox option

- [x] **Step 1: Initialize the new card selector from the saved item**

  In `createCard`, keep the existing `fillProjectSelect(projectSelect, item.projectId || "")` call and immediately set `projectSelect.value = item.projectId || ""`.

- [x] **Step 2: Run the repository checks**

  Run `Get-Content .\manifest.json -Raw | ConvertFrom-Json | Out-Null` and `Get-ChildItem -File -Filter *.js | ForEach-Object { node --check $_.FullName }`. Both commands must exit successfully. These checks validate syntax and JSON only, not rendered behavior.

- [x] **Step 3: Review and commit only this slice**

  Review the diff for `library.js`, the design and plan documents, and `.agent/MEMORY.md`. Stage only those files and commit the completed slice; do not stage other untracked extension files.
