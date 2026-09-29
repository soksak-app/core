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
