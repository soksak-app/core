// contract: sidecars-transport.endpoint.zombie-service-does-not-exist
#[test]
fn a_zombie_service_process_does_not_exist() {
    // 기다리지 않은 스폰은 좀비로 남는다. kill(pid, 0) 은 좀비를 통과시키므로(V5-106)
    // 좀비는 존재하지 않는 것이다 — 낡은 endpoint 를 버리고 재스폰하는 판정이 좀비에
    // 막혀서는 안 된다.
    let mut child = std::process::Command::new("sleep")
        .arg("30")
        .spawn()
        .expect("spawn sleep");
    let pid = child.id();
    child.kill().expect("kill sleep");
    // 좀비가 되기를 기다린다 — 부모가 기다리지 않았으므로 죽은 뒤에도 표에 남는다.
    std::thread::sleep(std::time::Duration::from_millis(100));
    let exists = soksak_host_tauriv2::platform::current()
        .expect("platform")
        .service_process_exists(pid)
        .expect("inspect");
    assert!(!exists, "a zombie service process must not exist");
    child.wait().expect("reap sleep");
}

// 다른 사용자의 프로세스에는 신호 확인이 거부된다. 거부(EPERM)는 그 번호의 프로세스가 있다는 뜻이므로 그 service
// 프로세스는 존재한다.
// contract: sidecars-transport.endpoint.foreign-service-process-exists
#[test]
fn a_service_process_of_another_user_exists() {
    // 1 은 root 가 실행하는 launchd 다.
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
    assert!(!platform
        .wait_service_process_end(running.id(), Duration::from_millis(200))
        .expect("wait for a process that keeps running"));
    running.kill().expect("kill sleep");
    running.wait().expect("reap sleep");
    assert!(platform
        .wait_service_process_end(pid, Duration::from_secs(1))
        .expect("wait for a process that does not exist"));
}
