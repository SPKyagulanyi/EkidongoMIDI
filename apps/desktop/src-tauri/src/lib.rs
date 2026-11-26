//! EkidongoMIDI desktop: native MIDI delivery for the TypeScript engine (ADR 0005).
//!
//! - A scheduler thread owns the MIDI output. Events arrive with absolute timestamps on this
//!   process's monotonic clock (`clock_now`, in ms); the thread sleeps until 2 ms before each one,
//!   then spins, and sends it on time (Phase 0: p95 0.09 ms).
//! - The MIDI input callback passes right-hand notes and pedals straight to the output (no JavaScript
//!   in the path) and forwards every message to the window for chord recognition.
//! - On disconnect or exit: all notes off and Local Control back on, so the keyboard plays normally.

mod scheduler;

use midir::{MidiInput, MidiInputConnection, MidiOutput};
use scheduler::{Ev, Msg};
use serde::{Deserialize, Serialize};
use std::sync::{mpsc, Arc, Mutex, RwLock};
use std::thread::JoinHandle;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

/// Right-hand pass-through settings, pushed from the engine.
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Thru {
    split_point: u8,
    split_enabled: bool,
    right_channel: u8,
    layer_channel: u8,
    layer_on: bool,
}

impl Default for Thru {
    fn default() -> Self {
        Thru { split_point: 54, split_enabled: true, right_channel: 1, layer_channel: 2, layer_on: false }
    }
}

struct Connection {
    tx: mpsc::Sender<Msg>,
    input: Option<MidiInputConnection<()>>,
    thread: Option<JoinHandle<()>>,
    output_name: String,
}

