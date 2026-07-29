# macOS per-run guardian — design và foundation checkpoint

Ngày chốt thiết kế: 2026-07-29
Trạng thái: **production native path đã vượt targeted Apple-Silicon security/fault gates; local packaged smoke đã verified, còn full fault matrix, performance và signed updater D16 pending**

## 1. Mục tiêu và phạm vi

Tài liệu này khóa thiết kế cho lớp bảo vệ mỗi lần chạy trên macOS của
JudgeDesk. Mục tiêu là bảo đảm một submission, checker hoặc compiler đang chạy
không trở thành tiến trình mồ côi nếu native executor bị dừng cưỡng bức, đồng
thời không cho app generation kế tiếp bắt đầu trước khi process tree cũ đã được
chứng minh là rỗng.

Phạm vi thiết kế:

- kiến trúc `executor → per-run guardian → persistent trusted supervisor → sandbox-exec`;
- authority và lifetime của generation guard;
- protocol, token, framing và state transition;
- containment khi một trusted component gặp lỗi;
- chống thoát process group trên Seatbelt;
- thứ tự kill, kiểm kê, reap và nhả generation guard;
- gate bắt buộc trước khi gọi thiết kế là verified.

Checkpoint hiện tại đã nối protocol, trusted supervisor, fault-trace contract và
các primitive identity/drain vào đường chạy production của native executor. Bằng
chứng hiện có gồm source/native ARM64 gate, checker native/runtime và local ad-hoc
`.app`/DMG smoke trên Apple M1 thật. Nó chưa thay thế packaged GUI/helper fault
gate, notarized release/updater gate hoặc clean-checkout gate của checkpoint checker.

## 2. Trạng thái bằng chứng hiện tại

Các nhãn trong tài liệu:

- **Verified:** đã có bằng chứng runtime trên Apple Silicon thật.
- **Characterized:** đã tái hiện được hành vi hoặc lỗ hổng, nhưng chưa có fix.
- **Pending:** mới là contract hoặc test plan.
- **Not claimed:** nằm ngoài điều JudgeDesk được phép tuyên bố sau workstream này.

### 2.1. Verified từ checkpoint process supervisor trước

- Packaged ARM64 `.app` đã chứng minh single-instance không thay backend
  generation khi mở đồng thời nhiều secondary.
- GUI `SIGKILL` trong một submission dài rồi relaunch đã drain process group cũ
  trước khi generation mới ổn định.
- Helper `SIGKILL` làm backend/executor cũ dừng; primary còn sống giữ recovery
  locks và secondary không được tự dựng backend mới.
- Native executor hiện giữ shared generation guard và không trả shutdown
  acknowledgement trước khi các run đã accepted/active hoàn thành teardown.
- Backend không tự restart native executor trong cùng app generation sau một
  unexpected executor exit có guarded macOS environment.

Các bằng chứng trên chỉ bao phủ process group do executor còn sống hoặc outer
supervisor còn đủ authority. Chúng chưa bao phủ executor `SIGKILL` giữa run.

### 2.2. Bằng chứng đã verified trong quá trình dựng foundation

- Production Seatbelt profile đã deny `setpgid` và `setsid`; với submission,
  checker và security probe còn deny `posix_spawn`. Startup probe kiểm tra cả
  bốn primitive (`setpgid`, `setsid`, `posix_spawn` set-group và raw `execve`).
- Primitive macOS dùng kqueue `NOTE_EXIT`, `waitid(WNOWAIT)`, bounded
  `PROC_PGRP_ONLY` inventory và `wait4`. Test thực tế trên Apple Silicon đã qua
  leader-exit-before-grandchild, stale identity không signal nhầm và guardian
  drain sau executor death.
- Foundation cũ quan sát macOS trả `EPERM` khi gửi group `SIGSTOP` sau khi group
  leader đã thành zombie; kết quả này loại thiết kế deferred-leader cũ. Redesign
  giữ persistent supervisor anchor sống tới sau `PREPARED` và chỉ dùng
  whole-group `STOP/KILL`; per-PID signal không bao giờ được coi là containment
  proof.
