# -*- coding: utf-8 -*-
"""
Диаризация + транскрипция.
GigaAM-скрипт (gigaam_transcribe.py) НЕ МЕНЯЕТСЯ — вызывается как есть.
diarize.py тоже НЕ МЕНЯЕТСЯ — вызывается как есть.

Логика:
  1) diarize.py  -> turns [{start, end, speaker}, ...]
  2) разрешаем перекрытия (каждый момент времени — ровно один спикер)
  3) режем аудио по turns (длинные реплики дробим по MAX_PART_SEC)
  4) по каждому куску — gigaam_transcribe.py
  5) склеиваем в segments / dialog

Usage:
    python diarize_transcribe.py <audio.wav> [--hf-token TOKEN]
                                 [--no-diarize] [--device cuda|cpu]
                                 [--diar-python PATH]

Output (stdout, последняя строка — JSON):
    {
      "text": "...",
      "dialog": "SPEAKER_00: ...\nSPEAKER_01: ...",
      "segments": [{start,end,startFormatted,endFormatted,speaker,text}, ...],
      "speakers": ["SPEAKER_00","SPEAKER_01"],
      "diarization": true,
      "diarizationSec": 9.0,
      "elapsedSec": 123.4
    }
"""
import os
os.environ["PATH"] = r"C:\ffmpeg\bin;" + os.environ.get("PATH", "")

import sys
import json
import time
import subprocess
import tempfile
import argparse
import warnings

warnings.filterwarnings("ignore")

HERE = os.path.dirname(os.path.abspath(__file__))
GIGAAM_SCRIPT = os.path.join(HERE, "gigaam_transcribe.py")
DIARIZE_SCRIPT = os.path.join(HERE, "diarize.py")

MAX_PART_SEC = 20.0     # длинные реплики дробим
MIN_PART_SEC = 0.3      # короче — пропускаем
MERGE_GAP_SEC = 0.4     # склейка соседних реплик одного спикера


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def format_time(sec):
    sec = int(sec)
    h, m, s = sec // 3600, (sec % 3600) // 60, sec % 60
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def run_json(cmd, cwd, env, timeout_sec=3600):
    """Запускает команду, возвращает JSON из последней непустой строки stdout."""
    log(f"$ {' '.join(cmd[:2])} ...")
    proc = subprocess.run(
        cmd, cwd=cwd, env=env,
        capture_output=True, text=True, encoding="utf-8",
        timeout=timeout_sec,
    )
    if proc.stderr:
        for line in proc.stderr.strip().splitlines()[-40:]:
            log(f"   {line}")
    if proc.returncode != 0:
        raise RuntimeError(
            f"exit {proc.returncode}\n"
            f"stdout tail:\n{proc.stdout[-800:]}\n"
            f"stderr tail:\n{proc.stderr[-800:]}"
        )
    lines = [l for l in proc.stdout.strip().splitlines() if l.strip()]
    if not lines:
        raise RuntimeError(f"empty stdout\nstderr:\n{proc.stderr[-800:]}")
    try:
        return json.loads(lines[-1])
    except json.JSONDecodeError as e:
        raise RuntimeError(
            f"bad JSON: {e}\nlast line:\n{lines[-1][:500]}\n"
            f"stderr tail:\n{proc.stderr[-800:]}"
        )


def cut_wav(src, dst, start, end):
    subprocess.run(
        ["ffmpeg", "-ss", f"{start:.3f}", "-to", f"{end:.3f}",
         "-i", src, "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
         "-y", dst],
        capture_output=True, check=True
    )


def resolve_overlaps(turns):
    """
    Делает turns непересекающимися: на каждом интервале выбирается ОДИН спикер
    (тот, чья реплика длиннее). На выходе — [{start, end, speaker}].
    """
    if not turns:
        return []

    events = []
    for i, t in enumerate(turns):
        events.append((t["start"], +1, i))
        events.append((t["end"], -1, i))
    events.sort(key=lambda x: (x[0], -x[1]))  # при равенстве — сначала +1

    active = set()
    result = []
    prev_t = None
    for t, delta, i in events:
        if prev_t is not None and t > prev_t and active:
            winner = max(active, key=lambda j: turns[j]["end"] - turns[j]["start"])
            result.append({
                "start": round(prev_t, 3),
                "end": round(t, 3),
                "speaker": turns[winner]["speaker"],
            })
        if delta > 0:
            active.add(i)
        else:
            active.discard(i)
        prev_t = t

    # склеить соседние с одинаковым speaker и малым зазором
    merged = []
    for r in result:
        if (merged and merged[-1]["speaker"] == r["speaker"]
                and r["start"] - merged[-1]["end"] <= MERGE_GAP_SEC):
            merged[-1]["end"] = r["end"]
        else:
            merged.append(dict(r))
    return merged


