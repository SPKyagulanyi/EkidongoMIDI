//! The MIDI delivery thread: a time-ordered queue of events, sent at their timestamps.

use midir::MidiOutputConnection;
use serde::Deserialize;
use std::cmp::Ordering;
use std::collections::BinaryHeap;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// Spin (instead of sleeping) for the last stretch before an event.
const SPIN_MS: f64 = 2.0;

static EPOCH: OnceLock<Instant> = OnceLock::new();

/// Milliseconds since the app started, on the monotonic clock events are stamped with.
pub fn now_ms() -> f64 {
    EPOCH.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

#[derive(Deserialize, Debug, Clone)]
pub struct Ev {
    pub t: f64,
    pub data: Vec<u8>,
}

pub enum Msg {
    /// Timestamped events from the engine.
    Events(Vec<Ev>),
    /// Send immediately (pass-through, setup).
    Now(Vec<u8>),
    /// Drop everything queued and silence all channels.
    Panic,
    /// Restore the keyboard and end the thread.
    Close,
}

struct Timed {
    ev: Ev,
    seq: u64,
}

impl PartialEq for Timed {
    fn eq(&self, o: &Self) -> bool {
        self.cmp(o) == Ordering::Equal
    }
}
impl Eq for Timed {}
impl PartialOrd for Timed {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for Timed {
    /// Reversed so BinaryHeap pops the EARLIEST event; ties keep arrival order.
    fn cmp(&self, o: &Self) -> Ordering {
        o.ev.t.total_cmp(&self.ev.t).then_with(|| o.seq.cmp(&self.seq))
    }
}

fn silence(out: &mut MidiOutputConnection) {
    for ch in 0..16u8 {
        let _ = out.send(&[0xB0 | ch, 64, 0]); // sustain off
        let _ = out.send(&[0xB0 | ch, 120, 0]); // all sound off
        let _ = out.send(&[0xB0 | ch, 123, 0]); // all notes off
        let _ = out.send(&[0xB0 | ch, 121, 0]); // reset controllers
    }
}

pub fn run(mut out: MidiOutputConnection, rx: Receiver<Msg>) {
    let mut queue: BinaryHeap<Timed> = BinaryHeap::new();
    let mut seq: u64 = 0;
    loop {
        let wait = match queue.peek() {
            Some(top) => {
                let d = top.ev.t - now_ms();
                if d > SPIN_MS { Duration::from_secs_f64((d - SPIN_MS) / 1000.0) } else { Duration::ZERO }
            }
            None => Duration::from_millis(100),
        };
        match rx.recv_timeout(wait) {
            Ok(Msg::Events(evs)) => {
                for ev in evs {
                    queue.push(Timed { ev, seq });
                    seq += 1;
                }
            }
            Ok(Msg::Now(data)) => {
                let _ = out.send(&data);
            }
            Ok(Msg::Panic) => {
                queue.clear();
                silence(&mut out);
            }
            Ok(Msg::Close) | Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {}
        }
        // Send everything due, spinning through the last SPIN_MS before each event.
        while let Some(top) = queue.peek() {
            let target = top.ev.t;
            if target - now_ms() > SPIN_MS {
                break;
            }
            while now_ms() < target {
                std::hint::spin_loop();
            }
            if let Some(Timed { ev, .. }) = queue.pop() {
                let _ = out.send(&ev.data);
            }
        }
    }
    silence(&mut out);
    let _ = out.send(&[0xB0, 122, 127]); // Local Control back on: the keyboard plays by itself again
    out.close();
}

#[cfg(windows)]
#[link(name = "winmm")]
extern "system" {
    fn timeBeginPeriod(period: u32) -> u32;
}

/// Ask Windows for 1 ms timer resolution so the scheduler's waits wake on time.
pub fn raise_timer_resolution() {
    #[cfg(windows)]
    unsafe {
        timeBeginPeriod(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn earliest_event_pops_first_and_ties_keep_order() {
        let mut q = BinaryHeap::new();
        for (i, t) in [30.0, 10.0, 20.0, 10.0].iter().enumerate() {
            q.push(Timed { ev: Ev { t: *t, data: vec![i as u8] }, seq: i as u64 });
        }
        let order: Vec<u8> = std::iter::from_fn(|| q.pop().map(|x| x.ev.data[0])).collect();
        assert_eq!(order, vec![1, 3, 2, 0]);
    }

    #[test]
    fn clock_is_monotonic() {
        let a = now_ms();
        let b = now_ms();
        assert!(b >= a);
    }
}
