# Windows local toolchains — read-access checkpoint

Date: 2026-10-13 Asia/Bangkok. Scope: step3B C/C++/Python quick probes, not OSD,
release acceptance, content certification or full kernel-security testing.

## Observations

The source-selected GCC/Python packages in
`C:/Users/mon/AppData/Local/ThemisV2/toolchains/` fail the strict local probe with
`0xC0000022`. The corrected original-path gate uses its own LOCALAPPDATA/APPDATA
and executor copy, confirms canonical native-root containment, then tests those
explicit paths. Log: `artifacts/local-probe-native-original-root-fixed-20261013.log`
(4 tests / 0 pass / 4 fail; all three language probes incompatible).

The corrected copy-controlled gate selects the SAME source executables, clones
their inferred regular toolchain trees using existing staging helpers into its
owned protected cache, then runs the strict local identities against the copies.
Log: `artifacts/local-probe-native-owned-root-fixed-20261013.log`, exit0,4/4.
Native root:
`C:/Users/mon/AppData/Local/Temp/judgedesk-local-probe-native-Lvoigz/localappdata/JudgeDesk/JudgeDeskExecutor`.
Both corrected fixture roots were absent after acknowledged shutdown/cleanup.

The real compiler paths complete compiler -> generated submission -> generated
native checker; Python completes submission-runtime -> checker-runtime. The gate
asserts compatible admission and ready after completion. No resource-only grant,
alternate compiler, manual Verify, original-installation ACL edit or dependency
installation is used. This is positive compatibility pipeline evidence only;
network/private-file/process abuse tests belong to step4, macOS remains NOT_RUN.
The ready assertion is for resolveCachedLocalExecution, not the whole selected
profile/version/certificate resolver or positive desktop UX acceptance.

Measured probe durations, excluding fixture copy: C++3895.6ms, C696.5ms,
Python375.6ms. Overall fixture gate21166.1ms. These are one host/run observations,
not a performance budget, benchmark distribution or promised startup latency.

Earlier original MSYS2 GCC16.1 returns `0xC0000135`; user-installed Python3.12.10
returns `0xC0000022`. [Microsoft NTSTATUS documentation](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-erref/596a1078-e883-4972-9bbc-49e60bebca55)
defines these as DLL_NOT_FOUND and ACCESS_DENIED. The codes alone do not identify
the missing/inaccessible DLL/object. No static-import or native access trace was
collected, so a particular DLL or system policy is not a proven root cause.

## Source evidence and inference

`native-executor/src/request_validation.rs::resolve_local_toolchain` canonicalizes
and bounds the external executable/root. Windows
`WindowsPlatform::initialize_with_root` applies protected read/execute grants to
executor toolchains/artifacts caches. `run_inner` protects the workspace but does
not apply an equivalent external-root read grant. Strict process creation retains
AppContainer/Job Object isolation. A local identity is not itself an OS file grant.

The direct-vs-copy result and that source boundary implicate the external-root
access/loader environment. It does NOT prove every local compiler is incompatible,
that the pipeline is broken, or that copying the whole toolchain is the production
solution. Source metadata, dependencies, ACLs and in-place mutation still need
an explicit design. Copying a user-chosen broad directory can expose unrelated
data and cost time/disk; do not promote this harness behavior into production.

## Harness incident and recovery

The first copy run passed4/4 but incorrectly assumed
`JUDGEDESK_EXECUTOR_TEST_ROOT` controlled the release binary. It used the real
executor cache instead. Its log is excluded from owned-fixture acceptance.
Only its two newly created `owned-local-gate-0/1` directories were moved, after
executor shutdown and exact path/no-link checks, into this recoverable directory:

`C:/Users/mon/AppData/Local/Temp/judgedesk-probe-recovery-15642d5890c24e7e8e73db0b85ccc254/`.

Original installed packages and unrelated caches were left intact. Corrected
gate uses process-scoped LOCALAPPDATA/APPDATA, owned binary copy and a canonical
containment assertion BEFORE any local probe or toolchain copy; it restores the
environment and retains files on unconfirmed cleanup. Concurrent native probe
and full build previously caused staged-executable EBUSY; final verification is
sequential. Neither failure was hidden by retries inside production code.

## Product acceptance still open

Core or Full users selecting a custom compiler must not need to grant broad OS
permissions, manually certify it, or switch to weaker execution. Normal discovery
should check compatibility automatically, retain the selected path, and display
the actual pending/incompatible diagnostic. Until source-path execution works
with bounded read authority and negative kernel tests, step3 is not complete.
Do not ship this checkpoint as universal local-toolchain compatibility.

Next work: design the minimum selected-toolchain read/snapshot boundary on Windows;
reuse the existing `snapshot.ts` and certified-local deployment primitives first.
Windows C++ already has a stronger certificate/snapshot resolver path; these
generic direct probes do not replace it. Do not invent a second snapshot store
or claim that generic compatibility equals certification.
Test arbitrary private paths, symlinks/reparse points, compiler/runtime roles,
mutation/TOCTOU, limits and teardown. Keep the selected compiler identity and no
fallback invariant. Native changes require an intentional reviewed refreeze of
step1, followed by full gates; do not replace the frozen pin opportunistically.

## Final regression verification

`artifacts/local-probe-3b-check-full-final-20261013.log` exited0 after the native
gates finished: Rust9/9, server912 tests /902 pass /0 fail /10 pre-existing skips,
live corpus25, checker parity67 across all four tiers, version lockstep1.5.5.
All30 frozen raw inputs and the staged executor hash/size matched the receipt
after gate completion. No original-path failure was reclassified as PASS.
Product acceptance above remains open despite the passing regression gate.