- Request validation từ chối biến dynamic-loader và biến control nội bộ trước
  khi chúng có thể tới `sandbox-exec`.

Foundation test run ngày 2026-07-29: macOS 29/29 Rust lib tests + 1/1 binary test,
strict Clippy và format check đều đạt; Windows 22/22 + 1/1 tương ứng đều đạt.
Audit sau test phát hiện fallback vẫn có khe PID/PGID reuse và fault gate có thể
xanh giả, nên kết quả này chỉ xác nhận các unit test đã chạy, không chứng nhận
foundation cũ là an toàn và không phải bằng chứng E2E cho production.

Redesign sau audit đã có thêm bằng chứng trên Apple M1 ngày 2026-07-29:

- Rust đạt 62/62 library tests + 1/1 binary test; Clippy `-D warnings` đạt.
- Native security integration đạt 10/10 bài áp dụng, một bài Windows-only skip:
  TLE và MLE boundary lặp 20 lần, OLE/write/thread/process bomb và cancel đều đạt.
- Fault-injection guardian đạt 5/5 TAP tests: launch ordering, executor
  `SIGKILL`, guardian `SIGKILL` fail-closed không numeric fallback và hai run
  đồng thời cancel độc lập.
- Hai lượt benchmark cuối đều hoàn thành 900/900 no-op, không để lại
  executor/guardian/supervisor/submission. Race `Prepared` hiếm được tái hiện ở
  stress trước đó và đã sửa bằng contract bắt buộc gửi trọn terminal frame cho
  direct executor trước khi guardian kill authority nhận `Prepared`.
- `PROC_PIDTBSDINFO` trả `ESRCH` khi descendant biến mất giữa identity/status
  sampling nay buộc recheck identity: missing thì inventory lại, còn live thì
  retry có giới hạn, mismatch thì fail-closed.
- Trusted child spawn dùng `POSIX_SPAWN_CLOEXEC_DEFAULT`; regression test chứng
  minh ambient descriptor bị đóng và chỉ hai mapping control được giữ.
- Checkout sạch detached đúng GitHub commit `323db233ee0b32f8d42688b80744ed3951a1afb0`
  đã vượt full `build-macos-arm64-sidecar.sh`; sidecar metadata cũng ghi đúng SHA
  này. Local ad-hoc DMG 43,8 MB được tạo bằng CI-safe bundling, mount read-only,
  xác minh ba Mach-O ARM64, deep/strict codesign, V8 JIT entitlement, bundle
  identifier/version và packaged sidecar/secure-runner smoke. SHA-256 của artifact
  đã test là `8c341548a4d3e1d60ddf3bd5b77f9e99f86496cd0778eb30aeb71df5bf177a8b`.
  Finder aesthetics qua phiên SSH riêng lẻ timeout `-1712`; đây không phải gate
  phát hành và CI path cố ý dùng `--skip-jenkins`.

Benchmark evidence sau full security gate, 3 × 100 no-op mỗi lượt trên M1 8 GB
qua phiên remote đang hoạt động:

- adjacent base: end-to-end p50 14,916 ms, p95 18,103 ms;
- candidate checkpoint trước final safety audit: end-to-end p50 28,314 ms, p95
  33,479 ms; dispatch residual
  p50 14,516 ms, p95 17,249 ms;
- candidate lượt trước chịu tải nền cao hơn: end-to-end p50 31,814 ms, p95
  35,567 ms;
- exact source sau final safety patch và benchmark-harness guard: end-to-end p50
  24,618 ms, p95 27,208 ms; dispatch residual p50 13,209 ms, p95 14,133 ms;
  sandbox setup p50 0,407 ms, p95 0,594 ms; backend RSS tăng 8,91 MiB.

Benchmark độc lập trên macOS nay tự provision một generation guard tạm nếu môi
trường chưa có guard, dùng lại guard đầy đủ do app/gate cấp, và từ chối partial
guard environment. Sau phép đo, guard tạm được thu hồi và process inventory rỗng.

