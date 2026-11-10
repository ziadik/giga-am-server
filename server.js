const express = require("express");
const multer = require("multer");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const WebSocket = require("ws");
const https = require("https");
const readline = require("readline");

const app = express();

// ============================================================
// HTTPS
// ============================================================
let httpsOptions;
try {
  httpsOptions = {
    key: fs.readFileSync(path.join(__dirname, "key.pem")),
    cert: fs.readFileSync(path.join(__dirname, "cert.pem")),
  };
  console.log("✅ SSL certificates loaded");
} catch (error) {
  console.error("❌ SSL certificates not found!");
  console.error(
    "   Please ensure key.pem and cert.pem exist in the project root",
  );
  process.exit(1);
}

const server = https.createServer(httpsOptions, app);
const wss = new WebSocket.Server({ server });

// ============================================================
// Middleware
// ============================================================
app.use(cors());
app.use(express.json({ limit: "500mb" }));
app.use(express.urlencoded({ extended: true, limit: "500mb" }));
app.use(express.static("public"));
app.use("/example", express.static("example"));

app.get("/favicon.ico", (req, res) => res.status(204).end());

// ============================================================
// Пути
// ============================================================
const GIGAAM_DIR = path.join(__dirname, "gigaam");
const UPLOADS_DIR = path.join(GIGAAM_DIR, "uploads");
const EXAMPLE_DIR = path.join(__dirname, "example");
const PYTHON_SCRIPT = path.join(GIGAAM_DIR, "gigaam_transcribe.py");
const WORKER_SCRIPT = path.join(GIGAAM_DIR, "gigaam_worker.py");

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  console.log(`📁 Created uploads directory: ${UPLOADS_DIR}`);
}

if (!fs.existsSync(EXAMPLE_DIR)) {
  fs.mkdirSync(EXAMPLE_DIR, { recursive: true });
  console.log(`📁 Created example directory: ${EXAMPLE_DIR}`);
}

// ============================================================
// Python executable
// ============================================================
const PYTHON_EXE =
  process.env.PYTHON_EXE ||
  (fs.existsSync(path.join(__dirname, "venv", "Scripts", "python.exe"))
    ? path.join(__dirname, "venv", "Scripts", "python.exe")
    : fs.existsSync(path.join(__dirname, "venv", "bin", "python"))
      ? path.join(__dirname, "venv", "bin", "python")
      : "python");

console.log(`🐍 Python executable: ${PYTHON_EXE}`);

