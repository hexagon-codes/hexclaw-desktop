use std::error::Error;
use std::fmt;
use std::process::{Child, ExitStatus};
use std::sync::{Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ProcessFailure(String);

impl ProcessFailure {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for ProcessFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for ProcessFailure {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ProcessExit {
    code: Option<i32>,
    description: String,
}

impl ProcessExit {
    #[cfg(test)]
    pub(crate) fn code(&self) -> Option<i32> {
        self.code
    }

    #[cfg(test)]
    pub(crate) fn for_test(code: i32) -> Self {
        Self {
            code: Some(code),
            description: format!("exit code: {code}"),
        }
    }
}

impl From<ExitStatus> for ProcessExit {
    fn from(status: ExitStatus) -> Self {
        Self {
            code: status.code(),
            description: status.to_string(),
        }
    }
}

impl fmt::Display for ProcessExit {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.description)
    }
}

pub(crate) trait ProcessControl: Send {
    fn pid(&self) -> u32;
    fn try_wait(&mut self) -> Result<Option<ProcessExit>, ProcessFailure>;
    fn terminate(&mut self) -> Result<(), ProcessFailure>;
    fn kill(&mut self) -> Result<(), ProcessFailure>;
    fn wait_for_exit(&mut self, timeout: Duration) -> Result<Option<ProcessExit>, ProcessFailure>;
}

/// 对系统子进程提供平台无关的生命周期控制接口。
pub(crate) struct SystemProcess {
    child: Child,
}

impl From<Child> for SystemProcess {
    fn from(child: Child) -> Self {
        Self { child }
    }
}

impl ProcessControl for SystemProcess {
    fn pid(&self) -> u32 {
        self.child.id()
    }

    fn try_wait(&mut self) -> Result<Option<ProcessExit>, ProcessFailure> {
        self.child
            .try_wait()
            .map(|status| status.map(ProcessExit::from))
            .map_err(|error| {
                ProcessFailure::new(format!(
                    "Failed to inspect Sidecar PID {}: {error}",
                    self.child.id()
                ))
            })
    }

    fn terminate(&mut self) -> Result<(), ProcessFailure> {
        #[cfg(unix)]
        {
            let pid = self.child.id();
            // 安全性：kill 仅接收当前受管子进程 PID 与固定 SIGTERM 信号。
            let result = unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
            if result == 0 {
                Ok(())
            } else {
                Err(ProcessFailure::new(format!(
                    "Failed to send SIGTERM to Sidecar PID {pid}: {}",
                    std::io::Error::last_os_error()
                )))
            }
        }
        #[cfg(not(unix))]
        {
            Err(ProcessFailure::new(format!(
                "Graceful termination is unavailable for Sidecar PID {} on this platform",
                self.child.id()
            )))
        }
    }

    fn kill(&mut self) -> Result<(), ProcessFailure> {
        let pid = self.child.id();
        self.child.kill().map_err(|error| {
            ProcessFailure::new(format!("Failed to kill Sidecar PID {pid}: {error}"))
        })
    }

    fn wait_for_exit(&mut self, timeout: Duration) -> Result<Option<ProcessExit>, ProcessFailure> {
        const POLL_INTERVAL: Duration = Duration::from_millis(20);
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(exit) = self.try_wait()? {
                return Ok(Some(exit));
            }
            let now = Instant::now();
            if now >= deadline {
                return Ok(None);
            }
            thread::sleep(std::cmp::min(POLL_INTERVAL, deadline - now));
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct SidecarInstance(pub(crate) u64);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SidecarEvent {
    Ready { instance: SidecarInstance },
    Timeout { instance: SidecarInstance },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CleanupMode {
    Graceful,
    #[cfg_attr(unix, allow(dead_code))]
    ForceKill,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum StartupOutcome {
    Running,
    Ready,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum StopOutcome {
    Idle,
    Stopped { graceful: bool },
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct CleanupFailure {
    causes: Vec<ProcessFailure>,
}

impl CleanupFailure {
    fn push(&mut self, stage: &str, error: ProcessFailure) {
        self.causes
            .push(ProcessFailure::new(format!("{stage}: {error}")));
    }

    fn extend_for_pid(&mut self, pid: u32, failure: Self) {
        self.causes.extend(
            failure
                .causes
                .into_iter()
                .map(|cause| ProcessFailure::new(format!("Sidecar PID {pid}: {cause}"))),
        );
    }

    fn into_option(self) -> Option<Self> {
        (!self.causes.is_empty()).then_some(self)
    }
}

impl fmt::Display for CleanupFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (index, cause) in self.causes.iter().enumerate() {
            if index > 0 {
                formatter.write_str("; ")?;
            }
            write!(formatter, "{cause}")?;
        }
        Ok(())
    }
}

impl Error for CleanupFailure {}

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum SupervisorError {
    AlreadyActive {
        instance: SidecarInstance,
    },
    GenerationOverflow,
    Superseded {
        instance: SidecarInstance,
        current: SidecarInstance,
        cleanup: Option<CleanupFailure>,
        cleanup_pending: Option<u32>,
    },
    Timeout {
        instance: SidecarInstance,
        timeout: Duration,
    },
    Exited {
        instance: SidecarInstance,
        exit: ProcessExit,
    },
    Observe {
        instance: SidecarInstance,
        primary: ProcessFailure,
        cleanup: Option<CleanupFailure>,
        cleanup_pending: Option<u32>,
    },
    NotAttached {
        instance: SidecarInstance,
    },
    StartFailed {
        instance: SidecarInstance,
        reason: String,
    },
    Cleanup {
        pid: u32,
        cleanup: CleanupFailure,
    },
    CleanupPending {
        instance: SidecarInstance,
        pid: u32,
        cleanup: Option<CleanupFailure>,
    },
}

impl fmt::Display for SupervisorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AlreadyActive { instance } => write!(
                formatter,
                "Sidecar generation {} is already starting or running",
                instance.0
            ),
            Self::GenerationOverflow => {
                formatter.write_str("Sidecar generation counter overflowed")
            }
            Self::Superseded {
                instance,
                current,
                cleanup,
                cleanup_pending,
            } => {
                write!(
                    formatter,
                    "Sidecar startup generation {} was superseded by generation {} or stopped",
                    instance.0, current.0
                )?;
                if let Some(cleanup) = cleanup {
                    write!(formatter, "; spawned process cleanup failed: {cleanup}")?;
                }
                if let Some(pid) = cleanup_pending {
                    write!(formatter, "; Sidecar PID {pid} still requires cleanup")?;
                }
                Ok(())
            }
            Self::Timeout { timeout, .. } => {
                write!(formatter, "Sidecar startup timed out after {timeout:?}")
            }
            Self::Exited { exit, .. } => {
                write!(formatter, "Sidecar exited before becoming healthy: {exit}")
            }
            Self::Observe {
                primary,
                cleanup,
                cleanup_pending,
                ..
            } => {
                write!(
                    formatter,
                    "Failed to observe Sidecar startup process: {primary}"
                )?;
                if let Some(cleanup) = cleanup {
                    write!(formatter, "; cleanup also failed: {cleanup}")?;
                }
                if let Some(pid) = cleanup_pending {
                    write!(formatter, "; Sidecar PID {pid} still requires cleanup")?;
                }
                Ok(())
            }
            Self::NotAttached { instance } => write!(
                formatter,
                "Sidecar generation {} has not attached a process",
                instance.0
            ),
            Self::StartFailed { instance, reason } => {
                write!(
                    formatter,
                    "Failed to start Sidecar generation {}: {reason}",
                    instance.0
                )
            }
            Self::Cleanup { pid, cleanup } => {
                write!(formatter, "Failed to clean up Sidecar PID {pid}: {cleanup}")
            }
            Self::CleanupPending {
                instance,
                pid,
                cleanup,
            } => {
                write!(
                    formatter,
                    "Sidecar generation {} PID {pid} still requires cleanup",
                    instance.0
                )?;
                if let Some(cleanup) = cleanup {
                    write!(formatter, ": {cleanup}")?;
                }
                Ok(())
            }
        }
    }
}

impl Error for SupervisorError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Observe { primary, .. } => Some(primary),
            Self::Cleanup { cleanup, .. } => Some(cleanup),
            Self::CleanupPending {
                cleanup: Some(cleanup),
                ..
            }
            | Self::Superseded {
                cleanup: Some(cleanup),
                ..
            } => Some(cleanup),
            _ => None,
        }
    }
}

