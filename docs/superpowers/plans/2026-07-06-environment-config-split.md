# Environment Config Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the bot run against either the personal-organization sandbox or the formal organization by switching configuration files, while allowing wiki/base links to reduce manual token lookup.

**Architecture:** Keep business logic unchanged and move organization-specific IDs into environment-scoped JSON files. Extend table config normalization and Bitable access with lazy wiki-node resolution so table configs can use `wikiUrl` or `wikiNodeToken` when the Base app token is inconvenient to find.

**Tech Stack:** Node.js ESM, Feishu Open Platform SDK client, current `config/groups.json` pattern, `node:test`.

---

### Task 1: Normalize Table Wiki Links

**Files:**
- Modify: `src/config.js`
- Test: `test/config.test.js`

- [ ] **Step 1: Add tests for table wiki link normalization**
- [ ] **Step 2: Extend `normalizeTableConfig` to preserve `wikiNodeToken`, `wikiUrl`, and `baseUrl`**
- [ ] **Step 3: Run `node --test test/config.test.js`**

### Task 2: Resolve Wiki Base Tokens Lazily

**Files:**
- Modify: `src/bitable-service.js`
- Test: `test/bitable-service.test.js`

- [ ] **Step 1: Add a test that writes a record with only `wikiNodeToken + tableId` configured**
- [ ] **Step 2: Resolve wiki nodes through `/open-apis/wiki/v2/spaces/get_node` and cache the resulting app token**
- [ ] **Step 3: Use the resolved table config for create, update, and list requests**
- [ ] **Step 4: Run `node --test test/bitable-service.test.js`**

### Task 3: Add Environment Config Files and Docs

**Files:**
- Add: `config/groups.personal.json`
- Add: `config/groups.formal.example.json`
- Modify: `docs/daily-fact-table-setup.md`

- [ ] **Step 1: Copy the current local config into `groups.personal.json`**
- [ ] **Step 2: Add a formal-organization example config with the same shape but disabled**
- [ ] **Step 3: Document `GROUPS_CONFIG_PATH` and the personal-to-formal migration rule**
- [ ] **Step 4: Run the full test suite**
