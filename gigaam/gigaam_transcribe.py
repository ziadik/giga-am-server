import os
os.environ["PATH"] = r"C:\ffmpeg\bin;" + os.environ.get("PATH", "")

import sys
import json
import time
import subprocess
import tempfile
import glob
import torch
import gigaam
import warnings

warnings.filterwarnings("ignore")

SEGMENT_SEC = 15  # ✅ РАБОТАЕТ

def format_time(sec):
    sec = int(sec)
    h, m, s = sec // 3600, (sec % 3600) // 60, sec % 60
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"

def get_duration(path):
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, text=True
        )
        return float(r.stdout.strip())
    except:
        return 0

def normalize_audio(input_path, output_path):
    subprocess.run([
        "ffmpeg", "-i", input_path,
        "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
        "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
        "-y", output_path
    ], capture_output=True)

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: gigaam_transcribe.py <audio.wav>"}))
        sys.exit(1)

    audio_path = sys.argv[1]
    if not os.path.exists(audio_path):
        print(json.dumps({"error": f"File not found: {audio_path}"}))
        sys.exit(1)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    gpu = torch.cuda.get_device_name(0) if device == "cuda" else "CPU"
    print(f"🔧 Device: {device} ({gpu})", file=sys.stderr)

    model_name = os.environ.get("GIGAAM_MODEL", "v3_rnnt")
    print(f"🧠 Loading model: {model_name}...", file=sys.stderr)

    t0 = time.time()
    model = gigaam.load_model(model_name)
    model = model.to(device)
    model.eval()
    print(f"✅ Model loaded in {time.time() - t0:.1f}s", file=sys.stderr)

    duration = get_duration(audio_path)
    print(f"📏 Duration: {format_time(duration)}", file=sys.stderr)

    # Короткий
    if duration <= SEGMENT_SEC:
        print(f"🎙️ Transcribing...", file=sys.stderr)
        t0 = time.time()
        with torch.no_grad():
            result = model.transcribe(audio_path)
        elapsed = time.time() - t0
        text = result.text.strip() if hasattr(result, "text") else str(result).strip()
        print(f"   📝 {text[:80]}", file=sys.stderr)
        print(json.dumps({
            "text": text, "segments": [], "device": device,
            "gpuName": gpu, "model": model_name, "elapsedSec": round(elapsed, 2),
        }, ensure_ascii=False))
        return

    # Длинный — нарезаем
    print(f"✂️  Splitting into {SEGMENT_SEC}s segments...", file=sys.stderr)

    with tempfile.TemporaryDirectory() as tmpdir:
        pattern = os.path.join(tmpdir, "part_%03d.wav")
        subprocess.run(
            ["ffmpeg", "-i", audio_path, "-f", "segment",
             "-segment_time", str(SEGMENT_SEC),
             "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
             "-y", pattern],
            capture_output=True, check=True
        )

        parts = sorted(glob.glob(os.path.join(tmpdir, "part_*.wav")))
        print(f"✅ Split into {len(parts)} parts", file=sys.stderr)

        all_text = []
        segments = []
        offset = 0.0
        t0 = time.time()

        for i, part in enumerate(parts):
            part_dur = get_duration(part)
            print(f"🔄 [{i+1}/{len(parts)}] {format_time(offset)}", file=sys.stderr)

            try:
                with torch.no_grad():
                    result = model.transcribe(part)
                text = result.text.strip() if hasattr(result, "text") else str(result).strip()

                if text:
                    all_text.append(text)
                    segments.append({
                        "start": offset, "end": offset + part_dur,
                        "startFormatted": format_time(offset),
                        "endFormatted": format_time(offset + part_dur),
                        "text": text,
                    })
                    print(f"   📝 {text[:80]}", file=sys.stderr)
                else:
                    print(f"   ⚠️ Empty", file=sys.stderr)
            except Exception as e:
                print(f"   ❌ {e}", file=sys.stderr)

            offset += part_dur

        elapsed = time.time() - t0
        print(f"✅ Transcribed in {elapsed:.1f}s", file=sys.stderr)

        print(json.dumps({
            "text": " ".join(all_text).strip(),
            "segments": segments, "device": device,
            "gpuName": gpu, "model": model_name, "elapsedSec": round(elapsed, 2),
        }, ensure_ascii=False))

if __name__ == "__main__":
    main()