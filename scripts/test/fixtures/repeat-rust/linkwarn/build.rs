// Builds the object of value.c for macOS 27.0. The test link of the package uses the deployment target of the build, so ld reports
// the object as built for a newer version than the link.
use std::env;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=value.c");
    let object = PathBuf::from(env::var("OUT_DIR").unwrap()).join("value.o");
    let status = Command::new("cc").args(["-c", "-mmacosx-version-min=27.0", "value.c", "-o"]).arg(&object).status().expect("cc starts");
    assert!(status.success(), "cc failed");
    println!("cargo:rustc-link-arg={}", object.display());
}
