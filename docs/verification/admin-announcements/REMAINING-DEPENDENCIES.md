# Remaining announcement dependency proposal — 2026-10-24

Status: all six direct packages explicitly approved by the user and installed on 2026-10-24, after the frozen P2 gate passed. This is the applied diff for the remaining HTTPS/media/HTML work. The already approved serde/ring/base64/chrono/percent-encoding are not part of this request.

## Manifest changes proposed

`src-tauri/Cargo.toml`, direct dependencies:

```toml
reqwest = { version = "=0.13.4", default-features = false, features = ["rustls-no-provider"] }
rustls = { version = "=0.23.42", default-features = false, features = ["ring", "std", "tls12"] }
image = { version = "=0.25.10", default-features = false, features = ["jpeg", "png"] }
```

`package.json`:

```json
{
  "dependencies": { "dompurify": "3.4.17" },
  "devDependencies": { "jsdom": "30.1.3", "@types/jsdom": "30.0.0" }
}
```

These entries append to existing sections, not replace them. Resolved transitive dependencies are part of installing these pinned packages; review and record their exact lockfile delta after approval. Do not upgrade unrelated existing packages or reduce tests/audit policies to make resolution succeed.

## Need and scope

| Direct package | Why it is needed | Checked evidence / scope |
| --- | --- | --- |
| reqwest 0.13.4 | Bounded native HTTPS, fixed endpoints, no redirect, conditional requests and timeout control | Version already in Tauri lock. Targeted Cargo feature tree shows updater already enables rustls-no-provider/json/stream. Reuse that TLS graph; no default AWS-LC provider, cookies, compression, HTTP/3 or new system-proxy feature. |
| rustls 0.23.42 | Explicitly initialize the existing ring provider before announcement HTTP; updater initialization is lazy | Version and ring/std/tls12 features already in the Windows app graph. No second provider is introduced. Validate the other native platforms and HTTPS spike before service integration. |
| image 0.25.10 | Decode actual JPG/PNG bytes with dimension/resource checks; file extension and hash do not establish decoder safety | New decoder graph. Only jpeg/png features, no default rayon/all-formats. Minimum Rust 1.88 is below the local 1.97 toolchain. |
| DOMPurify 3.4.17 | Reviewed DOM sanitization in the publisher and each WebView before conversion to React nodes | Runtime package, includes its types; @types/dompurify is unnecessary. Current release includes namespace/literal-text edge hardening. |
| jsdom 30.1.3 | Real DOM for publisher sanitization and Node DOM interaction/security tests | Dev/tooling only; never imported into the frontend bundle. Registry engines support the project's Node 24.19.0. The current release fixes interaction performance and cross-origin XHR credential/cookie handling. Publisher/test DOM must still disable script execution and resource loading. |
| @types/jsdom 30.0.0 | Strict TypeScript types for the above tooling | Separate dev package because jsdom's registry metadata supplies no bundled types. Avoid any/suppressions or inventing a fake DOM declaration. |

No browser-side direct fetch replaces native transport. The proposed reqwest flags preserve the existing app/updater feature set: proxy environment variables supported by that client remain available; automatic system settings/PAC support is not newly enabled or promised. Any later change to that graph needs a separate concrete review because Cargo features unify across the app.

The image allocation limit is best effort in the library, not an OS memory cap. Enforce strict dimensions and checked pixel/output-size bounds before decode, set max_alloc, serialize validation with the existing planned semaphore, reject APNG, and measure the actual jpeg/png decoder paths before claiming the memory budget. This approval does not waive those P0/P3 gates.

## Sources and checks

- Before approval/install, read-only `npm view` verified exact versions, licenses, DOMPurify types/dependency metadata, jsdom engines and @types/jsdom transitive type dependencies. DOMPurify is MPL-2.0 OR Apache-2.0; jsdom and @types/jsdom are MIT.
- Targeted `cargo tree --locked --offline --target x86_64-pc-windows-msvc -e features -i reqwest` and `-i rustls` verified the existing app graph. An unfiltered offline metadata query failed for an uncached Android-only package; it did not alter manifests/locks. No new crate was installed to work around that inspection limitation.
- [reqwest flags](https://docs.rs/crate/reqwest/0.13.4/features), [rustls flags](https://docs.rs/crate/rustls/0.23.42/features), [image manifest/features](https://docs.rs/crate/image/0.25.10/source/Cargo.toml), [image limit guarantees](https://docs.rs/image/0.25.10/image/struct.Limits.html).
- [DOMPurify release](https://github.com/cure53/DOMPurify/releases/tag/3.4.17), [jsdom release](https://github.com/jsdom/jsdom/releases/tag/v30.1.3), [DOMPurify's DOM/security guidance](https://github.com/cure53/DOMPurify).

Before release, run the package-manager advisory checks against the resulting exact lockfiles and triage findings without blindly upgrading the workspace. Existing package versions in a lockfile are not a claim of a completed vulnerability audit. No production key, Pages deployment or release action is requested here.

## Applied graph review and verification

- Npm added 38 lock entries, including the three approved direct packages. No previously locked package path changed version or was removed. Install/audit reported zero vulnerabilities. npm warned about the pre-existing esbuild install-script policy; no allowScripts policy or approval was changed, and frontend build passed.
- Cargo added six package versions: byteorder-lite 0.1.0, image 0.25.10, moxcms 0.8.1, pxfm 0.1.30, zune-core 0.5.3 and zune-jpeg 0.5.15. PNG/num-traits/bytemuck already existed. All reviewed MSRVs are <=1.88 and licenses are permissive/dual-permissive (MIT/Apache/Zlib/BSD/Unlicense options). No pre-existing package version was added/removed/upgraded.
- Deep edge review found Cargo's initial resolution and `cargo update --workspace` both opportunistically redirected broad Windows-sys/getrandom ranges in existing packages. Registry requirements confirmed these are legal deduplications, but they are unrelated to announcements. To preserve the previous graph, mechanically seeded the final lock with the six package blocks and app edges emitted by Cargo, retaining all other baseline package blocks. No package version/checksum/dependency definition was invented. Cargo `--locked` Clippy and tests validated the resulting complete graph; diff against the captured baseline is only 55 added lines. This scoped lock seeding is recorded explicitly, not presented as an untouched resolver output.
- Reqwest and rustls enabled-feature sets are identical to the baseline; image enables only jpeg/png. No system-proxy/default-provider/all-format feature was added.
- Strict TypeScript and runtime DOMPurify/jsdom fragment API probe passed. Frontend build passed into an ignored QA output directory. These are dependency/API evidence, not a complete HTML sanitizer or native WebView test.
- Native API probes passed for HTTPS-only client construction/HTTP rejection with the ring graph, JPG/PNG decoding with strict dimension controls, and raw binary Tauri response body. They make no external request and do not prove live TLS, malicious-image safety, actual IPC or platform WebView rendering. Focused total: 35 announcement tests passed, zero ignored, 24 unrelated library tests filtered; Clippy clean.
- Npm audit after install reported zero vulnerabilities. An OSV exact-version lookup returned no advisory for the six newly resolved Cargo package versions. Cargo-audit is not installed; this is not a full RustSec/cargo-audit scan or a security guarantee.

Local ignored evidence: before/after snapshots, remaining-lock-delta.json, feature trees, remaining-preserved-focused.log, dom-dependency-probe.ts, frontend-dependencies.log, npm-audit-after-remaining.json and osv-remaining.json. The normal full gate after graph preservation is recorded in STATUS/results. No app transport/decoder/sanitizer path has been wired yet.
