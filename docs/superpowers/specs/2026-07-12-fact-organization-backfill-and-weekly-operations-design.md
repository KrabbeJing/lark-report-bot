# Fact Organization Backfill And Weekly Operations Design

## Goal

Correct the organizational dimensions stored in the daily fact table before AI weekly
aggregation begins, provide explicit historical backfill, route recoverable application
errors to the operations chats, and make each copied weekly sheet short-named, first in
the workbook, and directly addressable.

## Scope

This change covers four related areas:

1. Daily fact identity and organization snapshots.
2. Rolling synchronization and explicit historical backfill.
3. In-process error reporting for message and scheduled workflows.
4. Weekly sheet naming, placement, direct links, and recovery.

It does not add AI weekly content generation, automatically create annual workbooks,
or replace infrastructure monitoring for failures that prevent the process from starting.

## Source-Of-Truth Rules

`groups[]` represents an ingestion and delivery scope, such as one divisional leader's
chat. It does not represent an agile team. The `groups.agileGroup` property is therefore
removed from local, personal, and formal example configuration.

The team contact table is the only source for these daily fact fields:

| Daily fact field | Team contact field |
| --- | --- |
| `日报提交人姓名` | `成员真实姓名` |
| `直属上级` | `直属上级` |
| `敏捷小组` | `敏捷小组` |
| `分管领导` | `分管领导` |

`实际日报提交人` and `成员OpenID` continue to use the matched contact identity. Source
forms and chat messages provide report content and identity clues, but cannot supply or
override the identity and organizational fields above.

## Historical Snapshot Policy

Organizational values are snapshots as of the time a fact is first matched. A later team
move or supervisor change must not rewrite facts from completed periods.

Normal synchronization follows these rules:

- A new matched fact stores the contact's real name, supervisor, agile team, and
  divisional leader.
- An existing fact with a complete snapshot keeps that snapshot when report content is
  merged or refreshed.
- An existing unmatched fact may fill previously blank snapshot fields when a contact is
  later matched.
- A fact that still cannot be matched keeps the identity and organizational fields blank and is
  `待人工确认`.
- A manually `忽略` fact remains `忽略` under every automatic operation.
- Content winner selection between form and chat sources is independent from contact
  matching and snapshot population.

The initial test-environment correction is explicit rather than part of normal sync. A
repair run may overwrite existing organizational snapshots in its requested date range
using the contact table as it exists at repair time. After that repair, normal runs freeze
the corrected values.

## Contact Matching

Matching priority remains deterministic:

1. Current OpenID or the contact member's OpenID.
2. Exact real-name match.
3. Configured member alias match.

No group-level agile-team fallback is allowed. A failed match is visible through matching
status and fact status; it is not silently assigned to the chat's group.

## Rolling Sync And Backfill

`dailyFactSync.lookbackDays: 7` means seven inclusive calendar dates. For a run on
2026-07-10, the range is 2026-07-04 through 2026-07-10. The scheduled task keeps this
behavior.

A new command accepts an explicit inclusive date range:

```bash
npm run daily-fact:backfill -- --start 2026-07-01 --end 2026-07-12
```

Optional organization repair is explicit:

```bash
npm run daily-fact:backfill -- --start 2026-07-01 --end 2026-07-12 --repair-organization
```

The command validates `YYYY-MM-DD` values, requires `start <= end`, uses the configured
timezone, and processes groups sequentially. It reuses the existing fact key and source
conflict resolution, so rerunning the same range cannot create duplicate facts.

Normal backfill preserves complete organization snapshots. `--repair-organization`
replaces the four contact-derived snapshot fields only for matched facts in the requested
range.
Unmatched facts remain pending, and ignored facts remain ignored.

## Application Error Reporting

The configured recipients remain:

```json
{
  "errorReporting": {
    "adminOpenIds": [],
    "adminChatIds": []
  }
}
```

Every in-process workflow reports terminal failures through one shared reporting path:

- Chat message handling.
- Daily fact synchronization and backfill.
- Daily supervisor delivery.
- Weekly instance creation.
- Weekly AI generation, poster generation, and group delivery when those stages are
  enabled.
- Manual commands when configuration and the Lark client were initialized successfully.

Batch workflows send one summary per task, group, and execution. The summary includes the
task, group, time, failure count, failing stage when known, and a bounded sample of error
messages. Individual record errors are aggregated instead of producing one chat message
per record.

Weekly instance stages use stable identifiers:

- `copy_sheet`
- `move_sheet`
- `locate_template`
- `write_period`
- `write_instance_base`

Notifications must not contain application secrets, access tokens, full OpenIDs, full
chat IDs, spreadsheet tokens, Base tokens, table IDs, sheet IDs, or raw report content.
Logs use the same masking policy.

