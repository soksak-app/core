//! An Objective-C exception that leaves a thread of the host after its standard error file is open writes the error line of an
//! uncaught exception (docs/spec/diagnostics.md).

#[path = "support/folder.rs"]
mod folder;

#[path = "support/records.rs"]
mod records;

#[path = "support/crash_child.rs"]
mod crash_child;

use objc2::msg_send;
use objc2::rc::Retained;
use objc2::runtime::NSObject;
use soksak_host::application_log::start_standard_error;

const CHILD: &str = "SOKSAK_FATAL_EXCEPTION_CHILD";

// contract: log.fatal-exception.writes-an-error-line
#[test]
fn an_exception_that_leaves_a_thread_of_the_host_writes_the_error_line_of_an_uncaught_exception() {
    if let Some(config) = std::env::var_os(CHILD) {
        if let Err(error) = start_standard_error(std::path::Path::new(&config), "com.soksak.test") {
            println!("{error}");
            std::process::exit(2);
        }
        // NSObject does not answer copyWithZone:, so the copy throws NSInvalidArgumentException in the thread, as a native
        // assertion of the main thread throws NSInternalInconsistencyException in a thread of the host.
        let thread = soksak_host::routine::spawn_named("exception-probe", || {
            let object = NSObject::new();
            let _copy: Retained<NSObject> = unsafe { msg_send![&object, copy] };
        });
        let ended = thread.join();
        println!("the thread ended with {ended:?} and the process did not end");
        std::process::exit(3);
    }
    let config = folder::Folder::new();
    let copies = folder::Folder::new();
    let output = std::fs::File::create(copies.path().join("output")).unwrap();
    let child = crash_child::spawn(
        &std::env::current_exe().unwrap(),
        &[
            "--exact",
            "an_exception_that_leaves_a_thread_of_the_host_writes_the_error_line_of_an_uncaught_exception",
            "--nocapture",
            "--test-threads=1",
        ],
        &format!("{CHILD}={}", config.path().display()),
        &output,
    );
    let outcome = crash_child::wait(child);
    use std::os::unix::process::ExitStatusExt;
    // The handled crash exception keeps the system from writing a crash report; the wait status still ends with SIGABRT.
    assert_eq!(
        (
            outcome.handled,
            std::process::ExitStatus::from_raw(outcome.status).signal()
        ),
        (1, Some(6)),
        "the child ended with wait status {:#x}, output {:?}",
        outcome.status,
        std::fs::read_to_string(copies.path().join("output")).unwrap_or_default()
    );
    let log = records::standard_error_text(config.path());
    let fatal: Vec<&str> = log
        .lines()
        .filter(|line| line.contains(" error native fatal: "))
        .map(|line| line.split_once(' ').expect("a time and a record").1)
        .collect();
    // The reason ends with the address of the object, which differs in each run.
    let prefix = "error native fatal: uncaught exception NSInvalidArgumentException: -[NSObject copyWithZone:]: unrecognized selector sent to instance 0x";
    assert!(
        fatal.len() == 1 && fatal[0].starts_with(prefix),
        "standard error file {log:?}"
    );
}
