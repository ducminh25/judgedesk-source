# Native envelope verification — reproduction and self-review

Historical envelope-only evidence. The module now also contains payload validation; see [metadata validation](METADATA-VALIDATION.md) for current dependencies/tests. The isolated four-dependency harness below describes the earlier source and cannot compile the expanded module unchanged.

Scope: the raw-envelope trust boundary only. The exported function accepts bounded JSON bytes plus an explicit trusted-key map and returns authenticated opaque payload bytes. It does not parse payload metadata, sanitize HTML, fetch media, cache data, expose IPC commands or run at startup.

## Evidence

- Rust 1.97.1 on local Linux/WSL: nine tests passed, zero ignored/filtered. Clippy `--all-targets -- -D warnings` passed.
- After toolchain restoration, the normal Windows Tauri test-profile build succeeded; `cargo test --locked --manifest-path src-tauri/Cargo.toml announcements` passed all nine announcement tests, zero ignored, 24 unrelated library tests filtered by this focused command. This removes reliance on the isolated harness for Windows compilation evidence.
- Node-created public golden vector verified by ring; payload bytes and SHA-256 match the committed fixture.
- The three direct crates were explicitly approved by the user. Cargo updated only the app package's dependency edges; no new crate versions were introduced. Local crate metadata reports serde/base64 `MIT OR Apache-2.0`, ring `Apache-2.0 AND ISC`. This is not a new ecosystem-wide advisory audit.
- Earlier Windows full gates stopped for missing tools. The user subsequently installed Build Tools 2022 and Windows SDK; current full-gate outcomes are recorded in STATUS/results separately from those historical failures. Focused module tests do not substitute for full gates.
- No macOS, complete Linux Tauri build, Windows GUI/release build or installer validation is claimed.

## Normal app command

With the complete native build environment and app resources available:

```sh
cargo test --locked --manifest-path src-tauri/Cargo.toml announcements
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

## Isolated Linux reproduction

For a module-only spike, create the following local ignored manifest at `docs/verification/admin-announcements/artifacts/native-verifier/Cargo.toml`:

```toml
[package]
name = "judgedesk-announcement-verifier-spike"
version = "0.0.0"
edition = "2021"

[lib]
path = "../../../../../src-tauri/src/announcements/mod.rs"

[dependencies]
serde = { version = "=1.0.228", features = ["derive"] }
serde_json = "1"
ring = "=0.17.14"
base64 = "=0.22.1"
```

Seed its lockfile from `src-tauri/Cargo.lock`. Run `cargo test --offline --manifest-path <spike-manifest>` once to resolve only the spike root, retaining existing locked package versions; then run test and Clippy with `--locked --offline`. Use a dedicated native target directory outside the Windows app target. The recorded run used serde_json 1.0.150, serde 1.0.228, ring 0.17.14 and base64 0.22.1, matching the app lock. The harness compiles the real source module and its tests through the path above, rather than a copied implementation. Its local manifest/lock/build logs are ignored artifacts.

## Adversarial self-review

No other model or agent was used, as requested. This is self-review, not independent review.

| Failure mode | Evidence / action |
| --- | --- |
| Duplicate JSON keys disappear after parsing to Value | Deserialize raw JSON directly into a closed envelope struct. Duplicate plain/escaped `keyId` fields are rejected by tests. |
| Serde can deserialize a struct from a positional array | Added a regression test; it failed by accepting the signed envelope as an array. Enforced object root before deserialization. Apply the same object-only contract to future nested payload structs. |
| Lossy UTF-8 conversion or BOM removal changes interpretation | Use fatal UTF-8 conversion and ordinary JSON parsing; invalid bytes, lone surrogates, BOM and trailing values are rejected. |
| Base64 aliases or excessive allocation | Bound encoded/decoded sizes before decoding; STANDARD rejects invalid padding, pad bits, whitespace and alternate alphabet. Exact envelope/payload limits and the next byte are tested. |
| Valid signature belongs to another protocol or key ID | Bind fixed domain prefix, key ID, newline and original payload bytes; wrong domain/ID/key and byte tampering are tested. |
| Verified HTML gets rendered as trusted markup | Public API returns bytes with explicit validation/sanitization requirements; no app rendering or cache path consumes them yet. |
| Tests accidentally establish production trust | Fixture key is supplied only inside tests. No production key map/configuration or private key is introduced. |
| Isolated tests conceal integration failures | Keep the mandatory gate failures visible and P1 incomplete. The harness only proves this module compiles/tests on the recorded Linux toolchain. |

Initial tests failed for the absent verifier. After implementation, seven tests passed; the positional-array regression then failed before its fix. Boundary coverage brought the final total to nine. Clippy initially caught a manual multiple-of check and a complex test return type; both were corrected without lint allowances, then Clippy and all nine tests passed.
