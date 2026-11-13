// Measures the mean time of one loop iteration and prints it, as the bench targets of the repository do.
use std::hint::black_box;
use std::time::Instant;

fn main() {
    const ITERATIONS: u32 = 1_000_000;
    let start = Instant::now();
    for index in 0..ITERATIONS {
        black_box(index);
    }
    let mean = start.elapsed().as_nanos() / ITERATIONS as u128;
    println!("event log mean {mean} ns");
}
