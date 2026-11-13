// Exports the deployment target of the build, so that a test of the fixture reads the value that Cargo gave the build.
fn main() {
    println!("cargo:rerun-if-env-changed=MACOSX_DEPLOYMENT_TARGET");
    println!("cargo:rustc-env=FIXTURE_DEPLOYMENT_TARGET={}", std::env::var("MACOSX_DEPLOYMENT_TARGET").unwrap_or_default());
}
