use super::child_process::{group_signal_result, process_group_id};

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

// A process group id is a positive signed 32-bit number: the system reads the negated id of a group signal as 32 bits, so 0
// would signal the group of the host, and an id that wraps to 0 or 1 would signal the group of the host or every process.
// The test hands the conversion those ids without sending a signal (docs/spec/sidecars.md#declaration-and-startup).
// contract: sidecars.end.refuses-a-group-id-out-of-range
#[test]
fn a_process_group_id_out_of_range_is_refused() {
    for pid in [0, 1 << 31, u32::MAX] {
        assert_eq!(
            process_group_id(pid),
            Err("out of range".to_string()),
            "{pid}"
        );
    }
    assert_eq!(process_group_id(1), Ok(1));
    assert_eq!(process_group_id(i32::MAX as u32), Ok(i32::MAX));
}
