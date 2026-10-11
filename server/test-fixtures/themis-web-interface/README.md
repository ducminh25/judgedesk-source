# Pinned Themis web log reader

`judgelog.cjs` is the unchanged `controls/judgelog.js` from
https://github.com/natsukagami/themis-web-interface/tree/d0cc685330f1d572b977ea73685ff5396323d15e.
Only its filename/line endings are adapted for this ESM test repository.
The upstream MIT license is retained alongside it.

Compatibility tests execute this fixed reader in an isolated VM with narrowly
scoped dependency doubles. They exercise the actual upstream parsing algorithm
without installing the archived web application's dependencies. The number
parser double accepts the invariant ASCII decimal numbers emitted by JudgeDesk;
this is not a CLDR locale test or a full website/browser end-to-end test.
Filesystem lookup uses the real filesystem. Score/user-log persistence and debug
logging are inert test doubles. No student code or remote code is evaluated.
