//! Checks the publisher rule of a persistent service endpoint (docs/spec/persistent-services.md#endpoint-publisher).

#![cfg(target_os = "macos")]

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
    let platform = soksak_sok::platform::current().expect("platform");
    // The exit event makes it a zombie: the parent did not wait, so it remains in the table after it died. A process
    // after its exit event is in its exit or a zombie, and either has ended.
    platform
        .wait_process_end(pid as i32)
        .expect("wait for the exit event");
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
    let exists = soksak_sok::platform::current()
        .expect("platform")
        .service_process_exists(1, std::time::SystemTime::now())
        .expect("inspect process 1");
    assert!(
        !exists,
        "process 1 of another user is not the publisher of an endpoint"
    );
}
