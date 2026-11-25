# 单页添加选组 Implementation Plan

> **For agentic workers:** Inline execution in the current session; the user approved implementation. Keep one `.agent/MEMORY.md` slice active.

**Goal:** Default single-page saves to the existing project picker with Inbox selected.

**Architecture:** Keep the shared save/picker flow. Update setting defaults and legacy resolution consistently; pass an explicit inbox project for single saves, retaining the batch flow's remembered project.

**Tech Stack:** Manifest V3, native JavaScript/HTML/CSS, existing Node scripts; jsdom for existing DOM checks, installed outside the repository.

**Spec:** `docs/superpowers/specs/2026-11-25-single-save-project-picker-design.md`

## Constraints and review focus

- Respect explicit opt-out; unmarked legacy false values migrate to enabled.
- Do not persist an explicit opt-out when saving an unrelated setting.
- Read and watch must resolve settings identically.
- Cancel must leave items unchanged; confirmation must use the chosen project.
- Batch defaults must still use the remembered project even when only one eligible tab remains.
- Preserve original checkout and use fork history for pushes. No forced push.

### Task 1: Default single saves to Inbox in the shared picker

**Files:** `background.js`, `theme.js`, `i18n.js`, `settings.html`; `tests/save-single-page.test.js`, `tests/single-save-settings.test.js`, `tests/shortcut-config.test.js`.

**Interfaces:** `quickSave(tab, source)` supplies an explicit inbox project to `askFolderThenSave`; the latter retains its existing remembered-project interface. Settings keep `askFolderOnSingle` and `askFolderOnSingleOptIn`.

- [x] Run the existing suite as baseline; record any existing failures.
- [x] Update save tests and add settings migration/read/watch/toggle checks; observe the expected failures before product edits.
- [x] Update defaults and normalization, single-save default project, and bilingual setting hints.
- [x] Run all Node test scripts, manifest parsing, and root JavaScript syntax checks; inspect the diff.
- [x] Mark the slice complete in `.agent/MEMORY.md`, record verification limits, remove the completed CSV, commit, and push the feature branch to the authorized fork.

## Verification record (2026-11-25)

- Baseline: all 53 existing `tests/*.test.js` scripts exited successfully.
- RED: the added settings checks had 6 expected failures; the revised single-save flow had 20 failed checks against the old defaults (including downstream effects of premature writes).
- GREEN: all 54 scripts exited successfully, including all 9 settings subtests, shared picker DOM checks, batch-save checks, confirmation/cancel/duplicate handling, sidebar and shortcut checks.
- `Get-Content .\manifest.json -Raw | ConvertFrom-Json | Out-Null` passed; all root `*.js` files passed `node --check`.
- All 7 unique manifest file references exist; `git diff --check` passed.
- Scope limit: Node scripts substitute Chrome APIs. No real browser extension reload or visual acceptance is claimed.
- Independent read-only review found no blocking correctness or data issue and reran the single-save, settings, shortcuts, batch-save and reinjection checks successfully.
