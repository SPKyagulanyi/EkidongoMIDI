# Releasing EkidongoMIDI

## How updates reach players

1. A version tag (`v0.2.0`) on GitHub runs `.github/workflows/release.yml` on Windows.
2. It builds the installer, **signs** it with the update key, writes `latest.json` and publishes a
   GitHub release with both files.
3. Installed apps check `releases/latest/download/latest.json` about 15 seconds after start-up and
   in Settings > About > Check for updates. They show "Update available"; the player chooses when to
   install (never while the band is playing). The app verifies the signature before installing.

Tags with a suffix (`v0.2.0-beta.1`) become pre-releases and are **not** offered as updates: use
them to give a test build to the band first.

## Steps

1. Bump the version in `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/package.json` and
   `apps/desktop/src-tauri/Cargo.toml` (all three must match; the workflow checks the tag).
2. Commit, then tag and push: `git tag v0.2.0 && git push origin v0.2.0`.
3. Watch the "Release (Windows installer)" run on GitHub; the release appears when it finishes.

Local signed build: `powershell -ExecutionPolicy Bypass -File tools\build-installer.ps1`.

## The update signing key: keep it safe

- Files: `%USERPROFILE%\.tauri\ekidongomidi-updater.key` (private key),
  `ekidongomidi-updater.password.txt` (its password) and `ekidongomidi-updater.key.pub` (public key,
  also in `tauri.conf.json`).
- GitHub has copies as the secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- **Back up the private key and password** (password manager or an offline drive). If the key is
  lost, installed apps can never be updated again: players would have to reinstall by hand.
- **Never share or commit them.** Anyone with both could publish an update that installed apps
  would trust.

## Not yet done

- Code signing of the installer itself (removes Windows SmartScreen's "Windows protected your PC"
  warning) needs a code-signing certificate, which costs money each year.
