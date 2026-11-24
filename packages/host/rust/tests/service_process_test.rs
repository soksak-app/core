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
