//! The cost of `EventLog::emit` on the calling thread, alone and with several producers, against a writer that drains
//! at its own pace. The numbers are measured, not asserted (docs/spec/logging.md#writers).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use soksak_host_tauriv2::event_log::{EventLog, Level, Options};

fn summary(name: &str, mut samples: Vec<u64>) {
    samples.sort_unstable();
    let mean = samples.iter().sum::<u64>() / samples.len() as u64;
    println!(
        "{name:<42} mean {mean:>7} ns  p50 {:>7} ns  p99 {:>7} ns  max {:>9} ns",
        samples[samples.len() / 2],
        samples[samples.len() * 99 / 100],
        samples[samples.len() - 1]
    );
}

fn main() {
    let directory = tempfile::tempdir().unwrap();
    let log = Arc::new(
        EventLog::start(Options {
            directory: directory.path().to_path_buf(),
            role: "bench".into(),
            boot: "b1".into(),
            queue_events: 1 << 16,
            queue_bytes: 64 << 20,
            batch_interval: Duration::from_millis(100),
            rotate_bytes: 100 << 20,
            generations: 5,
            pull: None,
            pull_loss: None,
        })
        .unwrap(),
    );
    // The fields are built once; a producer of the host serializes a typed value once per event.
    #[derive(serde::Serialize)]
    struct Fields<'a> {
        key_code: u32,
        characters: &'a str,
    }
    for producers in [1usize, 4, 8] {
        let stop = Arc::new(AtomicBool::new(false));
        let handles: Vec<_> = (0..producers)
            .map(|_| {
                let log = Arc::clone(&log);
                let stop = Arc::clone(&stop);
                std::thread::spawn(move || {
                    let mut samples = Vec::with_capacity(100_000);
                    let mut lost = 0u64;
                    while samples.len() < 100_000 && !stop.load(Ordering::Relaxed) {
                        let start = Instant::now();
                        let accepted = log.emit(
                            Level::Info,
                            "host.bench.event",
                            &Fields {
                                key_code: 36,
                                characters: "\r",
                            },
                        );
                        samples.push(start.elapsed().as_nanos() as u64);
                        if !accepted {
                            lost += 1;
                        }
                    }
                    (samples, lost)
                })
            })
            .collect();
        let mut all = Vec::new();
        let mut lost = 0;
        for handle in handles {
            let (samples, l) = handle.join().unwrap();
            all.extend(samples);
            lost += l;
        }
        summary(&format!("emit, {producers} producer(s) (lost {lost})"), all);
    }
    log.flush(Duration::from_secs(30)).unwrap();
}
