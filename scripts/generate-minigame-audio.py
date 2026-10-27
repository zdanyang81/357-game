#!/usr/bin/env python3
"""Generate an original deterministic tap sound. No external audio samples."""
import math
import pathlib
import struct
import wave

output = pathlib.Path(__file__).resolve().parents[1] / 'minigame/assets/tap.wav'
output.parent.mkdir(parents=True, exist_ok=True)
rate, duration = 22050, 0.09
frames = bytearray()
for i in range(int(rate * duration)):
    t = i / rate
    envelope = math.exp(-t * 70) * min(1, t * 2000)
    signal = envelope * (0.65 * math.sin(2 * math.pi * 620 * t) + 0.35 * math.sin(2 * math.pi * 1830 * t))
    frames.extend(struct.pack('<h', int(signal * 20000)))
with wave.open(str(output), 'wb') as wav:
    wav.setnchannels(1)
    wav.setsampwidth(2)
    wav.setframerate(rate)
    wav.writeframes(frames)
print(output)
