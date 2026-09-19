//! 종료 신호 테스트. 신호는 프로세스 전체에 영향을 주므로 자식 프로세스에서 확인한다.

use std::io::Read;
use std::os::unix::process::ExitStatusExt;
use std::process::{Command, Stdio};
use std::sync::mpsc;

use signal_hook::consts::SIGTERM;
use signal_hook::low_level::raise;
use soksak_host_tauriv2::termination;

/// 자식 프로세스임을 알리는 환경 변수.
const CHILD: &str = "SOKSAK_TERMINATION_CHILD";

const NAME: &str = "a_termination_signal_requests_quit_once_and_the_next_ends_the_process";

#[test]
fn a_termination_signal_requests_quit_once_and_the_next_ends_the_process() {
    if std::env::var_os(CHILD).is_some() {
        return terminate();
    }
    // 자식은 표준 입력을 읽으며 기다린다. 부모가 쓰는 쪽을 열어 두므로 신호 없이는 끝나지 않는다.
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", NAME, "--nocapture", "--test-threads=1"])
        .env(CHILD, "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let stdin = child.stdin.take();
    let mut output = String::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut output)
        .unwrap();
    let status = child.wait().unwrap();
    drop(stdin);
    assert_eq!(
        status.signal(),
        Some(SIGTERM),
        "status {status}, output {output:?}"
    );
    assert!(output.contains("quit requested"), "output {output:?}");
    assert!(!output.contains("did not end"), "output {output:?}");
}

/// 종료 신호를 두 번 받는다. 첫 신호는 quit 를 부르고, 둘째 신호는 프로세스를 끝낸다.
fn terminate() {
    let (quit, quitted) = mpsc::channel();
    termination::on_termination(Box::new(move || {
        let _ = quit.send(());
    }))
    .unwrap();
    raise(SIGTERM).unwrap();
    quitted.recv().unwrap();
    println!("quit requested");
    raise(SIGTERM).unwrap();
    let _ = std::io::stdin().read(&mut [0u8]);
    println!("the second signal did not end the process");
    std::process::exit(3);
}