Configuration parse failures, missing credentials, invalid credentials that prevent
messaging, process crashes before initialization, host outages, and network partitions
cannot reliably be reported by the same process. Tencent Cloud or an equivalent external
process monitor remains responsible for that failure class.

## Weekly Instance Failure Semantics

`Base write failure` means that the weekly sheet already exists or was prepared, but the
attempt to create or update its row in the weekly instance Base failed. It does not refer
to a `SpreadsheetTokenerror` field; no such field exists.

The recovery order remains:

1. Look up the ISO week key in the weekly instance Base.
2. If no row exists, find the copied sheet by its expected title.
3. Reuse the sheet when found instead of copying again.
4. Ensure it is first in the workbook.
5. Revalidate semantic targets and write the report period.
6. Retry the weekly instance Base write.

If the weekly instance Base itself is unavailable, the service cannot persist
`实例状态=创建失败` in that same Base. It reports the error to operations and relies on a
later idempotent retry.

## Weekly Sheet Naming And Placement

Each year uses a separate weekly-report spreadsheet. Annual workbook creation and config
rotation are manual in this stage.

The copied sheet title is based on the Friday date:

```text
数字金融部周报0710
```

The title renderer adds `{{weekEndMMDD}}`, and group configuration uses:

```json
{
  "titlePattern": "数字金融部周报{{weekEndMMDD}}"
}
```

After copy, the service moves the new sheet to workbook index `0`. A recovered sheet is
also moved to index `0`. Failure to move is a terminal failure for that run: the Base row
is not registered, operations is notified, and the next run reuses and retries the same
sheet.

Moving the sheet improves tab ordering but is not the primary navigation guarantee. The
weekly instance Base and all reminders or group messages use a URL containing the copied
sheet's ID. That link opens the required weekly sheet directly even when a user's prior
workbook state points elsewhere.

## Components

### Configuration

- Remove normalized and example support for `group.agileGroup`.
- Add the `{{weekEndMMDD}}` title token.
- Keep all new schedules disabled by default.

### Daily Fact Service

- Separate content resolution from organization snapshot resolution.
- Add explicit date-range options and organization-repair policy.
- Return structured per-group and per-record failures for aggregation.

### Backfill Command

- Parse and validate command arguments.
- Invoke the same daily fact service with explicit dates.
- Optionally enable organization repair.
- Exit nonzero when any group or record fails.
- Notify configured operations recipients when possible.

### Error Reporter

- Provide one interface for handler, scheduled, batch, and manual-command failures.
- Aggregate record errors and mask identifiers.
- Preserve existing chat and OpenID recipient support.

### Weekly Sheet Writer And Instance Service

- Render the Friday `MMDD` token.
- Copy or recover by title.
- Move the resulting sheet to index `0` before validation and Base registration.
- Attach stage metadata to failures.

## Testing

Automated tests cover:

- Contact values are authoritative for real name, supervisor, agile team, and divisional
  leader.
- No `group.agileGroup` value can reach a fact or weekly bucket.
- Existing complete snapshots survive ordinary content resync.
- Previously unmatched facts fill blank snapshots after matching.
- Organization repair overwrites matched snapshots only in the requested range.
- Ignored facts remain ignored.
- Seven-day inclusive range boundaries.
- Backfill argument validation and idempotent repeated runs.
- Batch errors produce one masked operations notification.
- Every scheduled workflow calls the shared error reporter on terminal failure.
- Friday `MMDD` title rendering.
- New and recovered sheets move to index `0`.
- A move failure does not register a Base instance and the next run reuses the sheet.
- Direct weekly links retain the copied sheet ID.

## Rollout

1. Deploy with all new schedules disabled.
2. Run the complete test suite on the server.
3. Run a read-only contact/fact audit for the chosen repair range.
4. Run backfill with `--repair-organization` once in the personal environment.
5. Verify sampled facts against the contact table and confirm unmatched rows are pending.
6. Rerun the same range without repair and verify idempotency.
7. Create one controlled weekly sheet and verify its `MMDD` title, index `0`, direct link,
   report period, and single Base record.
8. Verify a simulated task failure produces one masked operations message.
9. Enable schedules only in a separate reviewed production decision.

## Acceptance Criteria

- Facts entering AI aggregation have a contact-derived organization snapshot or remain
  pending and excluded.
- No runtime code or config uses `group.agileGroup` as an organization value.
- Explicit backfill can recover data outside the rolling seven-day window without
  duplicates.
- Existing historical snapshots are not rewritten by normal synchronization.
- Recoverable application failures notify configured operations recipients without
  exposing sensitive identifiers.
- A weekly sheet is named from Friday `MMDD`, placed first, linked directly, and never
  duplicated during recovery.