impl Drop for Connection {
    fn drop(&mut self) {
        if let Some(input) = self.input.take() {
            input.close();
        }
        let _ = self.tx.send(Msg::Close);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

#[derive(Default)]
struct AppState {
    conn: Mutex<Option<Connection>>,
    thru: Arc<RwLock<Thru>>,
}

#[derive(Serialize)]
struct Ports {
    inputs: Vec<String>,
    outputs: Vec<String>,
}

#[derive(Serialize, Clone)]
struct MidiIn {
    t: f64,
    data: Vec<u8>,
}

#[tauri::command]
fn clock_now() -> f64 {
    scheduler::now_ms()
}

#[tauri::command]
fn list_ports() -> Result<Ports, String> {
    let mi = MidiInput::new("EkidongoMIDI probe").map_err(|e| e.to_string())?;
    let mo = MidiOutput::new("EkidongoMIDI probe").map_err(|e| e.to_string())?;
    let inputs = mi.ports().iter().filter_map(|p| mi.port_name(p).ok()).collect();
    let outputs = mo.ports().iter().filter_map(|p| mo.port_name(p).ok()).collect();
    Ok(Ports { inputs, outputs })
}

#[tauri::command]
fn connect(app: AppHandle, state: State<'_, AppState>, input: String, output: String) -> Result<(), String> {
    let mut guard = state.conn.lock().map_err(|e| e.to_string())?;
    *guard = None; // closes any previous connection first

    let mo = MidiOutput::new("EkidongoMIDI").map_err(|e| e.to_string())?;
    let out_port = mo
        .ports()
        .into_iter()
        .find(|p| mo.port_name(p).map(|n| n == output).unwrap_or(false))
        .ok_or_else(|| format!("MIDI output \"{output}\" not found"))?;
    let out = mo
        .connect(&out_port, "ekidongo-out")
        .map_err(|e| format!("Could not open \"{output}\" (is another app using it?): {e}"))?;

    let (tx, rx) = mpsc::channel::<Msg>();
    let thread = std::thread::Builder::new()
        .name("midi-scheduler".into())
        .spawn(move || scheduler::run(out, rx))
        .map_err(|e| e.to_string())?;

    // GM System On (unlocks the keyboard's drums and band sounds), then Local Control off:
    // the keys now sound through the app, so the right hand isn't doubled.
    let thru_now = *state.thru.read().map_err(|e| e.to_string())?;
    let _ = tx.send(Msg::Now(vec![0xF0, 0x7E, 0x7F, 0x09, 0x01, 0xF7]));
    let _ = tx.send(Msg::Now(vec![0xB0 | (thru_now.right_channel - 1), 122, 0]));

    let mi = MidiInput::new("EkidongoMIDI").map_err(|e| e.to_string())?;
    let in_port = mi
        .ports()
        .into_iter()
        .find(|p| mi.port_name(p).map(|n| n == input).unwrap_or(false))
        .ok_or_else(|| format!("MIDI input \"{input}\" not found"))?;
    let thru = state.thru.clone();
    let tx_in = tx.clone();
    let app_in = app.clone();
    let input_conn = mi
        .connect(
            &in_port,
            "ekidongo-in",
            move |_stamp, msg, _| on_input(msg, &thru, &tx_in, &app_in),
            (),
        )
        .map_err(|e| format!("Could not open \"{input}\": {e}"))?;

    *guard = Some(Connection { tx, input: Some(input_conn), thread: Some(thread), output_name: output });
    Ok(())
}

fn on_input(msg: &[u8], thru: &RwLock<Thru>, tx: &mpsc::Sender<Msg>, app: &AppHandle) {
    let t = scheduler::now_ms();
    let Some(&status) = msg.first() else { return };
    if status >= 0xF0 {
        return; // clock, active sensing
    }
    let cfg = thru.read().map(|g| *g).unwrap_or_default();
    let kind = status & 0xF0;
    if (kind == 0x80 || kind == 0x90) && msg.len() >= 3 {
        let right_zone = !cfg.split_enabled || msg[1] >= cfg.split_point;
        if right_zone {
            let on = kind == 0x90 && msg[2] > 0;
            let (s, v) = if on { (0x90, msg[2]) } else { (0x80, 0) };
            let _ = tx.send(Msg::Now(vec![s | (cfg.right_channel - 1), msg[1], v]));
            if cfg.layer_on || !on {
                let _ = tx.send(Msg::Now(vec![s | (cfg.layer_channel - 1), msg[1], v]));
            }
        }
    } else if kind == 0xB0 && msg.len() >= 3 && msg[1] != 122 {
        let _ = tx.send(Msg::Now(vec![0xB0 | (cfg.right_channel - 1), msg[1], msg[2]]));
        let _ = tx.send(Msg::Now(vec![0xB0 | (cfg.layer_channel - 1), msg[1], msg[2]]));
    }
    let _ = app.emit("midi-in", MidiIn { t, data: msg.to_vec() });
}

#[tauri::command]
fn disconnect(state: State<'_, AppState>) -> Result<(), String> {
    *state.conn.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}

#[tauri::command]
fn connected_output(state: State<'_, AppState>) -> Option<String> {
    state.conn.lock().ok()?.as_ref().map(|c| c.output_name.clone())
}

#[tauri::command]
fn schedule(state: State<'_, AppState>, events: Vec<Ev>) -> Result<(), String> {
    if events.is_empty() {
        return Ok(());
    }
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("not connected")?;
    conn.tx.send(Msg::Events(events)).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_thru(state: State<'_, AppState>, thru: Thru) -> Result<(), String> {
    *state.thru.write().map_err(|e| e.to_string())? = thru;
    Ok(())
}

#[tauri::command]
fn panic(state: State<'_, AppState>) -> Result<(), String> {
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    if let Some(conn) = guard.as_ref() {
        conn.tx.send(Msg::Panic).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    scheduler::raise_timer_resolution();
    let app = tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            clock_now,
            list_ports,
            connect,
            disconnect,
            connected_output,
            schedule,
            set_thru,
            panic
        ])
        .build(tauri::generate_context!())
        .expect("error while building EkidongoMIDI");
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            // Restore the keyboard (all notes off, Local Control on) before the process ends.
            if let Ok(mut guard) = handle.state::<AppState>().conn.lock() {
                *guard = None;
            }
        }
    });
}