pub(crate) struct CleanupReport {
    pub(crate) reaped: bool,
    pub(crate) graceful: bool,
    pub(crate) error: Option<CleanupFailure>,
}

pub(crate) fn cleanup_process<P: ProcessControl>(
    process: &mut P,
    mode: CleanupMode,
    timeout: Duration,
) -> CleanupReport {
    let mut failure = CleanupFailure::default();

    match process.try_wait() {
        Ok(Some(_)) => {
            return CleanupReport {
                reaped: true,
                graceful: true,
                error: None,
            };
        }
        Ok(None) => {}
        Err(error) => failure.push("initial observation failed", error),
    }

    if mode == CleanupMode::Graceful {
        if let Err(error) = process.terminate() {
            failure.push("graceful termination failed", error);
        }
        match process.wait_for_exit(timeout) {
            Ok(Some(_)) => {
                return CleanupReport {
                    reaped: true,
                    graceful: true,
                    error: failure.into_option(),
                };
            }
            Ok(None) => {}
            Err(error) => failure.push("graceful wait failed", error),
        }
    }

    if let Err(error) = process.kill() {
        failure.push("force termination failed", error);
    }
    let reaped = match process.wait_for_exit(timeout) {
        Ok(Some(_)) => true,
        Ok(None) => false,
        Err(error) => {
            failure.push("reap wait failed", error);
            false
        }
    };
    if !reaped && failure.causes.is_empty() {
        failure.push(
            "reap wait failed",
            ProcessFailure::new(format!(
                "Sidecar PID {} did not exit within {timeout:?}",
                process.pid()
            )),
        );
    }

    CleanupReport {
        reaped,
        graceful: false,
        error: failure.into_option(),
    }
}