// ============================================================
// Multer (загрузка файлов — как раньше)
// ============================================================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".webm";
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(7);
    cb(null, `${timestamp}-${random}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (
      file.mimetype.startsWith("audio/") ||
      file.mimetype === "video/webm" ||
      file.originalname.match(/\.(wav|mp3|m4a|webm|ogg|flac|aac)$/i)
    ) {
      cb(null, true);
    } else {
      cb(new Error("Only audio files are allowed"));
    }
  },
});

// Для чанков voice typing — в памяти, быстрее
const multerChunk = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// ============================================================
// WebSocket (статусы)
// ============================================================
const clients = new Set();

wss.on("connection", (ws) => {
  console.log("New WebSocket client connected");
  clients.add(ws);

  ws.on("close", () => {
    clients.delete(ws);
    console.log("Client disconnected");
  });

  ws.send(
    JSON.stringify({
      type: "connected",
      message: "Connected to GigaAM Server",
    }),
  );
});

function broadcastStatus(status, data = null) {
  const message = JSON.stringify({ type: "status", status, data });
  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// ============================================================
// GPU-мьютекс (для оффлайн-транскрипции)
// ============================================================
let gpuBusy = false;
const gpuQueue = [];

function acquireGPU() {
  return new Promise((resolve) => {
    if (!gpuBusy) {
      gpuBusy = true;
      resolve();
    } else {
      gpuQueue.push(resolve);
    }
  });
}

function releaseGPU() {
  const next = gpuQueue.shift();
  if (next) next();
  else gpuBusy = false;
}

// ============================================================
// GigaAM long-lived worker (для voice typing)
// ============================================================
let gigaWorker = null;
let gigaReady = false;
let gigaInfo = null; // {device, gpuName, model}
let reqCounter = 0;
const pending = new Map(); // id -> {resolve, reject, timer}

function startGigaWorker() {
  if (gigaWorker) return;
  if (!fs.existsSync(WORKER_SCRIPT)) {
    console.log(`❌ gigaam_worker.py NOT FOUND at ${WORKER_SCRIPT}`);
    return;
  }
  console.log(`🚀 Starting GigaAM worker...`);

  gigaWorker = spawn(PYTHON_EXE, [WORKER_SCRIPT], {
    cwd: GIGAAM_DIR,
    env: {
      ...process.env,
      PATH: `C:\\ffmpeg\\bin;${process.env.PATH || ""}`,
      CUDA_VISIBLE_DEVICES: "0",
      GIGAAM_MODEL: process.env.GIGAAM_MODEL || "v3_rnnt",
      PYTHONIOENCODING: "utf-8",
    },
  });

  gigaWorker.stdout.setEncoding("utf-8");
  gigaWorker.stderr.on("data", (d) => {
    const text = d.toString().trim();
    if (text) console.log("GIGA-W:", text);
  });

  const rl = readline.createInterface({ input: gigaWorker.stdout });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const obj = JSON.parse(line);
      if (obj.ready) {
        gigaReady = true;
        gigaInfo = {
          device: obj.device,
          gpuName: obj.gpuName,
          model: obj.model,
        };
        console.log(
          `✅ GigaAM worker ready: ${obj.device} (${obj.gpuName}), model=${obj.model}`,
        );
        broadcastStatus("worker_ready", gigaInfo);
        return;
      }
      const p = pending.get(obj.id);
      if (!p) return;
      pending.delete(obj.id);
      clearTimeout(p.timer);
      if (obj.error) p.reject(new Error(obj.error));
      else p.resolve(obj);
    } catch (e) {
      console.error("GigaAM worker parse error:", e.message);
    }
  });

  gigaWorker.on("exit", (code, signal) => {
    console.log(
      `GigaAM worker exited (code=${code}, signal=${signal}), restart in 2s`,
    );
    gigaReady = false;
    gigaWorker = null;
    gigaInfo = null;
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error("GigaAM worker died"));
    }
    pending.clear();
    setTimeout(startGigaWorker, 2000);
  });

  gigaWorker.on("error", (err) => {
    console.error("GigaAM worker spawn error:", err.message);
  });
}

function gigaTranscribe(wavPath) {
  return new Promise((resolve, reject) => {
    if (!gigaReady || !gigaWorker) {
      return reject(new Error("GigaAM worker не готов"));
    }
    const id = `req-${++reqCounter}`;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error("GigaAM timeout 60s"));
    }, 60000);
    pending.set(id, { resolve, reject, timer: timeout });
    gigaWorker.stdin.write(JSON.stringify({ id, wav_path: wavPath }) + "\n");
  });
}

// ============================================================
// Утилиты конвертации
// ============================================================
function isAlreadyValidWav(filePath) {
  return new Promise((resolve) => {
    const FFMPEG_PATH = "C:\\ffmpeg\\bin\\ffmpeg.exe";
    const FFPROBE_PATH = "C:\\ffmpeg\\bin\\ffprobe.exe";

    const ffprobe = spawn(FFPROBE_PATH, [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=codec_name,sample_rate,channels",
      "-of",
      "default=noprint_wrappers=1",
      filePath,
    ]);

    let stdout = "";
    ffprobe.stdout.on("data", (d) => (stdout += d.toString()));
    ffprobe.on("close", () => {
      const codec = (stdout.match(/codec_name=(\w+)/) || [])[1];
      const sampleRate = parseInt(
        (stdout.match(/sample_rate=(\d+)/) || [])[1] || "0",
      );
      const channels = parseInt(
        (stdout.match(/channels=(\d+)/) || [])[1] || "0",
      );
      resolve(codec === "pcm_s16le" && sampleRate === 16000 && channels === 1);
    });
    ffprobe.on("error", () => resolve(false));
  });
}

function convertToWav(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    console.log(
      `🔄 Converting: ${path.basename(inputPath)} -> WAV 16kHz/16bit/mono`,
    );

    const FFMPEG_PATH = "C:\\ffmpeg\\bin\\ffmpeg.exe";
    const ffmpeg = spawn(FFMPEG_PATH, [
      "-i",
      inputPath,
      "-acodec",
      "pcm_s16le",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-y",
      outputPath,
    ]);

    let stderr = "";
    ffmpeg.stderr.on("data", (d) => (stderr += d.toString()));

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        console.log("✅ Conversion successful");
        resolve();
      } else {
        console.error("❌ FFmpeg error:", stderr);
        reject(new Error(`FFmpeg failed: ${stderr.substring(0, 300)}`));
      }
    });
    ffmpeg.on("error", (err) =>
      reject(new Error(`FFmpeg not found: ${err.message}`)),
    );
  });
}

// ============================================================
// GigaAM оффлайн-транскрипция (через subprocess — как раньше)
// ============================================================
async function transcribeWithGigaAM(wavPath) {
  await acquireGPU();
  try {
    return await new Promise((resolve, reject) => {
      console.log(`\n🚀 GigaAM processing: ${path.basename(wavPath)}`);

      const proc = spawn(PYTHON_EXE, [PYTHON_SCRIPT, wavPath], {
        cwd: GIGAAM_DIR,
        env: {
          ...process.env,
          PATH: `C:\\ffmpeg\\bin;${process.env.PATH || ""}`,
          CUDA_VISIBLE_DEVICES: "0",
          GIGAAM_MODEL: "v3_rnnt",
          PYTHONIOENCODING: "utf-8",
        },
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (d) => (stdout += d.toString("utf-8")));
      proc.stderr.on("data", (d) => {
        const text = d.toString("utf-8").trim();
        stderr += text + "\n";
        console.log("GigaAM:", text);
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`GigaAM failed: ${stderr.substring(0, 500)}`));
          return;
        }
        try {
          const lines = stdout.trim().split("\n");
          const lastLine = lines[lines.length - 1];
          const result = JSON.parse(lastLine);
          if (result.error) {
            reject(new Error(result.error));
            return;
          }
          console.log(`📄 Result: "${result.text.substring(0, 100)}..."`);
          console.log(`   Device: ${result.device} (${result.gpuName})`);
          console.log(`   Segments: ${result.segments.length}`);
          console.log(`   Time: ${result.elapsedSec}s`);
          resolve(result);
        } catch (err) {
          reject(
            new Error(
              `Failed to parse GigaAM output: ${err.message}\nRaw: ${stdout.substring(0, 500)}`,
            ),
          );
        }
      });

      proc.on("error", (err) =>
        reject(new Error(`Failed to start Python: ${err.message}`)),
      );

      const TIMEOUT_MS = 30 * 60 * 1000;
      const timeout = setTimeout(() => {
        if (!proc.killed) {
          proc.kill();
          reject(new Error(`GigaAM timeout (${TIMEOUT_MS / 1000}s)`));
        }
      }, TIMEOUT_MS);

      proc.on("close", () => clearTimeout(timeout));
    });
  } finally {
    releaseGPU();
  }
}

// ============================================================
// Оффлайн-транскрипция файла
// ============================================================
async function transcribeAudio(audioFilename) {
  const originalPath = path.join(UPLOADS_DIR, audioFilename);
  const wavFilename = audioFilename.replace(/\.[^/.]+$/, ".wav");
  const wavPath = path.join(UPLOADS_DIR, wavFilename);

  try {
    if (!fs.existsSync(originalPath)) {
      throw new Error(`Audio file not found: ${originalPath}`);
    }
    const stats = fs.statSync(originalPath);
    if (stats.size < 1000) {
      throw new Error(`Audio file too small (${stats.size} bytes)`);
    }
    console.log(
      `\n📁 Original: ${audioFilename} (${(stats.size / 1024).toFixed(2)} KB)`,
    );

    const isValidWav = await isAlreadyValidWav(originalPath);
    if (isValidWav) {
      console.log(`✅ Already valid WAV — skipping conversion`);
      if (originalPath !== wavPath) {
        fs.renameSync(originalPath, wavPath);
      }
    } else {
      await convertToWav(originalPath, wavPath);
      try {
        fs.unlinkSync(originalPath);
      } catch (e) {}
    }

    const wavStats = fs.statSync(wavPath);
    console.log(
      `📁 WAV: ${wavFilename} (${(wavStats.size / 1024 / 1024).toFixed(2)} MB)`,
    );

    broadcastStatus("processing", {
      message: `GigaAM (GPU) обрабатывает аудио...`,
    });

    const result = await transcribeWithGigaAM(wavPath);

    try {
      fs.unlinkSync(wavPath);
      console.log(`🗑️ Deleted WAV: ${wavFilename}`);
    } catch (e) {}

    return {
      text: result.text,
      segments: result.segments || [],
      device: result.device,
      gpuName: result.gpuName,
      model: result.model,
      elapsedSec: result.elapsedSec,
    };
  } catch (error) {
    console.error("❌ Error:", error.message);
    try {
      if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
    } catch (e) {}
    try {
      if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath);
    } catch (e) {}
    throw error;
  }
}

// ============================================================
// API
// ============================================================
app.get("/api/status", (req, res) => {
  res.json({
    status: "running",
    backend: "GigaAM v2 RNNT (GPU)",
    model: "gigaam-v2-rnnt",
    language: "ru",
    scriptExists: fs.existsSync(PYTHON_SCRIPT),
    pythonExe: PYTHON_EXE,
    workerReady: gigaReady,
    workerInfo: gigaInfo,
  });
});

// НОВОЕ: статус worker для voice typing
app.get("/api/worker/status", (req, res) => {
  res.json({
    ready: gigaReady,
    info: gigaInfo,
  });
});

app.get("/api/test-files", (req, res) => {
  if (!fs.existsSync(EXAMPLE_DIR)) return res.json({ files: [] });
  try {
    const files = fs
      .readdirSync(EXAMPLE_DIR)
      .filter((f) => f.match(/\.(wav|mp3|m4a|webm|ogg)$/i))
      .map((f) => ({
        name: f,
        path: `/example/${f}`,
        size: fs.statSync(path.join(EXAMPLE_DIR, f)).size,
      }));
    res.json({ files });
  } catch (error) {
    res.status(500).json({ error: "Failed to list test files" });
  }
});

// Старый оффлайн-эндпоинт (файл / полная запись)
app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  let audioFilename = null;
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No audio file uploaded" });
    }
    audioFilename = req.file.filename;
    console.log(`\n📥 Received: ${audioFilename}`);
    console.log(`   Size: ${(req.file.size / 1024).toFixed(2)} KB`);
    console.log(`   MIME: ${req.file.mimetype}`);
    console.log(`   Original: ${req.file.originalname}`);

    const result = await transcribeAudio(audioFilename);

    res.json({
      success: true,
      text: result.text,
      segments: result.segments,
      language: "ru",
      model: result.model,
      device: result.device,
      gpuName: result.gpuName,
      elapsedSec: result.elapsedSec,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("❌ Transcription error:", error.message);
    if (audioFilename) {
      const fullPath = path.join(UPLOADS_DIR, audioFilename);
      try {
        if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
      } catch (e) {}
    }
    res.status(500).json({
      error: "Transcription failed",
      details: error.message,
    });
  }
});

// НОВОЕ: voice typing — приём чанка и быстрый инференс через worker
app.post("/api/stream/chunk", multerChunk.single("audio"), async (req, res) => {
  let tmp = null;
  try {
    if (!req.file) {
      return res.status(400).json({ error: "no audio" });
    }
    if (!gigaReady) {
      return res.status(503).json({ error: "GigaAM worker ещё загружается" });
    }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    tmp = path.join(UPLOADS_DIR, `chunk-${id}.wav`);
    fs.writeFileSync(tmp, req.file.buffer);

    const t0 = Date.now();
    const r = await gigaTranscribe(tmp);
    const totalMs = Date.now() - t0;

    try {
      fs.unlinkSync(tmp);
    } catch (e) {}
    tmp = null;

    res.json({
      text: r.text,
      elapsedSec: r.elapsedSec,
      totalMs,
      worker: gigaInfo,
    });
  } catch (e) {
    console.error("/api/stream/chunk:", e.message);
    if (tmp) {
      try {
        fs.unlinkSync(tmp);
      } catch (err) {}
    }
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// DIARIZED TRANSCRIPTION (diarize_transcribe.py)
// ============================================================
const DIARIZE_TRANSCRIBE_SCRIPT = path.join(GIGAAM_DIR, "diarize_transcribe.py");

async function transcribeWithDiarization(wavPath) {
  await acquireGPU();   // тот же мьютекс, что и для оффлайн STT
  try {
    return await new Promise((resolve, reject) => {
      if (!fs.existsSync(DIARIZE_TRANSCRIBE_SCRIPT)) {
        return reject(new Error(`diarize_transcribe.py NOT FOUND at ${DIARIZE_TRANSCRIBE_SCRIPT}`));
      }
      const hfToken = process.env.HF_TOKEN || "";
      if (!hfToken) {
        return reject(new Error("HF_TOKEN не задан в окружении сервера"));
      }

      console.log(`\n👥 GigaAM + Diarization: ${path.basename(wavPath)}`);

      const proc = spawn(
        PYTHON_EXE,
        [DIARIZE_TRANSCRIBE_SCRIPT, wavPath, "--hf-token", hfToken],
        {
          cwd: GIGAAM_DIR,
          env: {
            ...process.env,
            PATH: `C:\\ffmpeg\\bin;${process.env.PATH || ""}`,
            CUDA_VISIBLE_DEVICES: "0",
            GIGAAM_MODEL: process.env.GIGAAM_MODEL || "v3_rnnt",
            PYTHONIOENCODING: "utf-8",
            HF_TOKEN: hfToken,
          },
        },
      );

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (d) => (stdout += d.toString("utf-8")));
      proc.stderr.on("data", (d) => {
        const text = d.toString("utf-8").trim();
        stderr += text + "\n";
        console.log("DIAR:", text);
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          return reject(
            new Error(`Diarization failed: ${stderr.substring(0, 800)}`),
          );
        }
        try {
          const lines = stdout.trim().split("\n").filter((l) => l.trim());
          const result = JSON.parse(lines[lines.length - 1]);
          if (result.error) return reject(new Error(result.error));
          console.log(
            `📄 Diarized: ${result.speakers?.length || 0} speakers, ` +
              `${result.segments?.length || 0} segments, ${result.elapsedSec}s`,
          );
          resolve(result);
        } catch (err) {
          reject(
            new Error(
              `Failed to parse diarize output: ${err.message}\nRaw: ${stdout.substring(0, 500)}`,
            ),
          );
        }
      });

      proc.on("error", (err) =>
        reject(new Error(`Failed to start Python: ${err.message}`)),
      );

      const TIMEOUT_MS = 60 * 60 * 1000; // 60 минут на диаризацию + STT
      const timeout = setTimeout(() => {
        if (!proc.killed) {
          proc.kill();
          reject(new Error(`Diarization timeout (${TIMEOUT_MS / 1000}s)`));
        }
      }, TIMEOUT_MS);
      proc.on("close", () => clearTimeout(timeout));
    });
  } finally {
    releaseGPU();
  }
}

async function transcribeAudioDiarized(audioFilename) {
  const originalPath = path.join(UPLOADS_DIR, audioFilename);
  const wavFilename = audioFilename.replace(/\.[^/.]+$/, ".wav");
  const wavPath = path.join(UPLOADS_DIR, wavFilename);

  try {
    if (!fs.existsSync(originalPath)) {
      throw new Error(`Audio file not found: ${originalPath}`);
    }
    const isValidWav = await isAlreadyValidWav(originalPath);
    if (isValidWav) {
      if (originalPath !== wavPath) fs.renameSync(originalPath, wavPath);
    } else {
      await convertToWav(originalPath, wavPath);
      try { fs.unlinkSync(originalPath); } catch (e) {}
    }

    broadcastStatus("processing", {
      message: "Диаризация + GigaAM (GPU)...",
    });

    const result = await transcribeWithDiarization(wavPath);

    try { fs.unlinkSync(wavPath); } catch (e) {}
    return result;
  } catch (error) {
    try { if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath); } catch (e) {}
    try { if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath); } catch (e) {}
    throw error;
  }
}

app.post("/api/transcribe-diarized", upload.single("audio"), async (req, res) => {
  let audioFilename = null;
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No audio file uploaded" });
    }
    audioFilename = req.file.filename;
    console.log(`\n📥 [diarized] Received: ${audioFilename}`);

    const result = await transcribeAudioDiarized(audioFilename);

    res.json({
      success: true,
      text: result.text,
      dialog: result.dialog,
      segments: result.segments,
      speakers: result.speakers,
      diarization: true,
      language: "ru",
      elapsedSec: result.elapsedSec,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("❌ Diarized transcription error:", error.message);
    if (audioFilename) {
      const fullPath = path.join(UPLOADS_DIR, audioFilename);
      try { if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath); } catch (e) {}
    }
    res.status(500).json({
      error: "Diarized transcription failed",
      details: error.message,
    });
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ============================================================
// Запуск
// ============================================================
const PORT = process.env.PORT || 9008;

server.listen(PORT, "172.17.10.4", () => {
  console.log("\n" + "=".repeat(60));
  console.log("🎙️  GIGAAM SERVER STARTED (HTTPS)");
  console.log("=".repeat(60));
  console.log(`\n👤 Author: Зядик Дмитрий Сергеевич`);
  console.log(`🌐 Website: https://ziidik.ru/`);
  console.log(`\n🌐 HTTPS: https://localhost:${PORT}`);
  console.log(`\n🤖 Backend: GigaAM v2 RNNT (GPU)`);
  console.log(`   Language: 🇷🇺 Russian only`);
  console.log(`   Quality: 96-98% (no hallucinations, with punctuation)`);
  console.log(`   Model: ${process.env.GIGAAM_MODEL || "gigaam-v2-rnnt"}`);
  console.log(`   Python: ${PYTHON_EXE}`);
  console.log(`\n📁 Directories:`);
  console.log(`   GigaAM dir: ${GIGAAM_DIR}`);
  console.log(`   Uploads dir: ${UPLOADS_DIR}`);
  console.log(`   Example dir: ${EXAMPLE_DIR}`);
  console.log(`\n💡 Ready for transcription!`);
  console.log(`\n⚠️  Note: Using self-signed certificate`);
  console.log(`   In browser, click "Advanced" -> "Proceed to site"`);
  console.log("\n" + "=".repeat(60) + "\n");

  if (!fs.existsSync(PYTHON_SCRIPT)) {
    console.log(`❌ gigaam_transcribe.py NOT FOUND at ${PYTHON_SCRIPT}`);
  } else {
    console.log(`✓ gigaam_transcribe.py found`);
  }

  // Проверка PyTorch CUDA
  const checkTorch = spawn(
    PYTHON_EXE,
    [
      "-c",
      "import torch; print('CUDA:' + str(torch.cuda.is_available())); print('GPU:' + (torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'None'))",
    ],
    { cwd: GIGAAM_DIR, env: { ...process.env, PYTHONIOENCODING: "utf-8" } },
  );

  let torchOut = "";
  checkTorch.stdout.on("data", (d) => (torchOut += d.toString()));
  checkTorch.stderr.on("data", () => {});
  checkTorch.on("close", () => {
    console.log(`\n🐍 PyTorch status:`);
    console.log(torchOut.trim() || "   (unknown)");
    console.log("");
  });

  // НОВОЕ: запуск GigaAM worker для voice typing
  startGigaWorker();
});
