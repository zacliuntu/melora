"""Generate an original deterministic test phrase, never a user's confirmed work."""
import math
import struct
import wave
from pathlib import Path


def create(path):
    sr, duration = 22050, 4.0
    phrase = [(0.25, 0.85, 60), (1.05, 1.65, 64), (1.85, 2.45, 67), (2.65, 3.35, 69)]
    samples = []
    for i in range(int(sr * duration)):
        t = i / sr
        value = 0
        for start, end, pitch in phrase:
            if start <= t < end:
                envelope = min(1, (t - start) / .03, (end - t) / .05)
                f = 440 * 2 ** ((pitch - 69) / 12)
                value = envelope * (0.4 * math.sin(2 * math.pi * f * t) + 0.1 * math.sin(4 * math.pi * f * t))
        samples.append(struct.pack('<h', round(value * 32767)))
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), 'wb') as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sr)
        output.writeframes(b''.join(samples))


if __name__ == '__main__':
    import sys
    create(sys.argv[1] if len(sys.argv) > 1 else '/tmp/melody-test-phrase.wav')
