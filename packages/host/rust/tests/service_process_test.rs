// contract: sidecars-transport.endpoint.zombie-service-does-not-exist
#[test]
fn a_zombie_service_process_does_not_exist() {
    // A spawn that was not awaited remains as a zombie. kill(pid, 0) passes a zombie (V5-106), so a zombie does not
    // exist: the decision to discard a stale endpoint and respawn must not be blocked by a zombie.
    let mut child = std::process::Command::new("sleep")
        .arg("30")
        .spawn()
        .expect("spawn sleep");
    let pid = child.id();
    child.kill().expect("kill sleep");
    let platform = soksak_host::platform::current().expect("platform");
    // The exit event makes it a zombie: the parent did not wait, so it remains in the table after it died. A process
    // after its exit event is in its exit or a zombie, and either has ended.
    assert!(
        platform
            .wait_service_process_end(pid, &soksak_host::platform::StopSignal::new())
            .expect("wait for the exit event"),
        "the killed sleep did not end"
    );
    let exists = platform
        .service_process_exists(pid, std::time::SystemTime::now())
        .expect("inspect");
    if exists {
        // The state of the table at the failure: SZOMB is 5 and PROC_FLAG_INEXIT is 4 in <sys/proc_info.h>.
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
        // SAFETY: proc_pidinfo writes at most size bytes of the description of pid into info.
        let written = unsafe {
            libc::proc_pidinfo(
                pid as libc::c_int,
                libc::PROC_PIDTBSDINFO,
                0,
                (&raw mut info).cast(),
                size,
            )
        };
        panic!(
            "a process that ended must not exist after its exit event: written {written} status {} flags {:#x}",
            info.pbi_status, info.pbi_flags
        );
    }
    child.wait().expect("reap sleep");
}

// A process of another user did not publish the endpoint, although it started before the publication, because the
// service runs as the user of the host.
// contract: sidecars-transport.endpoint.foreign-process-is-not-the-publisher
#[test]
fn a_process_of_another_user_is_not_the_publisher() {
    // 1 is launchd, which root runs.
    let exists = soksak_host::platform::current()
        .expect("platform")
        .service_process_exists(1, std::time::SystemTime::now())
        .expect("inspect process 1");
    assert!(
        !exists,
        "process 1 of another user is not the publisher of an endpoint"
    );
}

// The wait for a service process ends by the exit of the process or by its stop, and by no time limit: the exit answers
// ended, the stop answers not ended, and a process that does not exist has ended.
// contract: sidecars-transport.endpoint.waits-for-the-end-of-a-service-process
#[test]
fn the_wait_for_the_end_of_a_service_process() {
    use soksak_host::platform::StopSignal;
    let platform = soksak_host::platform::current().expect("platform");
    // The processes read their input, whose write end the Child holds, so each runs until the check ends it and ends with
    // the check process also when the check is killed.
    let cat = || {
        std::process::Command::new("cat")
            .stdin(std::process::Stdio::piped())
            .spawn()
            .expect("spawn cat")
    };
    let mut ending = cat();
    let pid = ending.id();
    let never = StopSignal::new();
    std::thread::scope(|scope| {
        let waited = scope.spawn(|| platform.wait_service_process_end(pid, &never));
        // The kill is the event that ends the wait; a wait that does not end stops at the limit of the runner.
        ending.kill().expect("kill cat");
        assert_eq!(waited.join().unwrap(), Ok(true), "a process that ends");
    });
    ending.wait().expect("reap cat");
    let mut running = cat();
    let stopped = StopSignal::new();
    stopped.stop();
    assert_eq!(
        platform.wait_service_process_end(running.id(), &stopped),
        Ok(false),
        "a process that keeps running until the stop"
    );
    running.kill().expect("kill cat");
    running.wait().expect("reap cat");
    assert_eq!(
        platform.wait_service_process_end(pid, &never),
        Ok(true),
        "a process that does not exist"
    );
}
