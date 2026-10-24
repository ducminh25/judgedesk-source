# Proposed publisher source commit scope

Decision: 2026-10-24. The owner selected **retain local changes and personally choose/commit/push the source revision**. The agent must not create a publisher branch, commit, push or PR. No such Git mutation was performed by this proposal. Source pinning waits for the owner's actual pushed full 40-hex commit SHA.

The main checkout contains extensive unrelated Linux work. In particular, its package manifest also differs from HEAD in the existing Tauri CLI version; that is not part of the three approved npm additions for announcements and must not be silently included or reverted.

The unselected isolation proposal is retained below as scope-review history, not authorization to act. It would have included only:

- Publisher implementation/tests in `scripts/announcements/`, with the distribution workflow remaining a staging template in that source repository.
- Shared announcement DTO/schema/HTML policy/approved public trust and announcement fixtures required by those tests.
- Exactly the approved DOMPurify runtime and jsdom/@types-jsdom dev dependency declarations and their required lock entries. Preserve baseline package versions, app version, scripts and unrelated CLI declaration. Validate the resulting clean lock with normal npm commands; do not transplant the entire dirty lockfile.
- Admin guide and relevant publisher/security evidence. Revalidate the executor receipt's raw package input if required by the clean branch, preserving binary pins and all assertions.

Do not include the unrelated Linux implementation, native/UI feature wiring or whole dirty-tree snapshot merely to obtain a publisher SHA. Run the publisher tests/type/quality gates against the materialized isolated source, review its diff, and run applicable complete project gates before committing/pushing. Create/attach a PR if authorized; do not manufacture a source SHA, substitute an older HEAD lacking the tools, or merge unreviewed changes to make bootstrap pass.

Only after the actual reviewed source commit is available can distribution `publisher.lock.json` and separately approved repository/signing-environment variables pin it. Branch/environment protection and the owner's private-key secret must precede actual signing. A publisher-only source pin does not certify the app's pending macOS/package/resource acceptance.
