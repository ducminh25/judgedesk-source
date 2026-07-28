import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const cargoToml = fs.readFileSync(
  path.join(repositoryRoot, "src-tauri", "Cargo.toml"),
  "utf8",
);
const cargoLock = fs.readFileSync(
  path.join(repositoryRoot, "src-tauri", "Cargo.lock"),
  "utf8",
);
const tauriEntryPoint = fs.readFileSync(
  path.join(repositoryRoot, "src-tauri", "src", "lib.rs"),
  "utf8",
);
const desktopEntryPoint = fs.readFileSync(
  path.join(repositoryRoot, "src-tauri", "src", "main.rs"),
  "utf8",
);
const startupGuard = fs.readFileSync(
  path.join(repositoryRoot, "src-tauri", "src", "startup_guard.rs"),
  "utf8",
);
const processSupervisor = fs.readFileSync(
  path.join(repositoryRoot, "src-tauri", "src", "process_supervisor.rs"),
  "utf8",
);
const backend = fs.readFileSync(
  path.join(repositoryRoot, "src-tauri", "src", "backend.rs"),
  "utf8",
);
const backendBootstrap = fs.readFileSync(
  path.join(repositoryRoot, "server-bootstrap.ts"),
  "utf8",
);
const backendGate = fs.readFileSync(
  path.join(repositoryRoot, "server", "platform", "backend-startup-gate.ts"),
  "utf8",
);
const updaterHook = fs.readFileSync(
  path.join(repositoryRoot, "src", "features", "updates", "useAppUpdater.ts"),
  "utf8",
);
const updaterInstallFlow = fs.readFileSync(
  path.join(repositoryRoot, "src", "features", "updates", "install-flow.ts"),
  "utf8",
);
const appShell = fs.readFileSync(
  path.join(repositoryRoot, "src", "App.tsx"),
  "utf8",
);
const systemRoutes = fs.readFileSync(
  path.join(repositoryRoot, "server", "routes", "system-routes.ts"),
  "utf8",
);
const batchJudgeRoute = fs.readFileSync(
  path.join(repositoryRoot, "server", "judge", "batch-judge-route.ts"),
  "utf8",
);
const judgeJobs = fs.readFileSync(
  path.join(repositoryRoot, "server", "jobs.ts"),
  "utf8",
);
const executorClient = fs.readFileSync(
  path.join(repositoryRoot, "server", "executor", "client.ts"),
  "utf8",
);
const compilerRunner = fs.readFileSync(
  path.join(repositoryRoot, "server", "judge", "compiler.ts"),
  "utf8",
);
const testcaseRunner = fs.readFileSync(
  path.join(repositoryRoot, "server", "judge", "testcase-runner.ts"),
  "utf8",
);
const customCheckerRunner = fs.readFileSync(
  path.join(repositoryRoot, "server", "judge", "custom-checker-runner.ts"),
  "utf8",
);
const judgeSessionHook = fs.readFileSync(
  path.join(repositoryRoot, "src", "features", "judging", "useJudgeSession.ts"),
  "utf8",
);
test("the preflight lock dependencies are pinned exactly", () => {
  assert.match(cargoToml, /dirs\s*=\s*"=6\.0\.0"/);
  assert.match(cargoToml, /fs4\s*=\s*\{[^\n]*version\s*=\s*"=1\.1\.0"/);
  assert.match(
    cargoToml,
    /rfd\s*=\s*\{[^\n]*version\s*=\s*"=0\.16\.0"[^\n]*default-features\s*=\s*false/,
  );
  assert.doesNotMatch(cargoToml, /tauri-plugin-single-instance/);
  assert.match(
    cargoLock,
    /name = "dirs"\r?\nversion = "6\.0\.0"/,
  );
  assert.match(cargoLock, /name = "fs4"\r?\nversion = "1\.1\.0"/);
  assert.match(cargoToml, /getrandom\s*=\s*"=0\.3\.4"/);
  assert.match(cargoLock, /name = "rfd"\r?\nversion = "0\.16\.0"/);
});

test("the authoritative lease is acquired before Tauri and every startup effect", () => {
  const startupLease = tauriEntryPoint.indexOf("startup_guard::acquire(");
  const tauriBuilder = tauriEntryPoint.indexOf("tauri::Builder::default()");
  const managedBackend = tauriEntryPoint.indexOf(
    ".manage(backend::BackendSidecar::default())",
  );
  const checkerCleanup = tauriEntryPoint.indexOf(
    "checker_sources::cleanup_checker_previews()",
  );
  const contestCleanup = tauriEntryPoint.indexOf(
    "contest_archive::cleanup_contest_workspaces()",
  );
  const backendSpawn = tauriEntryPoint.indexOf("backend::spawn(app)");

  assert.ok(startupLease >= 0, "startup lease must be acquired");
  assert.ok(startupLease < tauriBuilder, "lease must precede Tauri Builder");
  assert.ok(startupLease < managedBackend, "lease must precede backend state");
  assert.ok(startupLease < checkerCleanup, "lease must precede checker cleanup");
  assert.ok(startupLease < contestCleanup, "lease must precede contest cleanup");
  assert.ok(startupLease < backendSpawn, "lease must precede backend spawn");
  assert.match(tauriEntryPoint, /SecondaryOutcome::Activated,[\s\S]*?\)\s*=>\s*return/);
  assert.match(tauriEntryPoint, /SecondaryOutcome::ActivationFailed\(error\)/);
  assert.match(tauriEntryPoint, /builder[\s\S]*?\.manage\(instance_coordinator\)/);
  assert.match(
    desktopEntryPoint,
    /try_run_internal_process_supervisor\(\)[\s\S]*?themis_v2_lib::run\(\)/,
  );
  assert.ok(
    tauriEntryPoint.indexOf(".attach(app.handle().clone())") < checkerCleanup,
    "activation must attach before startup cleanup",
  );
});

test("the coordinator is authenticated, bounded, fail-closed, and per-user", () => {
  assert.match(startupGuard, /dirs::data_local_dir\(\)/);
  assert.match(startupGuard, /FileExt::try_lock\(&file\)/);
  assert.match(
    startupGuard,
    /Err\(TryLockError::Error\(error\)\)\s*=>\s*return Err\(error\)/,
  );
  assert.doesNotMatch(startupGuard, /remove_file\([^\n]*instance\.lock/);
  assert.match(startupGuard, /TcpListener::bind\(SocketAddrV4::new\(Ipv4Addr::LOCALHOST, 0\)\)/);
  assert.match(startupGuard, /getrandom::fill\(&mut bytes\)/);
  assert.match(startupGuard, /MAX_ACTIVATION_BYTES/);
  assert.match(startupGuard, /TcpStream::connect_timeout/);
  assert.match(startupGuard, /constant_time_eq/);
  assert.match(startupGuard, /ACTIVATION_STARTING/);
  assert.match(startupGuard, /ACTIVATION_READY/);
  assert.match(startupGuard, /ACTIVATION_DRAINING/);
  assert.match(startupGuard, /ACTIVATION_WORKER_COUNT/);
  assert.match(startupGuard, /MoveFileExW\(/);
  assert.match(startupGuard, /AllowSetForegroundWindow\(owner_pid\)/);
  assert.doesNotMatch(startupGuard, /allow_child_inheritance/);
  assert.doesNotMatch(startupGuard, /ChildInheritanceGuard/);
});

test("macOS never transfers the instance lease through ambient file descriptors", () => {
  assert.doesNotMatch(startupGuard, /FD_CLOEXEC|JUDGEDESK_INSTANCE_LEASE_FD/);
  assert.doesNotMatch(backend, /JUDGEDESK_INSTANCE_LEASE_FD/);
  assert.doesNotMatch(backendGate, /fstatSync|JUDGEDESK_INSTANCE_LEASE_FD/);
});

test("Windows gates the backend behind the supervised backend-only Job", () => {
  assert.doesNotMatch(processSupervisor, /GetCurrentProcess/);
  assert.match(
    processSupervisor,
    /OpenProcess\(PROCESS_SET_QUOTA \| PROCESS_TERMINATE, 0, process_id\)/,
  );
  assert.match(processSupervisor, /AssignProcessToJobObject\(self\.handle\(\), process\)/);
  assert.match(processSupervisor, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/);
  assert.match(processSupervisor, /process-tree\.lock/);
  assert.match(processSupervisor, /ActiveProcesses/);
  assert.match(processSupervisor, /TerminateJobObject/);
  assert.match(processSupervisor, /SetHandleInformation\(handle, HANDLE_FLAG_INHERIT, 0\)/);
  assert.match(processSupervisor, /JUDGEDESK_SUPERVISOR\/1 READY/);
  assert.match(processSupervisor, /JUDGEDESK_SUPERVISOR\/1 DRAINED/);
  const assign = backend.indexOf("coordinator.assign_backend(child.pid())");
  const releaseGate = backend.indexOf("child.write(gate_frame.as_bytes())");
  assert.ok(assign >= 0 && assign < releaseGate, "Job assignment must precede the startup gate");
  assert.match(backend, /JUDGEDESK_BOOTSTRAP_TOKEN/);
  assert.match(backendBootstrap, /await awaitBackendStartupGate\(\)/);
  assert.ok(
    backendBootstrap.indexOf("await awaitBackendStartupGate()") <
      backendBootstrap.indexOf('await import("./server.js")'),
    "server code must stay lazy until the gate opens",
  );
  assert.match(backendGate, /MAX_GATE_BYTES = 128/);
  assert.match(backendGate, /BACKEND_STARTUP_GATE_MISSING/);
});

test("activation and restart handoff are part of the same coordinator", () => {
  assert.match(startupGuard, /window\s*\.show\(\)/);
  assert.match(startupGuard, /window\.unminimize\(\)/);
  assert.match(startupGuard, /SetForegroundWindow\(window_handle\.0\)/);
  assert.match(tauriEntryPoint, /RunEvent::Reopen/);
  const exit = tauriEntryPoint.indexOf("RunEvent::Exit");
  const drainActivation = tauriEntryPoint.indexOf("coordinator.begin_shutdown()", exit);
  const stop = tauriEntryPoint.indexOf("backend::stop(handle)", exit);
  const release = tauriEntryPoint.indexOf(".release()", stop);
  assert.ok(
    exit >= 0 &&
      exit < drainActivation &&
      drainActivation < stop &&
      stop < release,
    "activation and backend must drain before lease release",
  );
  assert.doesNotMatch(tauriEntryPoint, /ExitRequested[\s\S]*?backend::stop/);
});

test("updater prepares and drains the process tree before installation", () => {
  assert.match(tauriEntryPoint, /\.manage\(backend::UpdateHandoff::default\(\)\)/);
  assert.match(tauriEntryPoint, /backend::prepare_for_update/);
  assert.match(backend, /UpdatePreparationState::Preparing/);
  assert.match(backend, /shutdown_backend_tree\(\)/);
  assert.match(backend, /backend shutdown was not acknowledged/);
  const nativePrepare = backend.indexOf("pub async fn prepare_for_update");
  const activationDrain = backend.indexOf(".begin_shutdown()", nativePrepare);
  const backendStop = backend.indexOf("stop(&app)", activationDrain);
  const processTreeDrain = backend.indexOf("shutdown_backend_tree()", backendStop);
  assert.ok(
    nativePrepare >= 0 &&
      nativePrepare < activationDrain &&
      activationDrain < backendStop &&
      backendStop < processTreeDrain,
    "updater must quiesce activation, stop the backend, then drain the process tree",
  );
  assert.doesNotMatch(
    backend.slice(nativePrepare),
    /\.release\(\)/,
  );
  assert.match(updaterHook, /invoke\("prepare_for_update"\)/);
  assert.match(appShell, /inert=\{updateHandoffActive \? true : undefined\}/);
  assert.match(
    appShell,
    /isJudging \|\| isSavingContest \|\| updateHandoffActive/,
  );
  const serverPrepare = systemRoutes.indexOf(
    "export async function prepareServerShutdown",
  );
  const beginDrain = systemRoutes.indexOf("dependencies.beginDrain()", serverPrepare);
  const cancelJobs = systemRoutes.indexOf(
    "dependencies.cancelActiveJudgeJobs()",
    beginDrain,
  );
  const waitForJobs = systemRoutes.indexOf(
    "dependencies.waitForJudgeSessionsToFinish(",
    cancelJobs,
  );
  const executorShutdown = systemRoutes.indexOf(
    "dependencies.shutdownExecutor()",
    waitForJobs,
  );
  assert.ok(
    serverPrepare >= 0 &&
      serverPrepare < beginDrain &&
      beginDrain < cancelJobs &&
      cancelJobs < waitForJobs &&
      waitForJobs < executorShutdown,
    "backend must close admission, cancel and await jobs before shutting down its executor",
  );
  assert.match(batchJudgeRoute, /tryRegisterJudgeJob\(jobId\)/);
  assert.match(judgeJobs, /DEFAULT_PENDING_CANCEL_TTL_MS = 60_000/);
  assert.match(judgeJobs, /DEFAULT_MAX_PENDING_CANCELS = 1_024/);
  assert.match(judgeJobs, /\[\.\.\.job\.startedRunIds\]\.map/);
  assert.match(
    judgeJobs,
    /result\.status === "rejected" \|\| !result\.value/,
  );
  assert.match(
    judgeJobs,
    /\.finally\(\(\) => \{\s*judgeJobRegistry\.completeExecutorRun\(jobId, spec\.runId\)/,
  );
  const submitHook = executorClient.indexOf("beforeSubmit?.()");
  const executorRequest = executorClient.indexOf(
    'this.request({ type: "run"',
    submitHook,
  );
  assert.ok(
    submitHook >= 0 && submitHook < executorRequest,
    "a run must cross its cancellation barrier immediately before executor submission",
  );
  assert.match(
    judgeJobs,
    /executorClient\.run\(\s*spec,\s*\(\) => judgeJobRegistry\.startExecutorRun\(jobId, spec\.runId\)/,
  );
  for (const source of [compilerRunner, testcaseRunner, customCheckerRunner]) {
    assert.match(
      source,
      /runReservedExecutor\(/,
      "every production native judge run must use the cancellation start barrier",
    );
    assert.doesNotMatch(source, /executorClient\.run\(/);
  }
  assert.match(judgeSessionHook, /globalThis\.crypto\.randomUUID\(\)/);
  const prepare = updaterInstallFlow.indexOf('runStep("prepare"');
  const install = updaterInstallFlow.indexOf('runStep("install"');
  const relaunch = updaterInstallFlow.indexOf('runStep("relaunch"');
  assert.ok(
    prepare >= 0 && prepare < install && install < relaunch,
    "updater must prepare, install, then relaunch",
  );
});

test("unexpected ownership failures stop startup instead of falling back", () => {
  assert.match(tauriEntryPoint, /JudgeDesk could not establish exclusive startup ownership/);
  assert.match(tauriEntryPoint, /std::process::exit\(70\)/);
});