Vòng implementation đầu từng đạt khoảng 300 ms/no-op vì quét hơn một triệu file
descriptor trong mỗi trusted child; phương án đó đã bị loại bỏ. Candidate hiện
vẫn không đạt absolute dispatch gate cũ 5/10 ms. Vì vậy checkpoint này chưa được
gọi là performance-release-ready; số đo end-to-end và throughput phải tiếp tục
được giữ như regression evidence, không đổi tên metric để che overhead.

### 2.3. Characterized và đã xử lý trong native path

- Nếu native executor bị `SIGKILL`, shared generation lock do chính executor giữ
  bị kernel nhả, trong khi sandbox process group có thể còn sống. Per-run
  guardian nay giữ một shared guard độc lập tới sau group proof.
- Fallback cũ xác thực process identity rồi mới signal numeric PID/PGID. macOS
  không có `pidfd`, nên vẫn tồn tại khe reuse giữa hai thao tác; đường này bị
  loại khỏi thiết kế mới.
- Launcher cũ `exec` thành target, làm guardian mất direct-parent anchor khi
  executor chết. Thiết kế mới dùng trusted supervisor sống dai, không `exec`;
  chiều guardian chết sau supervisor registration vẫn fail closed vì executor
  không sở hữu direct-child reap pin.
- Header SDK trên máy Mac ghi rõ `NOTE_TRACK`, `NOTE_TRACKERR` và `NOTE_CHILD`
  không còn được hỗ trợ từ macOS 10.5. Không được dùng các flag này làm nền tảng
  descendant tracking.
- Gate hiện tại tìm active child bằng direct PPID của executor. Cách đó không
  còn đúng sau khi thêm guardian.

### 2.4. Pending

- Đạt hoặc duyệt lại bằng evidence một performance budget riêng cho per-run
  guardian, rồi nối budget đó thành blocker trong release workflow. Absolute
  dispatch gate cũ hiện còn đỏ và `build-macos-arm64-sidecar.sh` mới chỉ là
  correctness/security gate; branch này không được dùng để phát hành.
- Instrument riêng pre-target containment setup và post-target drain. Trước khi
  có metric đó, chỉ end-to-end/throughput và target wall time có nghĩa ổn định;
  residual hiện tại không được diễn giải là IPC thuần.
- Thay linear ambient-FD close trong forked target bằng primitive có bound được
  chứng minh trên macOS, kèm regression với soft `RLIMIT_NOFILE` cao.
- Thêm integration regression cố ý kéo dài cleanup để chứng minh target
  `wall_time_us` không tăng theo containment drain.
- Mở rộng fault matrix tới mọi cut-point pre-registration, guardian hang/STOP,
  tám run đồng thời và release soak ở mục 9.7.
- Packaged GUI/helper double-failure gate với guardian đang giữ shared lock;
  local DMG smoke hiện đã verified nhưng chưa bao phủ fault/relaunch này.
- Compiler-specific containment certification.
- Hoàn thiện workflow snapshot/certification trước khi mở lại local/system runtime; source gate managed `checker-runtime`, exact-exec và cancel-drain trên Apple Silicon đã đạt.
- Minimum/current macOS matrix; một máy M1 không đại diện mọi OS được hỗ trợ.

## 3. Threat model

### 3.1. Trusted

- Tauri primary và outer process supervisor helper;
- Node backend;
- native executor;
- per-run guardian;
- persistent trusted supervisor và target child stub trước khi `exec`;
- exact compiler binary đã được JudgeDesk chứng nhận.

### 3.2. Untrusted

- submission executable/script;
- mọi descendant do submission tạo;
- input/output và file trong contest;
- source code đưa vào compiler;
- mọi custom checker, gồm binary native và source chạy qua certified runtime.

### 3.3. Faults phải chịu được

- executor mất control channel, crash hoặc `SIGKILL`;
- guardian crash hoặc `SIGKILL`: trước khi có supervisor phải kết thúc sạch; sau
  supervisor registration phải fail closed, giữ generation và tuyệt đối không
  signal numeric PID/PGID khi chưa có owned reap pin;
