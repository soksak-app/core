//! The binary of the package that a test runs through CARGO_BIN_EXE_sok-probe has the features of the build of the test.

#[test]
fn the_binary_has_the_features_of_the_test() {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_sok-probe"))
        .output()
        .expect("run the sok-probe binary");
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        featurebinary::features()
    );
}
