//! Plays the Timing Lab click pattern through midir (WinMM backend on Windows) - the MIDI
//! stack a Tauri desktop app would use. Start "Record native test" in the Timing Lab, then:
//!
//!     cargo run --release -- [--count 160] [--interval 125] [--note 76] [--port roland]
//!
//! Scheduling: sleep until 2 ms before each click, then spin - the plan's native design.

use midir::MidiOutput;
use std::error::Error;
use std::time::{Duration, Instant};

fn arg<T: std::str::FromStr>(args: &[String], name: &str, default: T) -> T {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = std::env::args().collect();
    let count: usize = arg(&args, "--count", 160);
    let interval_ms: f64 = arg(&args, "--interval", 125.0);
    let note: u8 = arg(&args, "--note", 76);
    let keyword: String = arg(&args, "--port", "roland".to_string()).to_lowercase();

    let out = MidiOutput::new("EkidongoMIDI timing")?;
    let ports = out.ports();
    let port = ports
        .iter()
        .find(|p| out.port_name(p).map(|n| n.to_lowercase().contains(&keyword)).unwrap_or(false))
        .ok_or("No matching MIDI output. Is the keyboard on, and is the browser still holding the port?")?;
    let name = out.port_name(port)?;
    let mut conn = out.connect(port, "click").map_err(|e| format!("connect failed: {e}"))?;

    println!("Playing {count} clicks every {interval_ms} ms on {name} (Rust/midir)...");
    let start = Instant::now() + Duration::from_millis(1500);
    let spin_window = Duration::from_millis(2);
    let mut lateness = Vec::with_capacity(count);

    for i in 0..count {
        let target = start + Duration::from_secs_f64(i as f64 * interval_ms / 1000.0);
        loop {
            let now = Instant::now();
            if now >= target {
                break;
            }
            let left = target - now;
            if left > spin_window {
                std::thread::sleep(left - spin_window);
            } else {
                std::hint::spin_loop();
            }
        }
        lateness.push(Instant::now().saturating_duration_since(target).as_secs_f64() * 1000.0);
        if i > 0 {
            conn.send(&[0x89, note, 0])?; // release the previous click
        }
        conn.send(&[0x99, note, 110])?;
    }
    std::thread::sleep(Duration::from_millis(200));
    conn.send(&[0xB9, 123, 0])?; // all notes off
    conn.close();

    lateness.sort_by(|a, b| a.total_cmp(b));
    let mean = lateness.iter().sum::<f64>() / lateness.len() as f64;
    let p95 = lateness[((lateness.len() - 1) as f64 * 0.95) as usize];
    let max = lateness.last().copied().unwrap_or(0.0);
    println!("Send-call lateness: mean {mean:.3} ms, p95 {p95:.3} ms, max {max:.3} ms");
    println!("Done - read the audio-measured result in the Timing Lab.");
    Ok(())
}