struct OwnedProcess<P> {
    instance: SidecarInstance,
    process: P,
}

enum ActiveProcess<P> {
    Stopped,
    Starting {
        instance: SidecarInstance,
    },
    Running {
        instance: SidecarInstance,
        process: P,
        ready: bool,
    },
}

struct SupervisorState<P> {
    generation: u64,
    active: ActiveProcess<P>,
    retained: Vec<OwnedProcess<P>>,
}

struct LifecycleGateState {
    owner: Option<thread::ThreadId>,
    depth: usize,
}

/// 串行化生命周期写操作，并允许事件回调在同一线程同步重入。
struct LifecycleGate {
    state: Mutex<LifecycleGateState>,
    available: Condvar,
}

impl LifecycleGate {
    const fn new() -> Self {
        Self {
            state: Mutex::new(LifecycleGateState {
                owner: None,
                depth: 0,
            }),
            available: Condvar::new(),
        }
    }

    fn enter(&self) -> LifecycleGuard<'_> {
        let current = thread::current().id();
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        loop {
            match state.owner.as_ref() {
                None => {
                    state.owner = Some(current);
                    state.depth = 1;
                    return LifecycleGuard { gate: self };
                }
                Some(owner) if *owner == current => {
                    state.depth = state
                        .depth
                        .checked_add(1)
                        .expect("Sidecar lifecycle reentrancy depth overflowed");
                    return LifecycleGuard { gate: self };
                }
                Some(_) => {
                    state = self
                        .available
                        .wait(state)
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                }
            }
        }
    }
}

struct LifecycleGuard<'a> {
    gate: &'a LifecycleGate,
}

impl Drop for LifecycleGuard<'_> {
    fn drop(&mut self) {
        let current = thread::current().id();
        let mut state = self
            .gate
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        debug_assert_eq!(state.owner.as_ref(), Some(&current));
        if state.owner.as_ref() != Some(&current) {
            return;
        }
        state.depth -= 1;
        if state.depth == 0 {
            state.owner = None;
            self.gate.available.notify_one();
        }
    }
}

pub(crate) struct SidecarSupervisor<P> {
    lifecycle: LifecycleGate,
    state: Mutex<SupervisorState<P>>,
}

