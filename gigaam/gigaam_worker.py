# -*- coding: utf-8 -*-
"""
Долгоживущий GigaAM-worker.
Читает NDJSON-запросы из stdin, пишет NDJSON-ответы в stdout.
Модель грузится ОДИН раз при старте.

Запрос:  {"id": "req-1", "wav_path": "C:\\...\\chunk.wav"}
Ответ:   {"id": "req-1", "text": "...", "elapsedSec": 0.42}
Ошибка:  {"id": "req-1", "error": "..."}
"""
import os
os.environ["PATH"] = r"C:\ffmpeg\bin;" + os.environ.get("PATH", "")

import sys
import json
import time
import subprocess
import warnings

warnings.filterwarnings("ignore")

LONGFORM_THRESHOLD_SEC = 30.0   # длиннее — transcribe_longform


def log(m):
    print(m, file=sys.stderr, flush=True)


def get_duration(path):
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, text=True, timeout=10,
        )
        return float(r.stdout.strip() or "0")
    except Exception:
        return 0.0


def extract_text(result):
    """Достаёт текст из результата transcribe/transcribe_longform."""
    if result is None:
        return ""
    # обычный результат — объект с .text
    if hasattr(result, "text"):
        return (result.text or "").strip()
    # longform — список сегментов
    if isinstance(result, (list, tuple)):
        parts = []
        for seg in result:
            if hasattr(seg, "text"):
                parts.append((seg.text or "").strip())
            elif isinstance(seg, str):
                parts.append(seg.strip())
            elif isinstance(seg, dict) and "text" in seg:
                parts.append(str(seg["text"]).strip())
        return " ".join(p for p in parts if p).strip()
    # dict с полем text
    if isinstance(result, dict) and "text" in result:
        return str(result["text"]).strip()
    return str(result).strip()


def main():
    import torch
    import gigaam

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model_name = os.environ.get("GIGAAM_MODEL", "v3_rnnt")
    log(f"🧠 Loading {model_name} on {device}...")
    t0 = time.time()
    model = gigaam.load_model(model_name).to(device)
    model.eval()
    gpu = torch.cuda.get_device_name(0) if device == "cuda" else "CPU"
    log(f"✅ Model ready in {time.time() - t0:.1f}s")

    print(json.dumps({
        "ready": True,
        "device": device,
        "gpuName": gpu,
        "model": model_name,
    }), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        req = {}
        try:
            req = json.loads(line)
            rid = req.get("id")
            wav = req["wav_path"]
            if not os.path.exists(wav):
                raise FileNotFoundError(wav)

            duration = get_duration(wav)
            t = time.time()

            with torch.no_grad():
                if duration > LONGFORM_THRESHOLD_SEC:
                    log(f"   ⏳ longform ({duration:.1f}s): {os.path.basename(wav)}")
                    if not hasattr(model, "transcribe_longform"):
                        raise RuntimeError(
                            f"Файл {duration:.1f}s > {LONGFORM_THRESHOLD_SEC}s, "
                            f"но у модели нет transcribe_longform. "
                            f"Режьте на чанки < {LONGFORM_THRESHOLD_SEC}s."
                        )
                    r = model.transcribe_longform(wav)
                else:
                    r = model.transcribe(wav)

            text = extract_text(r)
            elapsed = round(time.time() - t, 3)

            print(json.dumps({
                "id": rid,
                "text": text,
                "duration": round(duration, 3),
                "elapsedSec": elapsed,
            }, ensure_ascii=False), flush=True)

        except Exception as e:
            print(json.dumps({
                "id": req.get("id"),
                "error": f"{type(e).__name__}: {e}",
            }, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()