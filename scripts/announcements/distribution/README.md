This is a reviewable distribution-repository staging tree, not an active workflow in the source repository.

Before copying it to `ducminh25/judgedesk`, complete the production key, reviewed source commit, branch/environment protection and bootstrap review in `docs/admin-announcements-publishing.md`.

`announcements/publisher.lock.json` is intentionally absent until there is a real reviewed/pushed source commit containing these tools. Do not substitute a floating branch, the current old HEAD, a test key or an invented SHA. The approved repository/environment variable must pin that same full source commit.

Create an empty `announcements/posts/` directory when preparing the checkout. The initial catalog is an unsigned empty feed. Refresh `publication.generatedAt` to the approved first publication time before signing.

Nothing in this staging directory enables Pages, provisions secrets, changes the public repository or releases an app.