- backend mất parent channel;
- GUI hoặc outer helper chết riêng lẻ;
- cancellation/shutdown đua với launch;
- stale, malformed, oversized hoặc sai-auth control frame;
- submission fork, fork storm, parent exit, grandchild sống tiếp và cố đổi
  session/process group.

## 4. Kiến trúc đã chốt

```text
Tauri primary
├── outer process supervisor
│   └── owner lock; exclusive generation lock khi drain
└── backend
    └── native executor
        ├── shared generation guard của executor
        └── per accepted run
            └── per-run guardian
                ├── shared generation guard độc lập
                └── persistent trusted supervisor (direct child, PGID anchor)
                    └── fork + exec sandbox-exec
                        └── untrusted target và descendants trong cùng PGID
```

Một guardian chỉ tồn tại cho một run. Không có guardian nhàn rỗi khi app không
chấm. Guardian không nằm trong untrusted process group.

### 4.1. Authority

- Executor giữ shared generation guard trong toàn bộ lifetime của nó.
- Mỗi guardian tự mở, xác thực và giữ một shared generation guard độc lập trước
  khi gửi `READY`.
- Outer supervisor chỉ lấy exclusive generation lock khi backend/executor đang
  drain hoặc generation mới chuẩn bị bắt đầu.
- Guardian chỉ nhả shared guard sau khi exact persistent supervisor direct child
  đã được reap và hai PGID inventory độc lập đã được chứng minh là rỗng.
- Nếu kiểm kê process thất bại hoặc không chắc chắn, guardian tiếp tục giữ lock
  và fail closed; timeout không được biến thành “tree đã rỗng”.

### 4.2. Không có target-before-dual-ownership

Untrusted code không được chạy ngay sau khi guardian tạo trusted child. Trình tự
production hiện tại là:

1. Guardian dùng `posix_spawn` tạo persistent supervisor với
   `POSIX_SPAWN_CLOEXEC_DEFAULT`; chỉ hai control FD đã map được giữ lại.
2. Supervisor tự trở thành PGID anchor, gửi exact PID/PGID/start identity trên
   cả channel guardian và channel direct tới executor.
3. Guardian gửi bounded launcher spec; supervisor xác thực spec rồi gửi
   `READY`, nhưng chưa fork target.
4. Executor chỉ ghi active cancellation record sau khi identity từ hai
   authority khớp nhau; nó gửi `COMMIT` trực tiếp cho supervisor rồi gửi
   `COMMIT` cho guardian.
5. Guardian chỉ sau đó mới gửi `GO`. Supervisor mới fork target, đưa target vào
   PGID của supervisor, thiết lập rlimit/stdio/signal policy và `exec`
   `/usr/bin/sandbox-exec`.

Guardian là direct parent chưa reap của supervisor. Executor nhận cùng supervisor
identity trực tiếp từ supervisor, không chỉ qua guardian. Hai đường độc lập này
đóng khoảng trống khi guardian chết sau khi tạo supervisor nhưng trước một frame
forward thông thường.

Trước `GO`, executor ghi một active cancellation record chứa tối thiểu:

- run identity;
- guardian identity;
- supervisor PID/PGID và process start identity;
- generation;
- control-channel state.

Nếu executor chết trước `GO`, guardian thấy EOF và drain/reap supervisor khi
target chưa được fork. Nếu guardian chết trước khi supervisor tồn tại, executor
reap exact guardian direct child và chỉ trả `launch_error` sau direct EOF. Một
khi supervisor identity đã được đăng ký, executor không có kernel-backed
direct-child reap pin cho supervisor; guardian loss vì vậy giữ active record và
generation guard vô hạn thay vì signal numeric PID/PGID. Automatic recovery cho
chiều lỗi này vẫn pending.

## 5. Protocol và state machine

### 5.1. Framing và authentication

