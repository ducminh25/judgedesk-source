# Publisher activation review

Initial read-only recheck before owner-key setup: 2026-10-24. Distribution main was at `d775dcffdffc6093cd3691263f22dc1a2ba5fc61`, unprotected, Pages disabled. That inspection modified no remote state. Subsequent owner-authorized environment setup is recorded below.

All six action SHAs in the staged workflow were resolved through the official `actions/<repository>/commits/<sha>` API and matched exactly:

| Action | Verified commit |
| --- | --- |
| checkout | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| setup-node | `820762786026740c76f36085b0efc47a31fe5020` |
| upload-artifact | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` |
| download-artifact | `3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c` |
| upload-pages-artifact | `7b1f4a764d45c48632c6b24a0339c27f5614fb0b` |
| deploy-pages | `d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e` |

The pinned upload-pages-artifact composite's `action.yml` was also read from that exact commit: its nested upload-artifact uses full SHA `ea165f8d65b6e75b540449e92b4886f43607fa02`, rather than a floating action tag. This verifies referenced source identity, not a comprehensive audit of GitHub Actions or a successful workflow execution.

The publisher separates untrusted author HTML/media build from the private-key job. Sign/deploy consume a separately approved immutable source pin and protected current main. The signer uses Node built-ins, matches the derived public key to trust, verifies the production baseline and reconstructs only fixed index/feed/hashed media outputs. No author HTML is copied into executable Pages documents. Predeploy rechecks main/baseline; bootstrap authorization is tied to the signing job's exact run/attempt/commit/payload; smoke verifies live signed bytes and bounded media samples.

The reviewed source pin is deliberately absent until the new tools/public trust exist in a real reviewed and pushed source commit. No old HEAD, fabricated commit, test private key, sequence-zero interpretation of 404 or alternate feed is substituted.

## Owner-authorized public root and manual approval

The owner supplied `announcements-v1`; its raw 32-byte public-key SHA-256 is `77b1610dfaef5f7a5d09c9e698cdc329b28708cf1880360669ea838381dce195`. It is pinned in shared trust; production-root regression tests reject the test signer, including its envelope relabelled with the production key ID. Public-key import/format checks do not prove that a corresponding private key is available to CI.

The owner chose manual GitHub approval before each signing job. Created the previously absent `announcements-signing` environment and read back its policy: required reviewer `ducminh25`, exactly branch `main`, no tags, public key-ID variable set. The owner may approve their own initiated run; approval remains explicit. Request bodies and sanitized read-back are stored beside this review. No private key was read or uploaded, and the environment has no signing secret. Main protection, workflow/source pin and Pages were not changed in this step. Sources: [environment API](https://docs.github.com/en/rest/deployments/environments), [branch policies](https://docs.github.com/en/rest/deployments/branch-policies), [manual review semantics](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/review-deployments).
