


# 🎙️ GigaAM Server

Сервер распознавания **русской речи** на **GigaAM v3 (RNNT)** с ускорением на **GPU (CUDA)**,
диаризацией спикеров (**pyannote.audio 4.x**) и живым режимом **voice typing**.

> Автор: **Зядик Дмитрий Сергеевич** | [https://ziidik.ru/](https://ziidik.ru/)
<img width="1185" height="1132" alt="image" src="https://github.com/user-attachments/assets/2bcc5381-50d2-40aa-8814-e8e28beb7806" />


## ✨ Возможности

### Три режима распознавания

| Режим | Что делает | Endpoint |
|---|---|---|
| 🎯 **STT (файл)** | Транскрипция загруженного файла или записи с микрофона | `POST /api/transcribe` |
| 👥 **STT + диаризация** | Транскрипция с разбивкой по спикерам (pyannote 4.x) | `POST /api/transcribe-diarized` |
| 🎙 **Voice typing (live)** | Живое распознавание по VAD-паузам, чанки уходят на сервер по мере речи | `POST /api/stream/chunk` |

### Технические

- 🇷🇺 **Только русский** — оптимизирован под русскую речь
- 🎯 **96–98% точности** (Whisper small: 80–85%)
- ✅ **Пунктуация и заглавные буквы** — автоматически
- 🚫 **Нет галлюцинаций** — GigaAM не зацикливается на тишине
- ⏱ **Таймкоды** — каждый сегмент с временными метками
- 👥 **Диаризация** — разбивка диалога по спикерам (SPEAKER_00, SPEAKER_01, …)
- 🎙 **Voice typing** — живой STT с индикатором «ГОВОРИТ / тишина»
- 🚀 **GPU CUDA** — RTX 1660 Super и выше
- 🧠 **Долгоживущий worker** — модель GigaAM грузится один раз при старте сервера, а не на каждый запрос
- 🔒 **HTTPS** — self-signed или mkcert для доступа по локальной сети
- 🖥 **LAN-доступ** — работает с любой машины в сети, не только с localhost

---

## 🖥️ Требования

### Обязательно

- **Node.js** 14+
- **Python** 3.9–3.12
- **CUDA Toolkit** 12.x
- **FFmpeg** (в PATH, например `C:\ffmpeg\bin`)
- **NVIDIA GPU** 4+ GB VRAM (рекомендуется 6+; для диаризации + GigaAM одновременно — 8+)
- **RAM**: 8+ GB
- **Диск**: ~2 GB (GigaAM) + ~1.5 GB (pyannote + HF-кэш)

### Для диаризации

- **Python-пакеты**: `pyannote.audio>=4,<5`, `soundfile`, `torchaudio` (уже в venv)
- **HF-токен**: `HF_TOKEN` в env сервера
- **Принятые условия на HuggingFace** для трёх моделей:
  - [pyannote/speaker-diarization-3.1](https://huggingface.co/pyannote/speaker-diarization-3.1)
  - [pyannote/segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0)
  - [pyannote/speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1)

---

## 🚀 Установка

### 1. Клонирование и npm-зависимости

cd C:\Projects\js\giga-am-server
venv\Scripts\activate
$env:PATH = "C:\ffmpeg\bin;" + $env:PATH
python gigaam\gigaam_transcribe.py "путь\к\Планшету.wav"
