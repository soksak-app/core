//! The cost of the pull of the native ring across FFI (docs/spec/logging.md#writers): one call of the platform with an empty
//! ring, which is the cost of every idle batch interval of the writer. The numbers are measured, not asserted.

use std::time::Instant;

use soksak_host_tauriv2::platform;

fn summary(name: &str, mut samples: Vec<u64>) {
    samples.sort_unstable();
    let mean = samples.iter().sum::<u64>() / samples.len() as u64;
    println!(
        "{name:<40} mean {mean:>6} ns  p50 {:>6} ns  p99 {:>6} ns  max {:>8} ns",
        samples[samples.len() / 2],
        samples[samples.len() * 99 / 100],
        samples[samples.len() - 1]
    );
}

fn main() {
    let system = platform::current().expect("the platform");
    let mut buffer = vec![0u8; 256 << 10];
    let mut pulls = Vec::with_capacity(100_000);
    let mut losses = Vec::with_capacity(100_000);
    while pulls.len() < 100_000 {
        let start = Instant::now();
        system
            .pull_native_events(&mut buffer)
            .expect("pull of the native ring");
        pulls.push(start.elapsed().as_nanos() as u64);
        let start = Instant::now();
        system
            .take_native_event_loss()
            .expect("loss of the native ring");
        losses.push(start.elapsed().as_nanos() as u64);
    }
    summary("pull of an empty ring across FFI", pulls);
    summary("loss read of an empty ring across FFI", losses);
}
