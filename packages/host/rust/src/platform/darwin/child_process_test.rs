use super::child_process::group_signal_result;

// The system refuses a signal to a process group with an error other than ESRCH or EPERM, or the read of the processes of
// the group fails, only for an input that the host does not make; the test hands the judgement of the signal answer those
// errors, and both hosts name the system error with its number (docs/spec/sidecars.md#declaration-and-startup).
// contract: sidecars.end.names-the-system-error-by-its-number
#[test]
fn a_refused_group_signal_names_the_system_error_by_its_number() {
    let answer = Err(std::io::Error::from_raw_os_error(libc::EINVAL));
    assert_eq!(
        group_signal_result(answer, || panic!("an EINVAL answer reads no process")),
        Err("errno 22".to_string()),
        "signal"
    );
    let answer = Err(std::io::Error::from_raw_os_error(libc::EPERM));
    assert_eq!(
        group_signal_result(answer, || Err(std::io::Error::from_raw_os_error(
            libc::ENOMEM
        ))),
        Err("read the processes of the group: errno 12".to_string()),
        "read"
    );
    let answer = Err(std::io::Error::from_raw_os_error(libc::EPERM));
    assert_eq!(
        group_signal_result(answer, || Ok(vec![7, 8])),
        Err("operation not permitted; running: pid 7, pid 8".to_string()),
        "running"
    );
}
