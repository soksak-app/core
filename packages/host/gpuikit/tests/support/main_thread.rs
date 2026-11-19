//! The runner of a test target that runs on the main thread of its process (`harness = false` in Cargo.toml). The native window
//! of a view is read only on the main thread, and the libtest harness runs each test on a thread of its own, so such a target
//! calls its named test functions from main. The runner answers `--list` and `--exact <name>` as the libtest harness does, and
//! prints `running <name>` when a test starts and `passed <name>` or `failed <name>` with its elapsed time when it ends.

use std::time::Instant;

/// A named test of a main-thread target.
pub type MainTest = (&'static str, fn() -> Result<(), String>);

/// Runs the tests of the target on the calling thread and ends the process with status 1 when one test failed.
pub fn run(tests: &[MainTest]) {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if arguments.iter().any(|argument| argument == "--list") {
        for (name, _) in tests {
            println!("{name}: test");
        }
        return;
    }
    let exact = arguments
        .iter()
        .position(|argument| argument == "--exact")
        .and_then(|at| arguments.get(at + 1));
    let mut failed = 0;
    let mut passed = 0;
    for (name, test) in tests
        .iter()
        .filter(|(name, _)| exact.is_none_or(|exact| exact == name))
    {
        println!("running {name}");
        let started = Instant::now();
        let result = test();
        let elapsed = started.elapsed().as_secs_f64();
        match result {
            Ok(()) => {
                println!("passed {name} in {elapsed:.3}s");
                passed += 1;
            }
            Err(error) => {
                println!("failed {name} in {elapsed:.3}s: {error}");
                failed += 1;
            }
        }
    }
    let result = if failed == 0 { "ok" } else { "FAILED" };
    println!("test result: {result}. {passed} passed; {failed} failed");
    if failed > 0 {
        std::process::exit(1);
    }
}
