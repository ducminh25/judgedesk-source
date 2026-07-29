# macOS per-run guardian — design và verification checkpoint

Ngày chốt thiết kế: 2026-07-29
Trạng thái: **design checkpoint; chưa triển khai, chưa được xem là verified**

## 1. Mục tiêu và phạm vi

Tài liệu này khóa thiết kế cho lớp bảo vệ mỗi lần chạy trên macOS của
JudgeDesk. Mục tiêu là bảo đảm một submission, checker hoặc compiler đang chạy
không trở thành tiến trình mồ côi nếu native executor bị dừng cưỡng bức, đồng
thời không cho app generation kế tiếp bắt đầu trước khi process tree cũ đã được
chứng minh là rỗng.

Phạm vi của checkpoint:

- kiến trúc `executor → guardian → blocked trusted launcher → sandbox-exec`;
- authority và lifetime của generation guard;
- protocol, token, framing và state transition;
- containment khi một trusted component gặp lỗi;
- chống thoát process group trên Seatbelt;
- thứ tự kill, kiểm kê, reap và nhả generation guard;
- gate bắt buộc trước khi gọi thiết kế là verified.

Checkpoint này không triển khai mã, không thay thế gate DMG/updater và không đưa
trusted system/local Python checker vào containment.

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

### 2.2. Characterized nhưng chưa sửa

- Nếu native executor bị `SIGKILL`, shared generation lock do chính executor giữ
  bị kernel nhả, trong khi sandbox process group có thể còn sống.
- Production Seatbelt profile hiện cho phép descendant gọi `setsid()` trong
  primitive thực tế. Vì vậy, containment chỉ dựa vào PGID hiện chưa đủ chặt.
- Explicit Seatbelt deny cho `SYS_setsid` đã được kiểm tra thực tế và làm syscall
  trả `EPERM`.
- Header SDK trên máy Mac ghi rõ `NOTE_TRACK`, `NOTE_TRACKERR` và `NOTE_CHILD`
  không còn được hỗ trợ từ macOS 10.5. Không được dùng các flag này làm nền tảng
  descendant tracking.
- Gate hiện tại tìm active child bằng direct PPID của executor. Cách đó không
  còn đúng sau khi thêm guardian.

### 2.3. Pending

- Per-run guardian và trusted launcher handshake.
- Deny `setpgid`/`setsid`/`posix_spawn` theo run role.
- Guardian-owned reap và proof rằng PGID đã rỗng.
- Executor/guardian fault-injection gate.
- Concurrent-run guardian gate.
- Packaged GUI/helper double-failure gate với guardian đang giữ shared lock.
- Compiler-specific containment certification.

## 3. Threat model

### 3.1. Trusted

- Tauri primary và outer process supervisor helper;
- Node backend;
- native executor;
- per-run guardian;
- trusted launcher stub trước khi `exec`;
- exact compiler binary đã được JudgeDesk chứng nhận.

### 3.2. Untrusted

- submission executable/script;
- mọi descendant do submission tạo;
- input/output và file trong contest;
- source code đưa vào compiler;
- custom checker, trừ exception trusted Python checker được mô tả riêng.

### 3.3. Faults phải chịu được

- executor mất control channel, crash hoặc `SIGKILL`;
- guardian crash hoặc `SIGKILL` trong khi executor còn sống;
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
                └── blocked trusted launcher
                    └── sandbox-exec
                        └── untrusted process group
