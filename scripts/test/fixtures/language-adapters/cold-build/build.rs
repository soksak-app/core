// Sleeps before the build of the package, so a cold build takes longer than the limit of a test of the package.
fn main() {
    std::thread::sleep(std::time::Duration::from_secs(3));
}
