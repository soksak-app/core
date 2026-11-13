//! The runner of a test target that runs on the main thread of its process (`harness = false` in Cargo.toml). The libtest
//! harness runs each test on a thread of its own, and the native layout runs only on the main thread, so such a target
//! calls its named test functions from main. The runner answers `--list` and `--exact <name>` as the libtest harness does
//! and prints, for each test, `running <name>` when it starts and `passed <name>` or `failed <name>` with the elapsed time
//! when it ends; the summary line is the one that `scripts/rust-tests.mjs` reads.
//!
//! libtest-mimic 0.8.2 was considered. Its single-thread mode runs the tests on the main thread, but it prints neither a
//! running line nor an elapsed time per test, so it does not give the report that this runner gives. The limit of each
//! test is not set here: `scripts/rust-tests.mjs` starts each test with `--exact` and ends it at its own limit.

use std::time::Instant;

/// A named test of a main-thread target.
pub type MainTest = (&'static str, fn() -> Result<(), String>);

/// Runs the tests of the target on the calling thread, which is the main thread of the process, and ends the process with
/// status 1 when one test failed.
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
    let (mut passed, mut failed) = (0, 0);
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
    // The summary line of the harness, which the runner reads.
    let result = if failed == 0 { "ok" } else { "FAILED" };
    println!("test result: {result}. {passed} passed; {failed} failed");
    if failed > 0 {
        std::process::exit(1);
    }
}
