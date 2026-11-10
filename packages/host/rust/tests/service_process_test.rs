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
    // Wait to become a zombie: the parent did not wait, so it remains in the table even after it died.
    std::thread::sleep(std::time::Duration::from_millis(100));
    let exists = soksak_host::platform::current()
        .expect("platform")
        .service_process_exists(pid)
        .expect("inspect");
    assert!(!exists, "a zombie service process must not exist");
    child.wait().expect("reap sleep");
}

// The signal check is refused for a process of another user. A refusal (EPERM) means that a process with that number
// exists, so that service process exists.
// contract: sidecars-transport.endpoint.foreign-service-process-exists
#[test]
fn a_service_process_of_another_user_exists() {
    // 1 is launchd, which root runs.
    let exists = soksak_host::platform::current()
        .expect("platform")
        .service_process_exists(1)
        .expect("inspect process 1");
    assert!(exists, "process 1 of another user must exist");
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
