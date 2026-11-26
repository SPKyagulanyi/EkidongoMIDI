import { defineConfig } from 'vite';

// Tauri serves the dev server inside its window; keep the port fixed and don't open a browser.
export default defineConfig({
  clearScreen: false,
  // Never watch the Rust side: its build output is locked while compiling (EBUSY on Windows).
  server: { port: 5175, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: { target: 'es2022', sourcemap: true },
});
