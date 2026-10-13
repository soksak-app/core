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
    let exists = soksak_host_tauriv2::platform::current()
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
    let exists = soksak_host_tauriv2::platform::current()
        .expect("platform")
        .service_process_exists(1)
        .expect("inspect process 1");
    assert!(exists, "process 1 of another user must exist");
}

// contract: sidecars-transport.endpoint.waits-for-the-end-of-a-service-process
#[test]
fn the_wait_for_the_end_of_a_service_process() {
    use std::time::{Duration, Instant};
    let platform = soksak_host_tauriv2::platform::current().expect("platform");
    let mut ending = std::process::Command::new("sleep")
        .arg("30")
        .spawn()
        .expect("spawn sleep");
    let pid = ending.id();
    let killer = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(150));
        ending.kill().expect("kill sleep");
        ending.wait().expect("reap sleep");
    });
    let started = Instant::now();
    let ended = platform
        .wait_service_process_end(pid, Duration::from_secs(10))
        .expect("wait for a process that ends");
    assert!(
        ended && started.elapsed() < Duration::from_secs(5),
        "ended {ended} after {:?}",
        started.elapsed()
    );
    killer.join().expect("killer");
    let mut running = std::process::Command::new("sleep")
        .arg("30")
        .spawn()
        .expect("spawn sleep");
    assert!(
        !platform
            .wait_service_process_end(running.id(), Duration::from_millis(200))
            .expect("wait for a process that keeps running")
    );
    running.kill().expect("kill sleep");
    running.wait().expect("reap sleep");
    assert!(
        platform
            .wait_service_process_end(pid, Duration::from_secs(1))
            .expect("wait for a process that does not exist")
    );
}
