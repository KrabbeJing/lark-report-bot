# Personal Weekly Instance Verification

- Branch: `codex/weekly-instance-dynamic-template`
- Verified commit: `0162c95`
- Verification date: `2026-07-12`
- Template locator: passed
- Module 1 metric count: `6`
- Module 2 project count: `5`
- Module 3 department count: `5`
- Module 3 target widths: every current and next content type is `3`
- Recovery ensure: reused the existing copied sheet and created the missing Base instance record
- Second manual ensure: reused the same persistent instance
- Copied sheet count for the weekly title after both runs: `1`
- Weekly-instance Base row count for `2026-W28`: `1`
- Report period target: dynamically located
- Report period read-back: `2026-07-06 至 2026-07-10`
- Template unchanged: confirmed; the copied sheet differed only at the report-period target
- AI content, poster, and group publishing: not executed
- `weeklySheet.enabled` after verification: disabled
- `weeklyInstanceCreation.enabled` after verification: disabled
- Local test suite at verification: `139` passed

The first live attempt copied the sheet and wrote the report period, then failed while
serializing the Base hyperlink field. The verified fix writes hyperlink fields using the
OpenAPI object shape and safely recovers by title without creating another sheet.
