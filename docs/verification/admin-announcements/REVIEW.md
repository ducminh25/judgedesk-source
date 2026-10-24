# Admin announcements — integration self-review

Date: 2026-10-24. Contract: Implementation Plan P0–P8, AGENTS.md, guidelines.md and CONSTRAINTS.md. Review performed by the implementing agent, as requested; no other model was consulted. This is not a release approval.

## Findings addressed with regression evidence

- **Correctness:** absent nullable read-state fields, idempotent missing/corrupt signed cache, replacement-size LRU accounting and abandoned atomic-write temporary files could violate persistence/cache guarantees. Tests now cover required field presence, missing-only 304 recovery, corruption preservation, exact replacement accounting and lease-protected temporary cleanup.
- **Concurrency:** closing/replacing an article could leave network image requests running or let an old close release a new view. Per-view cancellation, random view IDs and pinned immutable snapshots now bind lifecycle and media authority. Decoder permits remain held until the blocking decoder actually exits.
- **UI:** opening a panel must not mark entries read; only successful text rendering does. Focus could be stolen on each scroll, and browser shortcut defaults could run behind the modal. Regression tests cover one-time scroll restoration, selected-row return focus, Escape priority, inert background, shortcut default prevention, stale response ordering and captured mark-all UIDs.
- **Final native inspection:** empty lists exposed a disabled-first-button focus target, including deletion of the last row. Added a failing regression before fixing both mount/delete fallback paths. Focus chooses an enabled action; while all header buttons are disabled it rests on the focusable panel, then moves to an enabled action only if focus still belongs to the panel. Loading completion does not steal focus from a row or another control. The regression covers last-row deletion and deferred initial reload.
- **Security:** signed HTML remains untrusted. DOMPurify returns an allowlisted fragment converted to fixed React elements without innerHTML. No remote src/href/style/event attributes reach rendering. Native commands resolve signed image/link IDs; the general-purpose opener authority is not broadened. Repeated references to one image are capped at eight occurrences to bound work, not only eight distinct IDs.
- **Publishing:** untrusted content never executes in the key-bearing job. Its Node-built-in signer reconstructs only the feed and hashed media tree. Baseline sequence/hash/revision, approved source pin and current-main checks reject stale publication. Initial Pages environment deployment records required a run/attempt/commit/payload-bound receipt from the preceding isolated signing job, rather than pretending a bootstrap deployment history would remain empty.

## Architecture, maintainability and scope

Shared modules contain data contracts and pure HTML policy. Tauri owns transport, verification, private history, cache, image decoding and narrow link launching. React owns presentation and invokes native DTO commands. No announcement service was added to Express, executor, scoring or sandbox code. Existing app-data resolution and native launcher are reused; no version was bumped. Broad unrelated Linux changes already in the workspace remain uncommitted and preserved.

The implementation is substantial and should be reviewed as phase-sized commits (contract/store, transport/service, UI, publisher/workflow, acceptance documentation), not mixed into the pre-existing Linux work. No commit or push is performed by this review.

## Resource and performance evidence

Feed, HTML, collection, media byte/dimension, state/history, network concurrency and cache limits are explicit and tested. Cache/history pressure returns errors rather than deleting permanent read/deleted records. Images are fetched on demand through native code; thumbnails have their own bounds. Fetches coalesce and cancellation stops queued/network work.

Four 4000×3000 reference images exercise PNG, baseline JPEG, progressive JPEG and CMYK progressive JPEG. Windows release-profile repeated decode observations were approximately 14/19/53/75 ms; sampled peak working set of the test process was 136,683,520 bytes. This is a reference measurement, not proof of every adversarial image's worst case. The image crate's `max_alloc` is best effort; JPEG decoding does not provide a strict total-RSS ceiling through that API. The encoded size, pixel cap and single decoder permit remain enforced. A hard 64MiB OS memory promise is **not** established and must not be advertised as accepted.

## Verification limits and release blockers

Current command outcomes and raw-log names are tracked in STATUS.md/results.json. A failed or timed-out GUI run is not successful merely because an outer process returns zero; acceptance requires the explicit bounded `ANNOUNCEMENT_WEBVIEW_QA` report with `passed: true`.

Production trust now pins the owner-supplied public key, with explicit regression coverage against fixture-key trust. The owner retains the private key; its availability to the signer is not yet verified. Manual signing review by the owner and main-only environment access are configured/read back; secret, source pin and live publication remain pending. Publisher pinning needs a real reviewed source commit containing these tools, not older HEAD or a made-up SHA. Remaining branch/Pages policy, live signed baseline and smoke are required. macOS native WebView and ten installed-package combinations have not been certified by unit tests, WSLg or historical unrelated package results.