```

Một guardian chỉ tồn tại cho một run. Không có guardian nhàn rỗi khi app không
chấm. Guardian không nằm trong untrusted process group.

### 4.1. Authority

- Executor giữ shared generation guard trong toàn bộ lifetime của nó.
- Mỗi guardian tự mở, xác thực và giữ một shared generation guard độc lập trước
  khi gửi `READY`.
- Outer supervisor chỉ lấy exclusive generation lock khi backend/executor đang
  drain hoặc generation mới chuẩn bị bắt đầu.
- Guardian chỉ nhả shared guard sau khi launcher đã được reap và PGID inventory
  đã được chứng minh là rỗng.
- Nếu kiểm kê process thất bại hoặc không chắc chắn, guardian tiếp tục giữ lock
  và fail closed; timeout không được biến thành “tree đã rỗng”.

### 4.2. Không có launch-before-ownership

Untrusted code không được chạy ngay sau `fork`/spawn. Trusted launcher phải:

1. thiết lập PID/PGID dự kiến;
2. tự đăng ký identity với executor qua registration pipe riêng;
3. đóng registration FD để FD không lọt qua `exec`;
4. chờ `GO`;
5. chỉ sau `GO` mới `exec` vào `sandbox-exec`.

Guardian là parent của launcher và biết PID ngay khi tạo child. Executor nhận
PID/PGID trực tiếp từ trusted launcher, không chỉ qua guardian. Điều này đóng
khoảng trống khi guardian chết sau khi tạo child nhưng trước khi kịp gửi một
frame thông thường.

Trước `GO`, executor phải ghi một active cancellation record chứa tối thiểu:

- run identity;
- guardian identity;
- launcher PID/PGID và process start identity;
- generation;
- control-channel state.

Nếu executor chết trước `GO`, guardian thấy EOF và reap blocked launcher. Nếu
guardian chết trước `GO`, launcher thấy GO-channel EOF và tự thoát; executor vẫn
có registration identity để kiểm tra và cleanup.

## 5. Protocol và state machine

### 5.1. Framing và authentication

- Protocol có magic/version cố định, ví dụ `JUDGEDESK_RUN_GUARDIAN/1`.
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
  -> LAUNCH(validated bounded spec)
Guardian creates trusted launcher
Launcher
  -> REGISTERED(pid, pgid, start identity) trực tiếp tới executor
Guardian
  -> STARTED(same identity)
Executor commits active cancellation record
  -> GO
Guardian releases launcher
Launcher closes trusted FDs
  -> exec sandbox-exec -> untrusted program
Guardian observes exit, drains group, reaps leader
  -> TERMINAL/CLEANED
Executor emits exactly one RunResult and removes accepted reservation
```

### 5.3. Cancellation và shutdown

- Cancel trước `GO`: launcher không được exec; guardian reap blocked launcher.
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

## 7. Deferred leader reap và proof rằng tree đã rỗng

Guardian là parent trực tiếp của sandbox launcher và là process duy nhất được
phép sở hữu reap của leader.

Trình tự terminal:

1. Quan sát leader exit bằng `EVFILT_PROC/NOTE_EXIT` hoặc wait primitive không
   làm mất ownership proof.
2. Không reap leader quá sớm khi descendant còn sống. Giữ leader PID chưa được
   reap giúp ngăn PID/PGID bị tái sử dụng trong lúc cleanup.
3. Gửi `SIGSTOP` tới process group để chặn fork race.
4. Gửi `SIGKILL` tới group.
5. Kiểm kê `PROC_PGRP_ONLY`; phân biệt exited leader với live descendants.
6. Khi không còn live descendant, `wait4` leader để reap và lấy rusage.
7. Kiểm kê lại cho tới khi PGID bằng 0.
8. Chỉ sau đó gửi `CLEANED` và nhả shared generation guard.

Không dùng các điều kiện sau làm proof duy nhất:

- đã gọi `kill`;
- leader đã exit;
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
| Executor chết sau guardian `READY`, trước launcher | Guardian | Không launch; drain sạch | Pending |
| Executor chết sau launcher registration, trước `GO` | Guardian | Reap blocked launcher, không exec | Pending |
| Executor chết sau `GO` | Guardian | EOF → stop/kill/reap group; giữ SH guard tới PGID=0 | Pending |
| Guardian chết trước launcher | Executor | Run `launch_error`, không có child | Pending |
| Guardian chết sau fork, trước normal `STARTED` | Launcher + executor | Launcher self-register rồi block; executor cleanup | Pending |
| Guardian chết sau `GO` | Executor | Kill/drain bằng registered identity; active run `internal_error` | Pending |
| Launcher chết trước `GO` | Guardian + executor | Reap; đúng một `launch_error` | Pending |
| Backend mất GUI parent channel | Executor + guardians + outer helper | Executor drain; guardians giữ generation barrier | Một phần verified; guardian pending |
| GUI chết | Outer helper + backend/executor/guardians | Backend tree drain trước relaunch | Supervisor path verified; guardian pending |
| Outer helper chết | GUI recovery + backend/executor/guardians | Backend dừng; recovery barrier được giữ | Supervisor path verified; guardian pending |
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
Fixture/trusted launcher phải cung cấp PID, PGID và start identity có thể kiểm
chứng.

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

## 10. Giới hạn double-failure còn lại

Thiết kế hai authority chịu được:

- executor chết khi guardian còn sống;
- guardian chết khi executor còn sống.

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

- Trusted system/local Python checker chưa nằm trong barrier.
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
2. guardian/launcher protocol vượt unit và native fault-injection gates;
3. concurrent cancellation/shutdown ordering vượt gate;
4. exact packaged ARM64 app vượt GUI/helper/relaunch gate;
5. compiler có certificate riêng;
6. log từ Apple Silicon thật được lưu và đối chiếu với exact commit;
7. các giới hạn double-failure và trusted checker vẫn được công bố chính xác.