- Protocol có magic/version cố định `JUDGEDESK_RUN_GUARDIAN/2`.
- Dùng length-prefixed frame, `u32` little-endian, cùng hard maximum với native
  executor protocol; zero-length và frame vượt giới hạn bị từ chối.
- Mỗi guardian có token ngẫu nhiên riêng, tối thiểu 256 bit.
- Mọi frame chứa `token`, `generation` và `runId`.
- Token không xuất hiện trong untrusted argv/environment và không được kế thừa
  qua `exec`.
- Control và registration descriptors phải `CLOEXEC`.
- Parser từ chối unknown field/state transition nếu protocol contract yêu cầu
  canonical frame; không được “best effort” với frame sai.
- Callback/response chỉ hợp lệ nếu đồng thời khớp child process identity, token,
  generation và run ID. Frame đến muộn từ guardian cũ bị bỏ.

### 5.2. Happy path

```text
Executor reserves run
  -> spawn guardian
Guardian validates generation + acquires SH guard
  -> READY
Executor
  -> START(validated bounded spec)
Guardian creates persistent trusted supervisor
Supervisor becomes PGID anchor
  -> REGISTERED(pid, pgid, start identity) trực tiếp tới executor và guardian
Guardian
  -> CONFIGURE(bounded launcher spec)
Supervisor
  -> READY
Guardian
  -> STARTED(same anchor identity)
Executor commits active cancellation record
  -> direct COMMIT; guardian COMMIT
Guardian
  -> GO
Supervisor forks target, closes ambient FD in child
  -> exec sandbox-exec -> untrusted target
Supervisor observes terminal cause
  -> CLEANUP_REQUESTED
Guardian freezes group, authorizes supervisor cleanup, then drains/reaps anchor
  -> PREPARED/CLEANED
Executor emits exactly one RunResult and removes accepted reservation
```

### 5.3. Cancellation và shutdown

- Cancel trước `GO`: target chưa được fork; guardian drain/reap supervisor.
- Cancel sau `GO`: guardian dừng khả năng fork trước, kill toàn group và drain.
- Shutdown lặp cancellation cho cả accepted và active run để bao phủ handoff
  race.
- `RunResult` của mọi accepted run phải được gửi trước `ShutdownResult`.
- `ShutdownResult` không được gửi khi còn guardian hoặc process identity chưa
  drain.

### 5.4. Protocol failure

Sai token/generation/run ID, frame quá dài, truncated frame, EOF, duplicate hoặc
out-of-order frame đều là terminal failure của run:

- trước khi untrusted code chạy: `launch_error`;
- sau `GO`: `internal_error`;
- guardian/executor vẫn phải drain owned tree trước khi nhả guard;
- không tự gắn một guardian mới vào child cũ.

## 6. Seatbelt policy chống group escape

PGID containment chỉ hợp lệ nếu untrusted descendant không thể tự tách khỏi
group.

### 6.1. Submission, checker và security probe

Production profile phải explicit deny:

```scheme
(deny syscall-unix
  (syscall-number
    SYS_setsid
    SYS_setpgid
    SYS_posix_spawn))
```

`fork` có thể được phép theo resource policy, nhưng mọi descendant phải kế thừa
PGID. `posix_spawn` phải bị chặn vì spawn attributes có thể tạo process group
mới mà không gọi `setpgid()` từ code của child.

Gate phải kiểm tra riêng:

- `setpgid(0, 0)`;
- `setsid()`;
- `posix_spawn` với `POSIX_SPAWN_SETPGROUP`;
- fork → grandchild → parent exit;
- fork storm trong kernel process ceiling.

Fixture phải có một control run dưới profile permissive, nơi các escape primitive
thực sự thành công rồi tự cleanup. Sau đó cùng fixture chạy qua production
profile và bắt buộc nhận `EPERM`. Như vậy test không thể pass giả do fixture hỏng.

### 6.2. Compiler

Apple Clang cần `posix_spawn`; compiler profile không thể áp dụng deny giống
submission.

Compiler chỉ được chạy khi:

- executable path, version, target và fingerprint đúng certificate;
- compiler driver là trusted, args do JudgeDesk dựng và không cho user chèn
  plugin/tool tùy ý;