def split_long_parts(turns):
    """Дробит реплики длиннее MAX_PART_SEC, отбрасывает слишком короткие."""
    parts = []
    for t in turns:
        s, e = t["start"], t["end"]
        if e - s < MIN_PART_SEC:
            continue
        while e - s > MAX_PART_SEC:
            parts.append({"start": s, "end": s + MAX_PART_SEC, "speaker": t["speaker"]})
            s += MAX_PART_SEC
        parts.append({"start": s, "end": e, "speaker": t["speaker"]})
    return parts


def build_dialog(segments):
    """Плоский диалог: соседние реплики одного спикера склеиваются в строку."""
    lines = []
    for s in segments:
        if lines and lines[-1][0] == s["speaker"]:
            lines[-1][1].append(s["text"])
        else:
            lines.append([s["speaker"], [s["text"]]])
    return "\n".join(f"{spk}: {' '.join(parts)}" for spk, parts in lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--hf-token", default=os.environ.get("HF_TOKEN", ""))
    ap.add_argument("--no-diarize", action="store_true")
    ap.add_argument("--device", default=None)
    ap.add_argument("--diar-python", default=sys.executable,
                    help="Python для diarize.py (по умолчанию — тот же, что запускает этот скрипт)")
    args = ap.parse_args()

    # --- ВАЖНО: абсолютный путь, потому что subprocess'ы идут с cwd=HERE ---
    args.audio = os.path.abspath(args.audio)
    if not os.path.exists(args.audio):
        print(json.dumps({"error": f"File not found: {args.audio}"}))
        sys.exit(1)

    env = {
        **os.environ,
        "PYTHONIOENCODING": "utf-8",
        "PATH": r"C:\ffmpeg\bin;" + os.environ.get("PATH", ""),
    }
    if args.hf_token:
        env["HF_TOKEN"] = args.hf_token

    # --- без диаризации: просто проксируем в старый скрипт ---
    if args.no_diarize:
        log("⏭  --no-diarize: проксируем в gigaam_transcribe.py")
        result = run_json([sys.executable, GIGAAM_SCRIPT, args.audio], HERE, env)
        result["diarization"] = False
        print(json.dumps(result, ensure_ascii=False))
        return

    if not args.hf_token:
        print(json.dumps({"error": "HF_TOKEN не задан"}))
        sys.exit(1)

    t_start = time.time()

    # --- 1. Диаризация ---
    diar_cmd = [args.diar_python, DIARIZE_SCRIPT, args.audio,
                "--hf-token", args.hf_token]
    if args.device:
        diar_cmd += ["--device", args.device]
    diar = run_json(diar_cmd, HERE, env)

    if "error" in diar:
        print(json.dumps(diar, ensure_ascii=False))
        sys.exit(1)

    turns = diar["turns"]
    if not turns:
        print(json.dumps({
            "error": "Речь не обнаружена",
            "turns": [], "segments": [], "text": "", "diarization": True,
        }, ensure_ascii=False))
        return

    log(f"👥 Спикеров: {len(diar['speakers'])}, реплик: {len(turns)}")

    # --- 2. Перекрытия -> непересекающиеся интервалы ---
    turns_no_overlap = resolve_overlaps(turns)
    log(f"🧩 После разрешения перекрытий: {len(turns_no_overlap)} интервалов")

    # --- 3. Дробление длинных реплик ---
    parts = split_long_parts(turns_no_overlap)
    log(f"✂️  Кусков для GigaAM: {len(parts)}")

    # --- 4. Транскрипция ---
    segments = []
    all_text = []
    t0 = time.time()

    with tempfile.TemporaryDirectory() as tmpdir:
        for i, p in enumerate(parts):
            wav = os.path.join(tmpdir, f"p_{i:04d}.wav")
            try:
                cut_wav(args.audio, wav, p["start"], p["end"])
            except subprocess.CalledProcessError as e:
                log(f"   ❌ cut failed: {e}")
                continue

            log(f"🔄 [{i+1}/{len(parts)}] "
                f"{format_time(p['start'])} → {format_time(p['end'])} "
                f"{p['speaker']}")

            try:
                r = run_json([sys.executable, GIGAAM_SCRIPT, wav], HERE, env)
            except Exception as e:
                log(f"   ❌ {e}")
                continue

            text = (r.get("text") or "").strip()
            if not text:
                continue

            all_text.append(text)
            segments.append({
                "start": p["start"],
                "end": p["end"],
                "startFormatted": format_time(p["start"]),
                "endFormatted": format_time(p["end"]),
                "speaker": p["speaker"],
                "text": text,
            })
            log(f"   📝 {text[:80]}")

    elapsed = time.time() - t_start
    dialog = build_dialog(segments)

    print(json.dumps({
        "text": " ".join(all_text).strip(),
        "dialog": dialog,
        "segments": segments,
        "speakers": diar["speakers"],
        "diarization": True,
        "diarizationSec": diar.get("elapsedSec"),
        "elapsedSec": round(elapsed, 2),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()