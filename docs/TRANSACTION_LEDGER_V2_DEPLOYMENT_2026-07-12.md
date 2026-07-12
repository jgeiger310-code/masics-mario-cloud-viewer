# MASICS Review Transaction Ledger V2

Deployment date: 2026-07-12

## Preserved baseline

GitHub itself preserves the complete pre-change code history. The immediately previous production blobs were:

- `index.html` blob: `720740e5f2a5413be49f2d12bb3d232f2d60c4c9`
- `assets/save-captured-change.js` blob: `9cf7af9d808b49019aecf8e1075c5a68e244d3dc`

The Dropbox production tracker observed before deployment was:

- Total records: 2,838
- Reviewed: 1,893
- Excluded: 35
- Pending: 910
- Latest progress server modification: 2026-07-12T11:04:56Z
- Latest audit server modification: 2026-07-12T11:04:52Z

Existing timestamped Dropbox progress and audit files remain untouched. This deployment does not delete, rename, or rewrite historical backups.

## New save architecture

Version: `20260712-transaction-ledger-v2`

Each changed record now uses all of the following safeguards:

1. Immediate local progress save.
2. Durable local offline transaction queue.
3. Append-only Dropbox transaction JSON file.
4. Verified overwrite of the current consolidated progress snapshot.
5. Read-back comparison before the record is considered saved.
6. Append-only audit JSON after successful verification.
7. Recovery-candidate export before local data is replaced by Dropbox state.
8. Device ID, session ID, reviewer, user agent, timestamp, previous value, and new value in each transaction.
9. Automatic retry when the browser reconnects and every 30 seconds while work remains queued.
10. Browser-close warning while work is unsynced.
11. Navigation blocking for Next, Next Pending, and Previous until the current record is verified online.
12. Dropbox progress backup on manual Save Online and after each 10 verified records.
13. Local session-start and pre-replacement backups retained in browser storage.

## Dropbox folders created automatically by the viewer

The first successful V2 save will create files under these paths inside the configured tracker folder:

- `transactions/YYYY-MM-DD/`
- `audits/YYYY-MM-DD/`
- `backups/YYYY-MM-DD/`
- `recovery_candidates/`

## Required validation before normal production review resumes

Use Mario's Windows computer and normal Edge profile.

1. Close and reopen the viewer so the V2 script loads.
2. Sign in to Dropbox.
3. Test one record with a decision and note.
4. Confirm the status reads `SAVED ONLINE ✓`.
5. Move to the next record.
6. Close and reopen Edge.
7. Confirm the test decision and note remain.
8. Confirm new transaction, audit, and backup files appear in Dropbox.
9. Test temporary offline mode and verify the viewer refuses to move until the record is online and verified.

Do not import Mario's earlier recovery export automatically. Compare it against the online tracker record by record and preserve a separate recovery backup before merging.