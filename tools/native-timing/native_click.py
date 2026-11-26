"""
Phase 0 native baseline: plays the same click pattern as the Timing Lab through the
Windows MIDI API (WinMM) - the API Rust's midir uses on Windows, so this stands in for a
native/Tauri backend. Start "Record native test" in the Timing Lab first, then run:

    py tools/native-timing/native_click.py [--count 160] [--interval 125] [--mode hybrid|sleep]

hybrid = sleep until 2 ms before each click, then spin (how a native scheduler would do it)
sleep  = plain time.sleep (naive)
"""
import argparse
import ctypes
import statistics
import sys
import time
from ctypes import wintypes

winmm = ctypes.WinDLL("winmm")
winmm.midiOutOpen.argtypes = [ctypes.POINTER(wintypes.HANDLE), wintypes.UINT, ctypes.c_void_p, ctypes.c_size_t, wintypes.DWORD]
winmm.midiOutShortMsg.argtypes = [wintypes.HANDLE, wintypes.DWORD]
winmm.midiOutClose.argtypes = [wintypes.HANDLE]


class MIDIOUTCAPSW(ctypes.Structure):
    _fields_ = [("wMid", wintypes.WORD), ("wPid", wintypes.WORD), ("vDriverVersion", wintypes.UINT),
                ("szPname", wintypes.WCHAR * 32), ("wTechnology", wintypes.WORD), ("wVoices", wintypes.WORD),
                ("wNotes", wintypes.WORD), ("wChannelMask", wintypes.WORD), ("dwSupport", wintypes.DWORD)]


def find_port(keyword):
    for i in range(winmm.midiOutGetNumDevs()):
        c = MIDIOUTCAPSW()
        winmm.midiOutGetDevCapsW(i, ctypes.byref(c), ctypes.sizeof(c))
        if keyword in c.szPname.lower():
            return i, c.szPname
    return None, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=160)
    ap.add_argument("--interval", type=float, default=125.0, help="ms between clicks")
    ap.add_argument("--note", type=int, default=76)
    ap.add_argument("--mode", choices=["hybrid", "sleep"], default="hybrid")
    ap.add_argument("--delay", type=float, default=1.5, help="seconds before the first click")
    ap.add_argument("--port", default="roland")
    a = ap.parse_args()

    idx, name = find_port(a.port.lower())
    if idx is None:
        sys.exit(f"No MIDI output containing '{a.port}'. Is the keyboard on? Is the browser still holding the port?")
    h = wintypes.HANDLE()
    r = winmm.midiOutOpen(ctypes.byref(h), idx, None, 0, 0)
    if r:
        sys.exit(f"midiOutOpen failed ({r}). Another app (e.g. the browser) may be using the port.")
    send = lambda st, d1, d2: winmm.midiOutShortMsg(h, st | (d1 << 8) | (d2 << 16))

    lateness = []
    try:
        start = time.perf_counter() + a.delay
        print(f"Playing {a.count} clicks every {a.interval} ms on {name} ({a.mode} mode)...")
        for i in range(a.count):
            target = start + i * a.interval / 1000
            if a.mode == "hybrid":
                while True:
                    d = target - time.perf_counter()
                    if d <= 0:
                        break
                    if d > 0.002:
                        time.sleep(d - 0.002)
            else:
                d = target - time.perf_counter()
                if d > 0:
                    time.sleep(d)
            lateness.append((time.perf_counter() - target) * 1000)
            if i:
                send(0x89, a.note, 0)  # release the previous click first
            send(0x99, a.note, 110)
        time.sleep(0.2)
    finally:
        send(0xB9, 123, 0)
        winmm.midiOutClose(h)

    lat = sorted(lateness)
    p95 = lat[int(0.95 * (len(lat) - 1))]
    print(f"Send-call lateness: mean {statistics.mean(lat):.3f} ms, p95 {p95:.3f} ms, max {lat[-1]:.3f} ms")
    print("Done - read the audio-measured result in the Timing Lab.")


if __name__ == "__main__":
    main()
