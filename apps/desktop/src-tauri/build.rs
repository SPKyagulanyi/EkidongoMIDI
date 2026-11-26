//! Build script: Tauri's codegen, plus the Sentry DSN baked in at compile time.
//!
//! The DSN comes from the SENTRY_DSN environment variable (CI), or from VITE_SENTRY_DSN in
//! apps/desktop/.env.local (the same git-ignored file the window uses). No DSN = no reporting.

use std::fs;

fn main() {
    println!("cargo:rerun-if-env-changed=SENTRY_DSN");
    println!("cargo:rerun-if-changed=../.env.local");
    let dsn = std::env::var("SENTRY_DSN").ok().filter(|s| !s.is_empty()).or_else(|| {
        fs::read_to_string("../.env.local").ok().and_then(|text| {
            text.lines()
                .find_map(|l| l.trim().strip_prefix("VITE_SENTRY_DSN=").map(|v| v.trim().to_string()))
                .filter(|v| !v.is_empty())
        })
    });
    if let Some(dsn) = dsn {
        println!("cargo:rustc-env=EKIDONGO_SENTRY_DSN={dsn}");
    }
    tauri_build::build()
}