impl<P: ProcessControl> SidecarSupervisor<P> {
    pub(crate) const fn new() -> Self {
        Self {
            lifecycle: LifecycleGate::new(),
            state: Mutex::new(SupervisorState {
                generation: 0,
                active: ActiveProcess::Stopped,
                retained: Vec::new(),
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, SupervisorState<P>> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn superseded(
        state: &SupervisorState<P>,
        instance: SidecarInstance,
        cleanup: Option<CleanupFailure>,
        cleanup_pending: Option<u32>,
    ) -> SupervisorError {
        SupervisorError::Superseded {
            instance,
            current: SidecarInstance(state.generation),
            cleanup,
            cleanup_pending,
        }
    }

    fn inspect_serialized(
        &self,
        instance: SidecarInstance,
        cleanup_mode: CleanupMode,
        cleanup_timeout: Duration,
    ) -> Result<StartupOutcome, SupervisorError> {
        let (mut process, primary) = {
            let mut state = self.lock();
            if state.generation != instance.0 {
                return Err(Self::superseded(&state, instance, None, None));
            }

            let active = std::mem::replace(&mut state.active, ActiveProcess::Stopped);
            let ActiveProcess::Running {
                instance: owner,
                mut process,
                ready,
            } = active
            else {
                state.active = active;
                return match &state.active {
                    ActiveProcess::Starting { instance: owner } if *owner == instance => {
                        Err(SupervisorError::NotAttached { instance })
                    }
                    _ => Err(Self::superseded(&state, instance, None, None)),
                };
            };

            if owner != instance {
                state.active = ActiveProcess::Running {
                    instance: owner,
                    process,
                    ready,
                };
                return Err(Self::superseded(&state, instance, None, None));
            }

            match process.try_wait() {
                Ok(Some(exit)) => return Err(SupervisorError::Exited { instance, exit }),
                Ok(None) => {
                    state.active = ActiveProcess::Running {
                        instance,
                        process,
                        ready,
                    };
                    return Ok(if ready {
                        StartupOutcome::Ready
                    } else {
                        StartupOutcome::Running
                    });
                }
                Err(primary) => (process, primary),
            }
        };

        let pid = process.pid();
        let report = cleanup_process(&mut process, cleanup_mode, cleanup_timeout);
        let cleanup_pending = (!report.reaped).then_some(pid);
        if !report.reaped {
            self.lock()
                .retained
                .push(OwnedProcess { instance, process });
        }
        Err(SupervisorError::Observe {
            instance,
            primary,
            cleanup: report.error,
            cleanup_pending,
        })
    }

    pub(crate) fn begin_start(&self) -> Result<SidecarInstance, SupervisorError> {
        let _lifecycle = self.lifecycle.enter();
        let mut state = self.lock();
        if let Some(pending) = state.retained.first() {
            return Err(SupervisorError::CleanupPending {
                instance: pending.instance,
                pid: pending.process.pid(),
                cleanup: None,
            });
        }
        match &state.active {
            ActiveProcess::Stopped => {}
            ActiveProcess::Starting { instance } | ActiveProcess::Running { instance, .. } => {
                return Err(SupervisorError::AlreadyActive {
                    instance: *instance,
                });
            }
        }
        state.generation = state
            .generation
            .checked_add(1)
            .ok_or(SupervisorError::GenerationOverflow)?;
        let instance = SidecarInstance(state.generation);
        state.active = ActiveProcess::Starting { instance };
        Ok(instance)
    }

    pub(crate) fn cancel_start(&self, instance: SidecarInstance) -> Result<(), SupervisorError> {
        let _lifecycle = self.lifecycle.enter();
        let mut state = self.lock();
        if state.generation == instance.0
            && matches!(
                state.active,
                ActiveProcess::Starting { instance: owner } if owner == instance
            )
        {
            state.active = ActiveProcess::Stopped;
            return Ok(());
        }
        Err(Self::superseded(&state, instance, None, None))
    }

    pub(crate) fn attach_process(
        &self,
        instance: SidecarInstance,
        mut process: P,
        mode: CleanupMode,
        timeout: Duration,
    ) -> Result<(), SupervisorError> {
        let _lifecycle = self.lifecycle.enter();
        let is_current_start = {
            let mut state = self.lock();
            let is_current_start = state.generation == instance.0
                && matches!(
                    state.active,
                    ActiveProcess::Starting { instance: owner } if owner == instance
                );
            if is_current_start && state.retained.is_empty() {
                state.active = ActiveProcess::Running {
                    instance,
                    process,
                    ready: false,
                };
                return Ok(());
            }
            if is_current_start {
                state.active = ActiveProcess::Stopped;
            }
            is_current_start
        };

        let pid = process.pid();
        let report = cleanup_process(&mut process, mode, timeout);
        let cleanup_pending = (!report.reaped).then_some(pid);
        let mut state = self.lock();
        if !report.reaped {
            state.retained.push(OwnedProcess { instance, process });
        }

        if is_current_start {
            let (pending_instance, pending_pid) = state
                .retained
                .first()
                .map(|pending| (pending.instance, pending.process.pid()))
                .unwrap_or((instance, pid));
            return Err(SupervisorError::CleanupPending {
                instance: pending_instance,
                pid: pending_pid,
                cleanup: report.error,
            });
        }

        Err(Self::superseded(
            &state,
            instance,
            report.error,
            cleanup_pending,
        ))
    }

    pub(crate) fn stop(
        &self,
        mode: CleanupMode,
        timeout: Duration,
    ) -> Result<StopOutcome, SupervisorError> {
        let _lifecycle = self.lifecycle.enter();
        let owned = {
            let mut state = self.lock();
            state.generation = state
                .generation
                .checked_add(1)
                .ok_or(SupervisorError::GenerationOverflow)?;

            let active = std::mem::replace(&mut state.active, ActiveProcess::Stopped);
            let mut owned = std::mem::take(&mut state.retained);
            if let ActiveProcess::Running {
                instance, process, ..
            } = active
            {
                owned.insert(0, OwnedProcess { instance, process });
            }
            owned
        };
        if owned.is_empty() {
            return Ok(StopOutcome::Idle);
        }

        let mut pending = Vec::new();
        let mut combined = CleanupFailure::default();
        let mut first_error_pid = None;
        let mut all_graceful = true;
        for mut owned_process in owned {
            let pid = owned_process.process.pid();
            let report = cleanup_process(&mut owned_process.process, mode, timeout);
            all_graceful &= report.graceful;
            if let Some(failure) = report.error {
                first_error_pid.get_or_insert(pid);
                combined.extend_for_pid(pid, failure);
            }
            if !report.reaped {
                pending.push(owned_process);
            }
        }
        let mut state = self.lock();
        state.retained = pending;

        if let Some(pending) = state.retained.first() {
            return Err(SupervisorError::CleanupPending {
                instance: pending.instance,
                pid: pending.process.pid(),
                cleanup: combined.into_option(),
            });
        }
        if let Some(pid) = first_error_pid {
            return Err(SupervisorError::Cleanup {
                pid,
                cleanup: combined,
            });
        }
        Ok(StopOutcome::Stopped {
            graceful: all_graceful,
        })
    }

    pub(crate) fn observe(
        &self,
        instance: SidecarInstance,
        mode: CleanupMode,
        timeout: Duration,
    ) -> Result<StartupOutcome, SupervisorError> {
        let _lifecycle = self.lifecycle.enter();
        self.inspect_serialized(instance, mode, timeout)
    }

    pub(crate) fn commit_ready(
        &self,
        instance: SidecarInstance,
        cleanup_mode: CleanupMode,
        cleanup_timeout: Duration,
        mut emit: impl FnMut(SidecarEvent),
    ) -> Result<StartupOutcome, SupervisorError> {
        let _lifecycle = self.lifecycle.enter();
        match self.inspect_serialized(instance, cleanup_mode, cleanup_timeout)? {
            StartupOutcome::Ready => Ok(StartupOutcome::Ready),
            StartupOutcome::Running => {
                {
                    let mut state = self.lock();
                    if state.generation != instance.0 {
                        return Err(Self::superseded(&state, instance, None, None));
                    }
                    let ActiveProcess::Running {
                        instance: owner,
                        ready,
                        ..
                    } = &mut state.active
                    else {
                        return Err(Self::superseded(&state, instance, None, None));
                    };
                    if *owner != instance {
                        return Err(Self::superseded(&state, instance, None, None));
                    }
                    *ready = true;
                }
                emit(SidecarEvent::Ready { instance });
                let state = self.lock();
                if state.generation == instance.0
                    && matches!(
                        state.active,
                        ActiveProcess::Running {
                            instance: owner,
                            ready: true,
                            ..
                        } if owner == instance
                    )
                {
                    Ok(StartupOutcome::Ready)
                } else {
                    Err(Self::superseded(&state, instance, None, None))
                }
            }
        }
    }

    pub(crate) fn commit_timeout(
        &self,
        instance: SidecarInstance,
        timeout: Duration,
        cleanup_mode: CleanupMode,
        cleanup_timeout: Duration,
        mut emit: impl FnMut(SidecarEvent),
    ) -> Result<StartupOutcome, SupervisorError> {
        let _lifecycle = self.lifecycle.enter();
        match self.inspect_serialized(instance, cleanup_mode, cleanup_timeout)? {
            StartupOutcome::Ready => Ok(StartupOutcome::Ready),
            StartupOutcome::Running => {
                emit(SidecarEvent::Timeout { instance });
                let state = self.lock();
                if state.generation == instance.0
                    && matches!(
                        state.active,
                        ActiveProcess::Running { instance: owner, .. } if owner == instance
                    )
                {
                    Err(SupervisorError::Timeout { instance, timeout })
                } else {
                    Err(Self::superseded(&state, instance, None, None))
                }
            }
        }
    }

    pub(crate) fn is_ready(&self) -> bool {
        matches!(
            self.lock().active,
            ActiveProcess::Running { ready: true, .. }
        )
    }

    #[cfg(test)]
    pub(crate) fn is_managed(&self, instance: SidecarInstance) -> bool {
        let state = self.lock();
        state.generation == instance.0
            && matches!(
                state.active,
                ActiveProcess::Running { instance: owner, .. } if owner == instance
            )
    }

    pub(crate) fn start_failed(
        instance: SidecarInstance,
        reason: impl Into<String>,
    ) -> SupervisorError {
        SupervisorError::StartFailed {
            instance,
            reason: reason.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        cleanup_process, CleanupMode, ProcessControl, ProcessExit, ProcessFailure, SidecarEvent,
        SidecarSupervisor, StartupOutcome, SupervisorError,
    };
    use std::collections::VecDeque;
    use std::sync::{mpsc, Arc, Mutex};
    use std::thread;
    use std::time::Duration;

    #[derive(Default)]
    struct FakeTrace {
        try_wait_calls: usize,
        terminate_calls: usize,
        kill_calls: usize,
        wait_calls: usize,
    }

    struct FakeProcess {
        trace: Arc<Mutex<FakeTrace>>,
        try_wait_results: VecDeque<Result<Option<ProcessExit>, ProcessFailure>>,
        terminate_result: Result<(), ProcessFailure>,
        kill_result: Result<(), ProcessFailure>,
        wait_results: VecDeque<Result<Option<ProcessExit>, ProcessFailure>>,
    }

    impl FakeProcess {
        fn running() -> (Self, Arc<Mutex<FakeTrace>>) {
            let trace = Arc::new(Mutex::new(FakeTrace::default()));
            (
                Self {
                    trace: Arc::clone(&trace),
                    try_wait_results: VecDeque::new(),
                    terminate_result: Ok(()),
                    kill_result: Ok(()),
                    wait_results: VecDeque::from([Ok(Some(ProcessExit::for_test(0)))]),
                },
                trace,
            )
        }

        fn with_failures() -> (Self, Arc<Mutex<FakeTrace>>) {
            let trace = Arc::new(Mutex::new(FakeTrace::default()));
            (
                Self {
                    trace: Arc::clone(&trace),
                    try_wait_results: VecDeque::from([
                        Err(ProcessFailure::new("observe failed")),
                        Err(ProcessFailure::new("cleanup inspect failed")),
                    ]),
                    terminate_result: Err(ProcessFailure::new("terminate failed")),
                    kill_result: Err(ProcessFailure::new("kill failed")),
                    wait_results: VecDeque::from([
                        Err(ProcessFailure::new("graceful wait failed")),
                        Err(ProcessFailure::new("reap wait failed")),
                    ]),
                },
                trace,
            )
        }
    }

    impl ProcessControl for FakeProcess {
        fn pid(&self) -> u32 {
            42
        }

        fn try_wait(&mut self) -> Result<Option<ProcessExit>, ProcessFailure> {
            self.trace.lock().expect("trace lock").try_wait_calls += 1;
            self.try_wait_results.pop_front().unwrap_or(Ok(None))
        }

        fn terminate(&mut self) -> Result<(), ProcessFailure> {
            self.trace.lock().expect("trace lock").terminate_calls += 1;
            self.terminate_result.clone()
        }

        fn kill(&mut self) -> Result<(), ProcessFailure> {
            self.trace.lock().expect("trace lock").kill_calls += 1;
            self.kill_result.clone()
        }

        fn wait_for_exit(
            &mut self,
            _timeout: Duration,
        ) -> Result<Option<ProcessExit>, ProcessFailure> {
            self.trace.lock().expect("trace lock").wait_calls += 1;
            self.wait_results.pop_front().unwrap_or(Ok(None))
        }
    }

    struct BlockingCleanupProcess {
        cleanup_started: mpsc::SyncSender<()>,
        cleanup_release: mpsc::Receiver<()>,
    }

    impl ProcessControl for BlockingCleanupProcess {
        fn pid(&self) -> u32 {
            43
        }

        fn try_wait(&mut self) -> Result<Option<ProcessExit>, ProcessFailure> {
            Ok(None)
        }

        fn terminate(&mut self) -> Result<(), ProcessFailure> {
            Ok(())
        }

        fn kill(&mut self) -> Result<(), ProcessFailure> {
            Ok(())
        }

        fn wait_for_exit(
            &mut self,
            _timeout: Duration,
        ) -> Result<Option<ProcessExit>, ProcessFailure> {
            self.cleanup_started.send(()).map_err(|error| {
                ProcessFailure::new(format!("Failed to signal cleanup: {error}"))
            })?;
            self.cleanup_release
                .recv_timeout(Duration::from_secs(2))
                .map_err(|error| {
                    ProcessFailure::new(format!("Failed to release cleanup: {error}"))
                })?;
            Ok(Some(ProcessExit::for_test(0)))
        }
    }

    fn recorded_events() -> (Arc<Mutex<Vec<SidecarEvent>>>, impl FnMut(SidecarEvent)) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&events);
        (events, move |event| {
            captured.lock().expect("events lock").push(event);
        })
    }

    #[test]
    fn ready_event_callback_runs_without_holding_the_state_lock() {
        let supervisor = SidecarSupervisor::new();
        let instance = supervisor.begin_start().expect("begin startup");
        let (process, _) = FakeProcess::running();
        supervisor
            .attach_process(instance, process, CleanupMode::ForceKill, Duration::ZERO)
            .expect("attach process");
        let mut callback_could_acquire_state_lock = false;

        supervisor
            .commit_ready(instance, CleanupMode::ForceKill, Duration::ZERO, |_| {
                callback_could_acquire_state_lock = supervisor.state.try_lock().is_ok();
            })
            .expect("commit ready");

        assert!(
            callback_could_acquire_state_lock,
            "event callbacks must run without holding the supervisor state lock"
        );
    }

    #[test]
    fn cleanup_wait_runs_without_holding_the_state_lock() {
        let supervisor = Arc::new(SidecarSupervisor::new());
        let instance = supervisor.begin_start().expect("begin startup");
        let (cleanup_started_tx, cleanup_started_rx) = mpsc::sync_channel(1);
        let (cleanup_release_tx, cleanup_release_rx) = mpsc::sync_channel(1);
        supervisor
            .attach_process(
                instance,
                BlockingCleanupProcess {
                    cleanup_started: cleanup_started_tx,
                    cleanup_release: cleanup_release_rx,
                },
                CleanupMode::ForceKill,
                Duration::ZERO,
            )
            .expect("attach process");

        let stopping_supervisor = Arc::clone(&supervisor);
        let stop_thread =
            thread::spawn(move || stopping_supervisor.stop(CleanupMode::ForceKill, Duration::ZERO));
        cleanup_started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("cleanup must start");
        let state_lock_available = supervisor.state.try_lock().is_ok();
        cleanup_release_tx.send(()).expect("release cleanup");
        stop_thread
            .join()
            .expect("stop thread must not panic")
            .expect("stop process");

        assert!(
            state_lock_available,
            "bounded process cleanup must run without holding the supervisor state lock"
        );
    }

    #[test]
    fn ready_event_callback_can_stop_reentrantly_and_supersedes_the_commit() {
        let supervisor = SidecarSupervisor::new();
        let instance = supervisor.begin_start().expect("begin startup");
        let (process, trace) = FakeProcess::running();
        supervisor
            .attach_process(instance, process, CleanupMode::ForceKill, Duration::ZERO)
            .expect("attach process");
        let mut stop_result = None;

        let result =
            supervisor.commit_ready(instance, CleanupMode::ForceKill, Duration::ZERO, |_| {
                stop_result = Some(supervisor.stop(CleanupMode::ForceKill, Duration::ZERO));
            });

        assert!(matches!(stop_result, Some(Ok(_))));
        assert!(matches!(
            result,
            Err(SupervisorError::Superseded {
                instance: superseded,
                ..
            }) if superseded == instance
        ));
        let trace = trace.lock().expect("trace lock");
        assert_eq!(trace.kill_calls, 1);
        assert_eq!(trace.wait_calls, 1);
    }

    #[test]
    fn concurrent_stop_cannot_overtake_ready_event_delivery() {
        let supervisor = Arc::new(SidecarSupervisor::new());
        let instance = supervisor.begin_start().expect("begin startup");
        let (process, _) = FakeProcess::running();
        supervisor
            .attach_process(instance, process, CleanupMode::ForceKill, Duration::ZERO)
            .expect("attach process");
        let (event_started_tx, event_started_rx) = mpsc::sync_channel(1);
        let (event_release_tx, event_release_rx) = mpsc::sync_channel(1);

        let committing_supervisor = Arc::clone(&supervisor);
        let commit_thread = thread::spawn(move || {
            committing_supervisor.commit_ready(
                instance,
                CleanupMode::ForceKill,
                Duration::ZERO,
                |_| {
                    event_started_tx.send(()).expect("signal event delivery");
                    event_release_rx
                        .recv_timeout(Duration::from_secs(2))
                        .expect("release event delivery");
                },
            )
        });
        event_started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("event delivery must start");

        let (stop_started_tx, stop_started_rx) = mpsc::sync_channel(1);
        let (stop_finished_tx, stop_finished_rx) = mpsc::sync_channel(1);
        let stopping_supervisor = Arc::clone(&supervisor);
        let stop_thread = thread::spawn(move || {
            stop_started_tx.send(()).expect("signal stop attempt");
            let result = stopping_supervisor.stop(CleanupMode::ForceKill, Duration::ZERO);
            stop_finished_tx.send(()).expect("signal stop completion");
            result
        });
        stop_started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("stop must be attempted");
        let stop_overtook_event = stop_finished_rx
            .recv_timeout(Duration::from_millis(200))
            .is_ok();
        event_release_tx.send(()).expect("release event delivery");

        let commit_result = commit_thread.join().expect("commit thread must not panic");
        let stop_result = stop_thread.join().expect("stop thread must not panic");
        assert!(
            !stop_overtook_event,
            "stop must not complete inside the validated event-delivery boundary"
        );
        assert_eq!(commit_result, Ok(StartupOutcome::Ready));
        assert!(stop_result.is_ok());
    }

    #[test]
    fn stop_supersedes_startup_without_emitting_old_ready_or_timeout() {
        let supervisor = SidecarSupervisor::new();
        let instance = supervisor.begin_start().expect("begin startup");
        let (process, _) = FakeProcess::running();
        supervisor
            .attach_process(instance, process, CleanupMode::ForceKill, Duration::ZERO)
            .expect("attach process");
        supervisor
            .stop(CleanupMode::ForceKill, Duration::ZERO)
            .expect("stop process");
        let (events, mut record) = recorded_events();

        assert!(matches!(
            supervisor.commit_ready(
                instance,
                CleanupMode::ForceKill,
                Duration::ZERO,
                &mut record,
            ),
            Err(SupervisorError::Superseded { .. })
        ));
        assert!(matches!(
            supervisor.commit_timeout(
                instance,
                Duration::from_secs(30),
                CleanupMode::ForceKill,
                Duration::ZERO,
                &mut record,
            ),
            Err(SupervisorError::Superseded { .. })
        ));
        assert!(events.lock().expect("events lock").is_empty());
    }

    #[test]
    fn restart_a_superseded_by_b_never_reports_a_as_ready() {
        let supervisor = SidecarSupervisor::new();
        let a = supervisor.begin_start().expect("begin A");
        let (process_a, _) = FakeProcess::running();
        supervisor
            .attach_process(a, process_a, CleanupMode::ForceKill, Duration::ZERO)
            .expect("attach A");
        supervisor
            .stop(CleanupMode::ForceKill, Duration::ZERO)
            .expect("stop A");
        let b = supervisor.begin_start().expect("begin B");
        let (process_b, _) = FakeProcess::running();
        supervisor
            .attach_process(b, process_b, CleanupMode::ForceKill, Duration::ZERO)
            .expect("attach B");
        let (events, mut record) = recorded_events();

        assert!(matches!(
            supervisor.commit_ready(a, CleanupMode::ForceKill, Duration::ZERO, &mut record,),
            Err(SupervisorError::Superseded { .. })
        ));
        assert_eq!(
            supervisor
                .commit_ready(b, CleanupMode::ForceKill, Duration::ZERO, &mut record,)
                .expect("B becomes ready"),
            StartupOutcome::Ready
        );
        assert_eq!(
            *events.lock().expect("events lock"),
            vec![SidecarEvent::Ready { instance: b }]
        );
    }

    #[test]
    fn stop_during_pending_spawn_reaps_the_late_child_without_orphaning_it() {
        let supervisor = SidecarSupervisor::new();
        let stale = supervisor.begin_start().expect("begin stale startup");
        supervisor
            .stop(CleanupMode::ForceKill, Duration::ZERO)
            .expect("cancel pending startup");
        let (late_process, trace) = FakeProcess::running();

        assert!(matches!(
            supervisor.attach_process(stale, late_process, CleanupMode::ForceKill, Duration::ZERO,),
            Err(SupervisorError::Superseded { .. })
        ));
        let trace = trace.lock().expect("trace lock");
        assert_eq!(trace.kill_calls, 1);
        assert_eq!(trace.wait_calls, 1);
        drop(trace);
        assert!(supervisor.begin_start().is_ok());
    }

    #[test]
    fn observe_and_cleanup_failures_preserve_both_causes_and_attempt_reap() {
        let supervisor = SidecarSupervisor::new();
        let instance = supervisor.begin_start().expect("begin startup");
        let (process, trace) = FakeProcess::with_failures();
        supervisor
            .attach_process(instance, process, CleanupMode::Graceful, Duration::ZERO)
            .expect("attach process");

        let error = supervisor
            .observe(instance, CleanupMode::Graceful, Duration::ZERO)
            .expect_err("observe must fail");
        let rendered = error.to_string();
        assert!(rendered.contains("observe failed"), "{rendered}");
        assert!(rendered.contains("terminate failed"), "{rendered}");
        assert!(rendered.contains("kill failed"), "{rendered}");
        assert!(rendered.contains("reap wait failed"), "{rendered}");
        assert!(trace.lock().expect("trace lock").wait_calls >= 1);
        assert!(matches!(
            supervisor.begin_start(),
            Err(SupervisorError::CleanupPending { .. })
        ));
    }

    #[test]
    fn timeout_is_emitted_only_for_the_current_live_generation() {
        let supervisor = SidecarSupervisor::new();
        let a = supervisor.begin_start().expect("begin A");
        let (process_a, _) = FakeProcess::running();
        supervisor
            .attach_process(a, process_a, CleanupMode::ForceKill, Duration::ZERO)
            .expect("attach A");
        supervisor
            .stop(CleanupMode::ForceKill, Duration::ZERO)
            .expect("stop A");
        let b = supervisor.begin_start().expect("begin B");
        let (process_b, _) = FakeProcess::running();
        supervisor
            .attach_process(b, process_b, CleanupMode::ForceKill, Duration::ZERO)
            .expect("attach B");
        let (events, mut record) = recorded_events();

        assert!(matches!(
            supervisor.commit_timeout(
                a,
                Duration::from_secs(30),
                CleanupMode::ForceKill,
                Duration::ZERO,
                &mut record,
            ),
            Err(SupervisorError::Superseded { .. })
        ));
        assert!(matches!(
            supervisor.commit_timeout(
                b,
                Duration::from_secs(30),
                CleanupMode::ForceKill,
                Duration::ZERO,
                &mut record,
            ),
            Err(SupervisorError::Timeout { .. })
        ));
        assert_eq!(
            *events.lock().expect("events lock"),
            vec![SidecarEvent::Timeout { instance: b }]
        );
    }

    #[test]
    fn windows_force_kill_semantics_attempt_reap_even_when_kill_fails() {
        let (mut process, trace) = FakeProcess::running();
        process.kill_result = Err(ProcessFailure::new("TerminateProcess failed"));

        let report = cleanup_process(&mut process, CleanupMode::ForceKill, Duration::ZERO);

        assert!(report.reaped);
        assert!(report
            .error
            .as_ref()
            .is_some_and(|error| error.to_string().contains("TerminateProcess failed")));
        let trace = trace.lock().expect("trace lock");
        assert_eq!(trace.kill_calls, 1);
        assert_eq!(trace.wait_calls, 1);
    }
}
