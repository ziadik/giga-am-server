# -*- coding: utf-8 -*-
"""
Диаризация на pyannote.audio 4.x (совместимо с torch 2.9 / Python 3.12 / Windows).
Аудио грузится через soundfile — torchcodec не используется.
GigaAM не затрагивает.

Usage:
    python diarize.py <audio.wav> [--hf-token TOKEN] [--device cuda|cpu]

Output (stdout, последняя строка — JSON):
    {"turns": [{"start": 0.0, "end": 4.2, "speaker": "SPEAKER_00"}, ...],
     "speakers": ["SPEAKER_00", "SPEAKER_01"],
     "device": "cuda", "elapsedSec": 12.3}
"""
import os
os.environ["PATH"] = r"C:\ffmpeg\bin;" + os.environ.get("PATH", "")

import sys
import json
import time
import argparse
import warnings

warnings.filterwarnings("ignore")


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def annotation_from_output(out):
    """
    pyannote 4.x возвращает DiarizeOutput — внутри есть .speaker_diarization (Annotation).
    pyannote 3.x возвращает Annotation сразу.
    Возвращаем объект, у которого точно есть .itertracks(yield_label=True).
    """
    # 4.x
    if hasattr(out, "speaker_diarization"):
        return out.speaker_diarization
    # 3.x
    if hasattr(out, "itertracks"):
        return out
    # 4.x: exclusive-вариант, если вдруг основной пуст
    if hasattr(out, "exclusive_speaker_diarization"):
        return out.exclusive_speaker_diarization
    raise TypeError(
        f"Неизвестный тип результата diarization: {type(out)}; "
        f"dir={[a for a in dir(out) if not a.startswith('_')]}"
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--hf-token", default=os.environ.get("HF_TOKEN", ""))
    ap.add_argument("--device", default=None)
    ap.add_argument("--min-on", type=float, default=0.3)
    ap.add_argument("--min-off", type=float, default=0.3)
    args = ap.parse_args()

    if not os.path.exists(args.audio):
        print(json.dumps({"error": f"File not found: {args.audio}"}))
        sys.exit(1)

    if not args.hf_token:
        print(json.dumps({
            "error": "HF_TOKEN не задан. Примите условия модели на HF "
                     "и передайте --hf-token или env HF_TOKEN"
        }))
        sys.exit(1)

    import torch
    from pyannote.audio import Pipeline

    device = args.device or ("cuda" if torch.cuda.is_available() else "cpu")
    log(f"🔧 Diarization device: {device}")

    t0 = time.time()
    log("🧑‍🤝‍🧑 Loading pyannote pipeline...")

    # 4.x: token=..., 3.x: use_auth_token=...
    pipe = None
    last_err = None
    for kwargs in ({"token": args.hf_token}, {"use_auth_token": args.hf_token}):
        try:
            pipe = Pipeline.from_pretrained(
                "pyannote/speaker-diarization-3.1",
                **kwargs,
            )
            log(f"✅ Pipeline loaded ({list(kwargs)[0]}=...)")
            break
        except TypeError as e:
            last_err = e
            log(f"   retry with other auth kwarg: {e}")
            continue
    if pipe is None:
        raise RuntimeError(f"Не удалось загрузить пайплайн: {last_err}")

    pipe = pipe.to(torch.device(device))

    # В 4.x параметры min_duration_on/off переехали — не критично, работаем на дефолтах
    try:
        pipe.instantiate({
            "segmentation": {
                "min_duration_off": args.min_off,
                "min_duration_on": args.min_on,
            }
        })
        log("✅ Applied min_duration_on/off")
    except Exception as e:
        log(f"⚠️  instantiate() пропущен ({type(e).__name__}): {e}")

    log(f"✅ Pipeline ready in {time.time() - t0:.1f}s")

    # --- Загрузка аудио в память (через soundfile, в обход torchcodec) ---
    t1 = time.time()
    log(f"🎧 Loading audio: {os.path.basename(args.audio)}")
    import soundfile as sf
    import numpy as np

    data, sample_rate = sf.read(args.audio, dtype="float32", always_2d=True)
    # data: (N, channels) -> waveform: (channels, N)
    waveform = torch.from_numpy(np.ascontiguousarray(data.T))
    if waveform.shape[0] > 1:
        waveform = waveform.mean(dim=0, keepdim=True)  # моно

    audio_in_memory = {
        "waveform": waveform,        # (1, N)
        "sample_rate": sample_rate,
    }
    log(f"   loaded: {waveform.shape[1]} samples @ {sample_rate} Hz "
        f"({waveform.shape[1] / sample_rate:.1f}s)")

    log("👥 Diarizing...")
    out = pipe(audio_in_memory)

    # 4.x -> DiarizeOutput; 3.x -> Annotation
    ann = annotation_from_output(out)

    turns = []
    for seg, _, spk in ann.itertracks(yield_label=True):
        turns.append({
            "start": round(float(seg.start), 3),
            "end": round(float(seg.end), 3),
            "speaker": str(spk),
        })
    turns.sort(key=lambda x: x["start"])

    speakers = sorted({t["speaker"] for t in turns})
    elapsed = time.time() - t1
    log(f"✅ {len(turns)} turns, {len(speakers)} speakers in {elapsed:.1f}s")

    print(json.dumps({
        "turns": turns,
        "speakers": speakers,
        "device": device,
        "elapsedSec": round(elapsed, 2),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()