// Runs longer than the limit of the runner test, so the runner kills it.
use std::thread::sleep;
use std::time::Duration;

fn main() {
    sleep(Duration::from_secs(30));
}
