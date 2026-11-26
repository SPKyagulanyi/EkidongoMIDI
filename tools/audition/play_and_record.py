"""
Plays rendered style events on the keyboard (WinMM, precise timing) while ffmpeg records the
keyboard's own USB audio, one WAV per style:
    py tools/audition/play_and_record.py <events.json> <out-dir> [--device "Line (Roland Digital Piano)"]
"""
import argparse
import ctypes
import json
import os
import subprocess
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


class MIDIHDR(ctypes.Structure):
    _fields_ = [("lpData", ctypes.c_char_p), ("dwBufferLength", wintypes.DWORD), ("dwBytesRecorded", wintypes.DWORD),
                ("dwUser", ctypes.c_size_t), ("dwFlags", wintypes.DWORD), ("lpNext", ctypes.c_void_p),
                ("reserved", ctypes.c_size_t), ("dwOffset", wintypes.DWORD), ("dwReserved", ctypes.c_size_t * 8)]


def open_port(keyword="roland"):
    for i in range(winmm.midiOutGetNumDevs()):
        c = MIDIOUTCAPSW()
        winmm.midiOutGetDevCapsW(i, ctypes.byref(c), ctypes.sizeof(c))
        if keyword in c.szPname.lower():
            h = wintypes.HANDLE()
            if winmm.midiOutOpen(ctypes.byref(h), i, None, 0, 0) == 0:
                return h
            sys.exit("Could not open the keyboard's MIDI port (is EkidongoMIDI still running?)")
    sys.exit("Keyboard MIDI port not found")


def sysex(h, data):
    buf = ctypes.create_string_buffer(bytes(data), len(data))
    hdr = MIDIHDR(lpData=ctypes.cast(buf, ctypes.c_char_p), dwBufferLength=len(data))
    winmm.midiOutPrepareHeader(h, ctypes.byref(hdr), ctypes.sizeof(hdr))
    winmm.midiOutLongMsg(h, ctypes.byref(hdr), ctypes.sizeof(hdr))
    time.sleep(0.3)
    winmm.midiOutUnprepareHeader(h, ctypes.byref(hdr), ctypes.sizeof(hdr))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("events")
    ap.add_argument("outdir")
    ap.add_argument("--device", default="Line (Roland Digital Piano)")
    a = ap.parse_args()
    styles = json.load(open(a.events, encoding="utf-8"))
    os.makedirs(a.outdir, exist_ok=True)
    h = open_port()
    send = lambda d: winmm.midiOutShortMsg(h, d[0] | ((d[1] if len(d) > 1 else 0) << 8) | ((d[2] if len(d) > 2 else 0) << 16))
    try:
        for s in styles:
            sysex(h, [0xF0, 0x7E, 0x7F, 0x09, 0x01, 0xF7])  # GM System On
            wav = os.path.join(a.outdir, f"{s['id']}.wav")
            rec = subprocess.Popen(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "dshow",
                                    "-i", f"audio={a.device}", "-ac", "2", "-ar", "48000", wav],
                                   stdin=subprocess.PIPE)
            time.sleep(1.5)  # let the capture start
            print(f"Playing {s['name']} ({s['durationMs'] / 1000:.1f} s)...", flush=True)
            start = time.perf_counter()
            for ev in s["events"]:
                target = start + ev[0] / 1000
                while True:
                    d = target - time.perf_counter()
                    if d <= 0:
                        break
                    if d > 0.002:
                        time.sleep(d - 0.002)
                send(ev[1:])
            time.sleep(max(0, start + s["durationMs"] / 1000 - time.perf_counter()))
            rec.communicate(b"q", timeout=10)
            print(f"  saved {wav}", flush=True)
    finally:
        for ch in range(16):
            send([0xB0 | ch, 123, 0])
        send([0xB0, 122, 127])  # Local Control on: the keys play the piano again
        winmm.midiOutClose(h)


if __name__ == "__main__":
    main()
