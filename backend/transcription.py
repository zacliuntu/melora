import hashlib
import logging
import os
import subprocess
from pathlib import Path
from uuid import uuid4

import numpy as np
import soundfile as sf

from . import store

log = logging.getLogger(__name__)
_model = None


def transcribe(pid):
    """Run on one CPU worker; never start an arrangement model or use a GPU."""
    global _model
    folder = store.DATA / pid
    try:
        with store.transaction() as db:
            p = store.get(db, pid)
            p.update(status="transcribing", error=None)
            store.put(db, p)
        result = subprocess.run([
            "ffmpeg", "-v", "error", "-nostdin", "-y", "-protocol_whitelist", "file,pipe", "-i", str(folder / "original"),
            "-t", "301", "-vn", "-ac", "1", "-ar", "22050", "-c:a", "pcm_s16le",
            str(folder / "audio.wav"),
        ], capture_output=True, timeout=120)
        if result.returncode:
            raise ValueError("音频解码失败，请上传有效的 WAV / MP3 / M4A / FLAC / OGG / WEBM 文件")
        audio, sr = sf.read(folder / "audio.wav", dtype="float32")
        duration = len(audio) / sr
        if not 0.1 <= duration <= 300:
            raise ValueError("MVP 支持 0.1 秒至 5 分钟的哼唱，请先裁剪音频")
        chunks = np.array_split(audio, min(2400, len(audio)))
        waveform = [[round(float(c.min()), 4), round(float(c.max()), 4)] for c in chunks]
        # Lazy import keeps the API responsive while the model warms up. Basic Pitch
        # ships its model weights with the Python package; no remote inference occurs.
        os.environ.setdefault("CUDA_VISIBLE_DEVICES", "-1")
        from basic_pitch import ICASSP_2022_MODEL_PATH
        from basic_pitch.inference import Model, predict
        if _model is None:
            _model = Model(ICASSP_2022_MODEL_PATH)
        _, midi, events = predict(str(folder / "audio.wav"), _model,
                                  minimum_note_length=80, minimum_frequency=65,
                                  maximum_frequency=1500, multiple_pitch_bends=False)
        notes = []
        for start, end, pitch, amplitude, *_ in events:
            start, end = max(0, float(start)), min(duration, float(end))
            if end - start >= 0.025:
                notes.append(dict(id=uuid4().hex, start=round(start, 6), end=round(end, 6),
                                  pitch=int(pitch), velocity=max(1, min(127, round(float(amplitude) * 127)))))
        notes.sort(key=lambda n: (n["start"], n["pitch"]))
        midi.write(str(folder / "transcription.mid"))
        with store.transaction() as db:
            p = store.get(db, pid)
            p.update(status="ready", duration=duration, waveform=waveform, notes=notes,
                     transcription_engine="Spotify Basic Pitch 0.4.0", error=None)
            store.snapshot(db, p, "Basic Pitch 初始识别")
    except Exception as exc:
        log.exception("Transcription failed for %s", pid)
        with store.transaction() as db:
            p = store.get(db, pid)
            p.update(status="failed", error=str(exc)[:700])
            store.put(db, p)


def sha256(data: bytes):
    return hashlib.sha256(data).hexdigest()