- `setsid` và `setpgid` vẫn bị deny;
- compiler smoke/gate chứng minh toàn bộ observed subprocess giữ PGID;
- executor-crash giữa compile vẫn drain được toàn compiler group;
- certificate bị invalid nếu binary/version hoặc child-process behavior drift.

Kết quả trên chỉ chứng nhận exact compiler đã test. Nó không chứng nhận arbitrary
local compiler và không tự động áp dụng cho compiler/runtime của ngôn ngữ mới.

## 7. Deferred anchor reap và proof rằng tree đã rỗng

Guardian là parent trực tiếp của persistent supervisor/PGID anchor. Supervisor
là parent trực tiếp và là process duy nhất được phép `wait4` target để lấy
verdict/rusage; guardian sở hữu reap của exact supervisor child.

Trình tự terminal:

1. Supervisor quan sát target terminal/limit, chốt mốc wall time và yêu cầu
   cleanup trên cả hai authenticated channel.
2. Guardian xác thực live anchor rồi gửi `SIGSTOP` tới toàn PGID để chặn fork
   race.
3. Guardian gửi authenticated cleanup cho supervisor đang dừng, sau đó
   `SIGCONT` riêng exact supervisor anchor.
4. Supervisor chứng minh mọi descendant còn lại đang stop/zombie, `wait4` exact
   target, dựng một `RunResult`, rồi gửi trọn `PREPARED` cho direct executor
   trước khi gửi cho guardian.
5. Guardian nhận `PREPARED`, gửi `SIGKILL` tới PGID, chờ/reap exact supervisor
   direct child và kiểm kê `PROC_PGRP_ONLY`.
6. Chỉ sau hai inventory độc lập cùng rỗng, guardian mới chuyển kết quả cho
   executor, đóng channel và nhả shared generation guard.
7. Executor chỉ chấp nhận preferred result sau authenticated guardian
   `PREPARED` cộng exact guardian-child exit. Nếu guardian chết trước proof này
   và supervisor đã tồn tại, executor không trả kết quả, không signal numeric
   identity và fail closed giữ generation.

Không dùng các điều kiện sau làm proof duy nhất:

- đã gọi `kill`;
- target hoặc supervisor đã exit;
- `kill(pid, 0)` trả `ESRCH`;
- không còn direct child theo PPID;
- `lsof` chỉ cho thấy lock descriptor đang mở.

Gate phải theo process identity gồm PID và start identity để tránh PID reuse.
Nếu process inventory lỗi, đầy buffer hoặc trả kết quả mâu thuẫn, guardian giữ
generation guard, lặp cleanup và phát diagnostic; không được release theo timeout.

## 8. Single-fault contract

| Fault | Authority còn sống | Kết quả bắt buộc | Trạng thái |
| --- | --- | --- | --- |
| Executor chết trước guardian `READY` | Guardian | Không có child; guardian nhả sau khi xác nhận rỗng | Pending |
| Executor chết sau guardian `READY`, trước supervisor spawn | Guardian | Không target; guardian thoát sạch | Pending |
| Executor chết sau supervisor registration, trước `GO` | Guardian | Drain/reap supervisor, target không được fork | Pending |
| Executor chết sau `GO` | Guardian | EOF → stop/kill/reap group; giữ SH guard tới PGID=0 | Verified trong native fault gate |
| Guardian chết trước supervisor spawn | Executor | Reap exact guardian; run `launch_error`, không có anchor | Pending |
| Guardian chết sau supervisor spawn, trước normal `STARTED` | Executor | Không numeric signal; giữ generation fail closed nếu direct channel chứng minh supervisor đã tồn tại | Boundary verified; automatic recovery pending |
| Guardian chết sau `GO` | Executor | Không trả unproven result, không numeric signal; giữ active record + generation fail closed | Boundary verified trong native fault gate; automatic recovery pending |
| Supervisor chết trước `GO` | Guardian + executor | Reap exact child; đúng một `launch_error` | Pending |
| Backend mất GUI parent channel | Executor + guardians + outer helper | Executor drain; guardians giữ generation barrier | Native barrier verified; packaged composition pending |
| GUI chết | Outer helper + backend/executor/guardians | Backend tree drain trước relaunch | Supervisor path verified; active-guardian packaged gate pending |
| Outer helper chết | GUI recovery + backend/executor/guardians | Backend dừng; recovery barrier được giữ | Supervisor path verified; active-guardian packaged gate pending |
| GUI và outer helper cùng bị kill | Backend liveness + executor/guardians | Guardian SH locks chặn generation mới tới khi tree rỗng | Pending packaged gate |

