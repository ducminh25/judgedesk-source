# Announcement metadata boundary — 2026-10-24

This slice implements the Rust payload parser after exact-byte signature verification. It does not fetch, cache, sanitize or display announcements. No other model/agent was used for review.

## Contract and entry point

`verify_signed_envelope(raw, trusted_keys)` authenticates original bytes. Pass those bytes directly to `parse_payload`; do not parse through `serde_json::Value` first, which loses duplicate-field evidence. The public DTOs describe wire data, not a trusted/sanitized HTML type. Future service code must use both functions before committing a feed. Rendering still requires the planned sanitizer and image validation.

The parser caps raw bytes before allocation, uses fatal UTF-8, closed typed structures and object-only visitors at every nested object boundary. Present null values are rejected even for optional fields. It validates safe integers, calendar dates/canonical UTC timestamps, UID/asset/link identity and uniqueness, text/HTML limits, image roles/formats/byte declarations, exact HTTPS link scope and compact serialized size. Image metadata is not proof that a file decodes safely.

Dependencies approved by the user: chrono 0.4.45 (std only) and percent-encoding 2.3.2, in addition to the previously approved serde/ring/base64. Both new crates already existed in the app lock; only two direct app edges were added in this slice. No crate version changed. Their licenses are MIT OR Apache-2.0. URL parsing reuses `tauri::Url`.

## Adversarial findings and resolution

| Attempt to disprove the boundary | Resolution / evidence |
| --- | --- |
| Serde derived structs accept positional arrays | Object visitors enforce maps at root, item, locales, content, image and link boundaries; shared invalid cases cover each. |
| Optional fields accept explicit null or duplicate aliases | Custom optional deserialization rejects present null. Raw native-only tests cover duplicate plain/escaped fields and nested image/link fields. |
| Rust whitespace or string length differs from Node | Count Unicode scalars and explicitly match ECMAScript trim whitespace; shared cases cover emoji, lone surrogates, BOM, NEL and UTF-8 byte limits. |
| Timestamp regex accepts impossible dates or leap seconds | chrono parsing plus canonical reformat comparison; tests cover invalid dates, leap years, UTC millisecond shape and chronology. |
| Percent-encoded traversal passes a prefix check | Existing URL parser plus segment decoding rejects traversal, separators, double encoding, malformed UTF-8 and ambiguous canonical forms. Only the distribution repo and Pages path are allowed. |
| Passing the same cases means parsed values agree | Initial acceptance-only tests missed numeric differences. Added Node-normalized expected values for every valid case and explicit decimal/exponent edge cases. This produced a genuine failing regression. |
| serde_json default number conversion preserves JS semantics | False at tested boundaries: `1000000000000000.1` became an integer and `9007199254740990.9` produced a different accepted value. Enabled the existing crate's `float_roundtrip` feature; all normalized comparisons then passed. No custom numeric parser or new crate was added. |
| A short numeric token avoids the aggregate size cap | Raw and compact serialized caps both apply; a native test uses exponent-form revisions to cross the latter cap. |
| A valid signature authorizes malformed metadata/HTML | A signed empty feed is accepted; a signed unsupported schema is rejected. Unsafe HTML remains unchanged at this boundary and is explicitly untrusted. |
| App-wide JSON feature changes are isolated to this module | Cargo features unify within the app graph. The complete normal gate is required in addition to focused tests; no claim that the feature affects only announcement parsing. |

The number conversion fix uses the pinned [serde_json 1.0.150 feature](https://docs.rs/crate/serde_json/1.0.150/features) and its [parser implementation](https://docs.rs/serde_json/1.0.150/src/serde_json/de.rs.html), rather than an ad-hoc parser. Floating-point conversion here is solely JSON metadata compatibility; scoring logic and its rational contract are unchanged.

## Reproduction and scope

- `node --import tsx --test scripts/announcements/payload.test.ts scripts/announcements/signatures.test.ts scripts/announcements/parity.test.ts`: 170 passed, zero skipped.
- Strict scoped TypeScript compilation, including the new corpus test: passed without compiler-setting changes.
- `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`: passed.
- `cargo test --locked --manifest-path src-tauri/Cargo.toml announcements`: 16 passed, zero ignored; 24 unrelated library tests filtered. Actual Windows Tauri test profile, not an isolated model replacement.
- Complete `npm run check:full`: exit 0, all nine Rust steps, 1,160/1,170 server tests passed (zero failed, ten existing conditional skips), static checker parity and version lock passed.
- Additional core run with `--features serde_json/float_roundtrip`, selecting library, API, discovery, rational, scoring and well-formed input targets: 51 passed, zero ignored/filtered. No source changed between focused/full/additional verification.
- Shared corpus: 154 common raw JSON cases, compared for acceptance and accepted values; five additional duplicate-key cases for the strict native raw parser. Node's metadata API validates already parsed objects, so it does not claim raw duplicate-key rejection.

Local ignored logs: `artifacts/model-rust-red.log` (initial absent implementation), `model-value-parity.log` (numeric regression), `model-float-roundtrip.log` (Clippy and native green), `model-node-final.log`, and `check-full-model.log` (complete gate status recorded in STATUS/results).

The earlier Linux isolated verifier instructions in NATIVE-VERIFIER.md describe the envelope-only source at that time. The current module also imports Tauri URL parsing, chrono and percent-encoding; the old four-dependency harness is not a reproduction of the full metadata module. No new Linux/macOS native or package-matrix result is claimed by this slice. Native fetch, persistence, HTML sanitization, image decoding, UI, production trust and Pages deployment remain separate work.
