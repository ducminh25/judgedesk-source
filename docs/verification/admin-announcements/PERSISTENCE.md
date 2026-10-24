# Announcement persistence boundary — 2026-10-24

This is the P2 native store foundation. It is not connected to app setup, IPC, networking or UI yet. No other model/agent was used for review.

## State and ownership

`AnnouncementStore::open(app_data_root, trusted_keys)` requires an existing app-data directory. The caller must use the existing canonical `get_app_data_dir()` root when the service is wired; the store appends only `announcements/`. It does not derive a different root from Core/Full or installer type. Startup failures must remain feature-local and must not fail application/backend startup.

The store holds a lifetime OS file lock using existing fs4, and serializes mutations under its own mutex. All paths are internal constants, random temporary names or validated payload hashes. Existing core storage primitives validate directory chains and detect symlinks/reparse points; no sandbox primitive or new dependency was introduced.

```text
announcements/
  store.lock
  state.json
  feeds/<payload-sha256>.json
```

Private state schema v1 contains `schemaVersion`, `localRevision`, `activeFeed: {payloadHash, sequence} | null`, `fetch: {checkedAt, etag, lastModified} | null`, and `uids`. The active pointer's sequence/hash is the high-water mark: it is never persisted separately or reset when a signed feed is empty. There is currently no operation that clears that pointer.

Each UID record retains status (`readAt`, `deleted`) and observed publication date, revision and item hash. Records survive absence from later feeds. New revisions preserve read/delete; decreasing revision, changing the publication date, or changing item content without increasing revision is rejected. Item hashes use the validated typed item's deterministic Rust serialization, not the raw feed's object-key order. Feed hashes bind exact authenticated payload bytes.

Opening a store rechecks state shape/bounds, duplicate fields/UID map keys, signature, payload schema, active hash/sequence and active UID history. Missing/corrupt state beside cached blobs is an error. No reset or stale-backup recovery silently resurrects deleted items. This does not defend against the local OS owner deliberately replacing/deleting the entire data root or replaying a complete old state/cache set.

## Transaction contract

1. Verify envelope and payload using the store's explicit trusted keys outside the mutation mutex.
2. Acquire the mutex; reject rollback or equal-sequence/different-hash equivocation against the latest committed state.
3. Merge into a clone of that state, including user mutations committed while verification ran. Validate history/counters and the 16 MiB serialized cap before changing the pointer.
4. Ensure the immutable envelope blob exists and verifies at its internal hash path. Write a new blob via same-directory create-new temporary file, write/sync/close and rename.
5. Write pointer, high-water mark, UID state and validators together to a state temporary file, sync/close and replace state in one rename. There is no backup-rename gap.
6. Immediately publish the committed state to memory. No fallible operation follows the state rename before memory publication.

User read/delete/mark-all operations follow the same cloned-state commit pattern. A failed write leaves memory and the prior file intact. Local revision increments only for committed changes; repeated identical operations are idempotent. Mark-all accepts at most the captured 100 UIDs, never a global boolean that could mark later arrivals read. Snapshot statuses include only current-feed items; historical records stay in native storage.

An identical refetch still checks its cached blob: it can restore a missing blob from the freshly authenticated bytes without changing read/delete or local revision. A corrupt existing blob returns an error and preserves evidence. HTTP 304 handling, error presentation, cache GC and media pinning are separate service work.

The file replacement uses [Rust's standard rename API](https://doc.rust-lang.org/std/fs/fn.rename.html), not a custom Win32 protocol. Tests cover process termination around the transaction and actual Windows replacement/locked-file behavior. They do not simulate power loss or guarantee durability on every filesystem/controller. Directory syncing and broader hardware/filesystem acceptance are not claimed here.

## Self-review findings

| Challenge | Result |
| --- | --- |
| Deserialize missing optional fields as None | A regression demonstrated missing `readAt` silently became unread. Required-nullable field deserializers now require presence, including fetch header slots. Explicit JSON null remains valid. |
| Same-feed early return ignores disk state | A regression deleted the active blob and refetched identical bytes; the early return incorrectly reported success. Cache checking/restoration now runs even when no mutable state changes. Corrupt cache does not get silently overwritten. |
| Verification begun before delete writes an old state | A bounded channel-controlled concurrency test pauses after verification, commits read/delete, resumes refresh and verifies both survive restart. |
| Pointer advances before bytes are durable | Real child processes exit after blob storage, after state-temp sync, and after completed commit. Restart sees old/old/new feed respectively, with tombstones retained in all cases. |
| Second process races the store | The lifetime fs4 lock is tested in the same process and a real child process. |
| File replacement fails on Windows | A real handle denying delete-sharing blocks rename; memory/file remain unchanged, and the operation succeeds after releasing it. |
| Limit handling discards tombstones | A valid state exactly 16 MiB refuses a growth-causing read update and preserves the full prior file. Oversize reads and safe-integer revision exhaustion also fail closed. No pruning is used to reach green. |
| Linked directories leak writes outside the feature | Tests reject an actual Windows junction (Unix branch uses symlink) and nonregular state files without altering the separate owned target. Existing platform storage helpers are reused. This is not a guarantee against concurrent path replacement by the owning OS user. |
| Storage failure is equivalent to real disk-full coverage | Injected precommit I/O errors verify failure propagation and state preservation; they do not fill the host disk. Actual disk-full/permission-denied and native macOS/Linux filesystem tests remain acceptance work. |

## Evidence

Focused Windows Tauri tests: 32 passed (16 existing envelope/metadata + 16 store), zero ignored, 24 unrelated library tests filtered. Clippy `--locked --all-targets -- -D warnings` passed. Logs under ignored `artifacts/`: `store-red.log`, `store-corruption-red.log`, `store-idempotent-cache-red.log`, and `store-final-focused.log`. The normal complete gate is recorded separately in STATUS/results.

No network request, production signing key, Node service change, executor/sandbox/compiler/scoring change, notification rendering or installer migration is part of this slice. Temporary feed blobs/state temps can remain after a process crash; later bounded cache GC must account for active/pinned feeds before this is shipped. Do not treat the source-level common-root contract as completed Core/Full/package-matrix QA.