Mọi single fault chỉ được coi là handled khi test chứng minh process identity cũ
đã biến mất và generation mới chưa thể spawn executor trước thời điểm đó.

## 9. Gate bắt buộc

### 9.1. Protocol/unit gate

- mọi state transition và fault cut-point trước/sau `READY`, registration,
  `STARTED`, `GO`, terminal;
- accepted-before-active cancellation;
- RunResult-before-ShutdownResult;
- wrong/stale token, generation, run ID và process identity;
- malformed, oversized, truncated, duplicate và out-of-order frame;
- stale callback không làm hỏng replacement run;
- external sentinel PID không bao giờ bị guardian signal.

### 9.2. Seatbelt escape gate

- permissive control chứng minh fixture có thể escape;
- production profile bắt `setpgid`, `setsid`, `posix_spawn+SETPGROUP` trả `EPERM`;
- child/grandchild giữ nguyên PGID;
- leader exit trước descendants;
- fork storm bị kernel ceiling chặn và cleanup về baseline.

### 9.3. Native guardian integration gate trên Apple Silicon

- executor `SIGTERM`, `SIGKILL` và control EOF ở mọi launch phase;
- guardian `SIGKILL` trước launch, trong handoff và sau `GO`;
- guardian hang/`SIGSTOP`;
- cancel trước/sau `GO`;
- explicit shutdown với active runs;
- group inventory rỗng, guardian exit và exclusive generation lock chỉ thành
  công sau cleanup;
- unrelated sentinel process vẫn sống.

Để chứng minh lock behavior một cách deterministic:

1. dừng guardian bằng `SIGSTOP` sau registration;
2. kill executor;
3. exclusive generation lock phải còn bị block;
4. `SIGCONT` guardian;
5. exclusive lock chỉ thành công sau khi old identities và PGID đã rỗng.

### 9.4. Concurrent gate

- tám accepted/active runs đồng thời;
- tám guardian và tám PGID riêng;
- cancel một nửa, shutdown phần còn lại;
- mỗi run đúng một terminal response;
- ShutdownResult đến cuối;
- lượt khác `SIGKILL` executor và bắt mọi guardian tự drain;
- generation EX chỉ thành công sau guardian cuối cùng.

### 9.5. Packaged app gate

Với native run đang active, kiểm tra:

- GUI chết rồi helper chết;
- helper chết rồi GUI chết;
- GUI và helper bị kill trong cùng fault injection;
- mở replacement ngay trong drain window;
- không có backend/executor generation mới trong khi old guardian còn giữ SH
  guard;
- old PGID rỗng trước lần đầu quan sát executor mới;
- không overlap backend/executor giữa hai generations;
- replacement parent chain và secure-runner health đúng;
- final shutdown không còn GUI/helper/backend/executor/guardian/submission.

Gate cũ không được dùng `pgrep -P executor | head -1` để suy ra sandbox PGID.
Supervisor/fault-trace fixture phải cung cấp PID, PGID và start identity có thể
kiểm chứng.

### 9.6. Compiler certification gate

- Apple Clang exact version compile/link smoke;
- observed compiler subprocess inventory giữ cùng PGID;
- executor `SIGKILL` giữa compile;
- guardian drain trước generation handoff;
- fingerprint/version drift làm certificate unavailable;
- mỗi compiler profile mới phải chạy lại gate, không kế thừa chứng nhận.

### 9.7. Repetition và evidence artifact

Release soak tối thiểu:

- executor `SIGKILL` với simple tree: 20 lần;
- adversarial child/grandchild: 10 lần;
- fork storm: 5 lần;
- guardian crash: 10 lần;
- ba thứ tự GUI/helper failure, mỗi thứ tự nhiều lần.

Lưu artifact có commit SHA, app hash/signature, `sw_vers`, architecture, exact
toolchain identity, PID/PGID/start identities, event order, duration và verdict.
Không ghi token vào log.

## 10. Giới hạn guardian-loss và double-failure còn lại

Topology hiện tại có một authority sở hữu kernel-backed direct-child reap pin
cho supervisor: guardian. Vì vậy thiết kế tự động drain được executor chết khi
guardian còn sống.

Executor có authenticated direct channel tới supervisor nhưng channel này không
phải `pidfd` và không ngăn launchd reap/reuse PID. Khi guardian chết sau
supervisor registration, executor chỉ được fail closed: giữ active record và
generation guard, không signal numeric PID/PGID và không trả unproven result.
Automatic guardian-death recovery là **Not claimed** cho tới khi có authority
khác sở hữu một direct-child/unreaped group pin thật.

Nếu executor và per-run guardian của cùng run đều bị `SIGKILL` trước khi một
authority hoàn thành cleanup, cả hai shared generation locks đều có thể bị kernel
nhả trong khi sandbox tree còn sống. macOS không có `PDEATHSIG` hoặc
`KILL_ON_JOB_CLOSE`; outer helper không có một kernel handle tương đương Windows
Job Object để tự động sở hữu mọi descendant.

Vì vậy:

- simultaneous forced death của executor + guardian là **Not claimed** trong
  thiết kế này;
- không được mô tả là “mọi double failure đều an toàn”;
- muốn đóng giới hạn này cần một recovery authority thứ ba có registration trước
  `GO`, hoặc một kernel-backed containment primitive đủ mạnh;
- lưu một PID/PGID vào file rồi kill về sau không tự nó đủ an toàn vì PID reuse và
  process-group escape;
- nếu chưa có authority thứ ba, D16 phải ghi rõ fault boundary này.

GUI + outer-helper double failure là trường hợp khác: executor và per-run
guardians vẫn là authorities còn sống, nên trường hợp đó phải vượt packaged gate
và có thể được verified riêng.

## 11. Những nội dung không được suy rộng từ gate

- Managed Python checker đã dùng typed `checker-runtime`; source snapshot trên Apple M1 đã chứng minh private-file/network/child-process block, exact-exec chỉ cho runtime đã chọn và cancel ACK sau terminal drain. Local/system Python vẫn fail-closed cho đến khi có snapshot/certificate; clean-checkout đúng Git SHA được theo dõi riêng, không suy từ folder thử nghiệm đã sync file.
- Compiler certificate không áp dụng cho compiler khác version hoặc local path
  đã drift.
- Một macOS version không đại diện toàn bộ minimum/current supported OS matrix.
- `.app` ad-hoc gate không phải DMG, updater, notarization hoặc autolaunch gate.
- Kernel/Seatbelt bug, malicious root/same-user debugger và power loss nằm ngoài
  threat model.
- “đã gửi SIGKILL” không đồng nghĩa “tree đã drain”; chỉ identity + PGID proof và
  generation handoff ordering mới là evidence hợp lệ.

## 12. Điều kiện chuyển checkpoint sang verified

Chỉ đổi trạng thái tài liệu khi:

1. production Seatbelt profile vượt escape gate;
2. guardian/supervisor protocol vượt unit và native fault-injection gates;
3. concurrent cancellation/shutdown ordering vượt gate;
4. exact packaged ARM64 app vượt GUI/helper/relaunch gate;
5. compiler có certificate riêng;
6. log từ Apple Silicon thật được lưu và đối chiếu với exact commit;
7. các giới hạn double-failure và biên tin cậy của custom checker/runtime vẫn được công bố chính xác.
