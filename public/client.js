class GigaAMClient {
  constructor() {
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.isRecording = false;
    this.audioContext = null;
    this.analyser = null;
    this.animationFrame = null;
    this.startTime = null;
    this.ws = null;
    this.stream = null;
    this.recordingTimer = null;

    this.lastResult = { text: "", segments: [] };
    this.viewMode = "with-time";

    this.init();
  }

  async init() {
    this.bindEvents();
    this.initViewMode();
    await this.checkServerStatus();
    this.initWebSocket();
    this.checkMicrophoneSupport();
    await this.loadTestFiles();
  }

  // ============================================================
  // Режим просмотра
  // ============================================================
  initViewMode() {
    const radios = document.querySelectorAll('input[name="resultView"]');
    const saved = localStorage.getItem("gigaam_viewMode") || "with-time";
    this.viewMode = saved;

    radios.forEach((radio) => {
      if (radio.value === saved) radio.checked = true;
      radio.addEventListener("change", (e) => {
        this.viewMode = e.target.value;
        localStorage.setItem("gigaam_viewMode", this.viewMode);
        this.renderResult();
      });
    });
  }

  // ============================================================
  // События
  // ============================================================
  bindEvents() {
    const recordBtn = document.getElementById("recordBtn");
    const stopBtn = document.getElementById("stopBtn");
    if (recordBtn)
      recordBtn.addEventListener("click", () => this.startRecording());
    if (stopBtn) stopBtn.addEventListener("click", () => this.stopRecording());

    const fileInput = document.getElementById("fileInput");
    const uploadBtn = document.getElementById("uploadBtn");
    if (fileInput)
      fileInput.addEventListener("change", (e) => this.handleFileSelect(e));
    if (uploadBtn) uploadBtn.addEventListener("click", () => this.uploadFile());

    const copyBtn = document.getElementById("copyBtn");
    if (copyBtn) copyBtn.addEventListener("click", () => this.copyResult());
  }

  // ============================================================
  // Проверки
  // ============================================================
  checkMicrophoneSupport() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this.addStatusMessage("❌ Браузер не поддерживает микрофон", "error");
      const recordBtn = document.getElementById("recordBtn");
      if (recordBtn) recordBtn.disabled = true;
      return false;
    }

    const isSecure =
      location.protocol === "https:" ||
      location.hostname === "localhost" ||
      location.hostname === "127.0.0.1";
    if (!isSecure) {
      this.addStatusMessage(
        "⚠️ Для микрофона нужен HTTPS или localhost",
        "error",
      );
      const recordBtn = document.getElementById("recordBtn");
      if (recordBtn) recordBtn.disabled = true;
      return false;
    }

    return true;
  }

  async checkServerStatus() {
    try {
      const response = await fetch("/api/status");
      const data = await response.json();

      const statusText = document.getElementById("statusText");
      const indicator = document.querySelector(".status-indicator");

      if (data.scriptExists) {
        if (statusText) statusText.textContent = `✅ ${data.backend}`;
        if (indicator) indicator.style.background = "#4ade80";
        this.addStatusMessage(`Бэкенд: ${data.backend}`, "success");
        this.addStatusMessage(`Модель: ${data.model}`, "info");
      } else {
        if (statusText) statusText.textContent = "⚠️ Скрипт не найден";
        if (indicator) indicator.style.background = "#f59e0b";
        this.addStatusMessage("gigaam_transcribe.py не найден", "error");
      }

      return data;
    } catch (error) {
      console.error("Status check error:", error);
      const statusText = document.getElementById("statusText");
      const indicator = document.querySelector(".status-indicator");
      if (statusText) statusText.textContent = "❌ Сервер недоступен";
      if (indicator) indicator.style.background = "#ef4444";
      this.addStatusMessage("Сервер недоступен", "error");
      return null;
    }
  }

  initWebSocket() {
    try {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      this.ws = new WebSocket(`${protocol}//${window.location.host}`);

      this.ws.onopen = () => {
        this.addStatusMessage("WebSocket соединение установлено", "success");
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "connected") {
            this.addStatusMessage(data.message, "success");
          } else if (data.type === "status") {
            this.addStatusMessage(data.data?.message || data.status, "info");
            if (data.status === "processing") this.showProgress();
          }
        } catch (err) {
          console.error("WS parse error:", err);
        }
      };

      this.ws.onerror = (err) => {
        console.error("WS error:", err);
      };

      this.ws.onclose = () => {
        setTimeout(() => {
          if (this.ws && this.ws.readyState === WebSocket.CLOSED) {
            this.initWebSocket();
          }
        }, 5000);
      };
    } catch (err) {
      console.error("WS init error:", err);
    }
  }

  // ============================================================
  // Микрофон
  // ============================================================
  async startRecording() {
    if (!this.checkMicrophoneSupport()) return;

    try {
      this.addStatusMessage("Запрос доступа к микрофону...", "info");

      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          sampleSize: 16,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      this.audioChunks = [];
      const mimeType = MediaRecorder.isTypeSupported("audio/wav")
        ? "audio/wav"
        : "audio/webm";
      this.mediaRecorder = new MediaRecorder(this.stream, { mimeType });

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.audioChunks.push(e.data);
      };

      this.mediaRecorder.onstop = async () => {
        const blob = new Blob(this.audioChunks, {
          type: this.mediaRecorder.mimeType,
        });
        await this.transcribeBlob(blob, "recording.wav");

        if (this.stream) {
          this.stream.getTracks().forEach((t) => t.stop());
          this.stream = null;
        }
      };

      this.mediaRecorder.start(1000);
      this.isRecording = true;
      this.startTime = Date.now();

      document.getElementById("recordBtn").disabled = true;
      document.getElementById("stopBtn").disabled = false;

      this.startVisualization(this.stream);
      this.updateRecordingTime();

      this.addStatusMessage("🎤 Запись началась...", "success");
    } catch (error) {
      console.error("Recording error:", error);
      this.addStatusMessage(`Ошибка: ${error.message}`, "error");
      document.getElementById("recordBtn").disabled = false;
    }
  }

  stopRecording() {
    if (this.mediaRecorder && this.isRecording) {
      this.mediaRecorder.stop();
      this.isRecording = false;
      document.getElementById("recordBtn").disabled = false;
      document.getElementById("stopBtn").disabled = true;
      this.stopVisualization();
      this.addStatusMessage("Запись остановлена, отправляю...", "info");
    }
  }

  startVisualization(stream) {
    try {
      this.audioContext = new (
        window.AudioContext || window.webkitAudioContext
      )();
      this.analyser = this.audioContext.createAnalyser();
      const source = this.audioContext.createMediaStreamSource(stream);
      source.connect(this.analyser);
      this.analyser.fftSize = 256;

      const canvas = document.getElementById("visualizer");
      if (!canvas) return;

      const ctx = canvas.getContext("2d");
      const bufferLength = this.analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      const draw = () => {
        if (!this.isRecording || !this.analyser) return;
        this.animationFrame = requestAnimationFrame(draw);
        this.analyser.getByteFrequencyData(dataArray);

        canvas.width = canvas.clientWidth;
        canvas.height = canvas.clientHeight;

        if (canvas.width === 0) return;

        const barWidth = (canvas.width / bufferLength) * 2.5;
        let x = 0;
        ctx.fillStyle = "#1f2937";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        for (let i = 0; i < bufferLength; i++) {
          const barHeight = (dataArray[i] / 255) * canvas.height;
          const gradient = ctx.createLinearGradient(
            0,
            canvas.height,
            0,
            canvas.height - barHeight,
          );
          gradient.addColorStop(0, "#667eea");
          gradient.addColorStop(1, "#764ba2");
          ctx.fillStyle = gradient;
          ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);
          x += barWidth + 1;
        }
      };

      draw();
      this.audioContext.resume();
    } catch (err) {
      console.error("Visualization error:", err);
    }
  }

  stopVisualization() {
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    this.analyser = null;
  }

  updateRecordingTime() {
    if (!this.isRecording) return;
    const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    const timeEl = document.getElementById("recordingTime");
    if (timeEl) {
      timeEl.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }
    this.recordingTimer = setTimeout(() => this.updateRecordingTime(), 1000);
  }

  // ============================================================
  // Загрузка файла
  // ============================================================
  handleFileSelect(event) {
    const file = event.target.files[0];
    const uploadBtn = document.getElementById("uploadBtn");
    const fileInfo = document.getElementById("fileInfo");

    if (!file) {
      if (uploadBtn) uploadBtn.disabled = true;
      if (fileInfo) fileInfo.innerHTML = "";
      return;
    }

    const sizeMB = (file.size / 1024 / 1024).toFixed(2);
    const MAX_SIZE = 500 * 1024 * 1024;

    let warning = "";
    if (file.size > MAX_SIZE) {
      warning = `<br><span style="color: #ef4444;">⚠️ Максимум 500 MB</span>`;
      if (uploadBtn) uploadBtn.disabled = true;
    } else {
      if (uploadBtn) uploadBtn.disabled = false;
    }

    if (fileInfo) {
      fileInfo.innerHTML = `
        📁 ${file.name}<br>
        📦 ${sizeMB} MB<br>
        🎵 ${file.type || "audio/*"}
        ${warning}
      `;
    }
  }

  async uploadFile() {
    const fileInput = document.getElementById("fileInput");
    const file = fileInput?.files[0];
    if (!file) {
      this.addStatusMessage("Выберите файл", "error");
      return;
    }
    await this.transcribeBlob(file, file.name);
  }

  // ============================================================
  // Транскрипция (общая)
  // ============================================================
  async transcribeBlob(blob, filename) {
    const formData = new FormData();
    formData.append("audio", blob, filename);

    this.resetResult();
    this.showProgress();
    document.getElementById("transcriptionResult").innerHTML =
      `<div class="processing" style="text-align:center;color:#667eea;">🎙️ GigaAM обрабатывает...</div>`;

    try {
      const response = await this.fetchWithTimeout(
        "/api/transcribe",
        { method: "POST", body: formData },
        60 * 60 * 1000,
      );

      const data = await response.json();

      if (data.success) {
        this.lastResult = {
          text: data.text || "",
          segments: data.segments || [],
        };
        this.renderResult();
        document.getElementById("copyBtn").disabled = false;

        this.addStatusMessage(
          `✅ Готово: ${data.text.length} символов, ${data.segments.length} сегментов`,
          "success",
        );
        if (data.device) {
          this.addStatusMessage(
            `🖥️ ${data.device}${data.gpuName ? ` (${data.gpuName})` : ""} — ${data.elapsedSec}s`,
            "info",
          );
        }
      } else {
        throw new Error(data.error || "Unknown error");
      }
    } catch (error) {
      console.error("Transcription error:", error);
      document.getElementById("transcriptionResult").innerHTML =
        `<div class="error-text" style="text-align:center;color:#ef4444;">❌ ${this.escapeHtml(error.message)}</div>`;
      this.addStatusMessage(`Ошибка: ${error.message}`, "error");
    } finally {
      this.hideProgress();
    }
  }

  async fetchWithTimeout(url, options = {}, timeoutMs = 60000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      return response;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(`Таймаут (${Math.round(timeoutMs / 60000)} мин)`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ============================================================
  // Тестовые файлы
  // ============================================================
  async loadTestFiles() {
    try {
      const response = await fetch("/api/test-files");
      const data = await response.json();
      const list = document.getElementById("testFileList");
      if (!list) return;

      if (!data.files || data.files.length === 0) {
        list.innerHTML = '<p style="color:#999;">📁 Нет файлов в example/</p>';
        return;
      }

      list.innerHTML = "";
      for (const file of data.files) {
        const item = document.createElement("div");
        item.className = "test-file-item";
        item.innerHTML = `
          <div class="test-file-info">
            <span class="test-file-name">🎵 ${file.name}</span>
            <span class="test-file-size">(${(file.size / 1024).toFixed(2)} KB)</span>
          </div>
          <div class="test-file-controls">
            <button class="btn-test-play" data-file="${file.path}">▶️</button>
            <button class="btn-test-transcribe" data-file="${file.name}" data-path="${file.path}">🎯 Распознать</button>
          </div>
        `;
        item
          .querySelector(".btn-test-play")
          .addEventListener("click", () => this.playTestFile(file.path));
        item
          .querySelector(".btn-test-transcribe")
          .addEventListener("click", () =>
            this.transcribeTestFile(file.name, file.path),
          );
        list.appendChild(item);
      }
    } catch (err) {
      console.error("Error loading test files:", err);
    }
  }

  playTestFile(filePath) {
    const audio = document.getElementById("testAudio");
    const player = document.getElementById("testAudioPlayer");
    if (!audio || !player) {
      this.addStatusMessage(`▶️ ${filePath}`, "info");
      return;
    }
    audio.src = filePath;
    audio.load();
    player.style.display = "block";
    audio.play().catch(() => {});
  }

  async transcribeTestFile(fileName, filePath) {
    try {
      const response = await fetch(filePath);
      const blob = await response.blob();
      await this.transcribeBlob(blob, fileName);
    } catch (err) {
      this.addStatusMessage(`Ошибка: ${err.message}`, "error");
    }
  }

  // ============================================================
  // Отображение результата
  // ============================================================
  resetResult() {
    this.lastResult = { text: "", segments: [] };
    document.getElementById("copyBtn").disabled = true;
  }

  renderResult() {
    const resultDiv = document.getElementById("transcriptionResult");
    if (!resultDiv) return;

    const { text, segments } = this.lastResult;

    if (!text) {
      resultDiv.innerHTML = '<div class="placeholder">Нет результата</div>';
      return;
    }

    if (this.viewMode === "without-time") {
      resultDiv.innerHTML = `<div class="result-text" style="white-space:pre-wrap;">${this.escapeHtml(text)}</div>`;
      return;
    }

    if (segments && segments.length > 0) {
      const html = segments
        .map(
          (seg) => `
            <div class="result-segment">
              <span class="result-segment-time">[${this.formatTime(seg.start)} – ${this.formatTime(seg.end)}]</span>
              <span class="result-segment-text">${this.escapeHtml(seg.text)}</span>
            </div>
          `,
        )
        .join("");
      resultDiv.innerHTML = `<div class="result-with-timestamps">${html}</div>`;
    } else {
      resultDiv.innerHTML = `<div class="result-text" style="white-space:pre-wrap;">${this.escapeHtml(text)}</div>`;
    }
  }

  copyResult() {
    if (!this.lastResult.text) return;

    let textToCopy = "";

    if (this.viewMode === "without-time") {
      textToCopy = this.lastResult.text;
    } else if (this.lastResult.segments?.length > 0) {
      textToCopy = this.lastResult.segments
        .map(
          (seg) =>
            `[${this.formatTime(seg.start)} – ${this.formatTime(seg.end)}] ${seg.text}`,
        )
        .join("\n");
    } else {
      textToCopy = this.lastResult.text;
    }

    navigator.clipboard.writeText(textToCopy).then(() => {
      this.addStatusMessage("📋 Скопировано", "success");
      const btn = document.getElementById("copyBtn");
      const orig = btn.innerHTML;
      btn.innerHTML = "✓ Скопировано!";
      setTimeout(() => (btn.innerHTML = orig), 2000);
    });
  }

  formatTime(seconds) {
    if (seconds === undefined || seconds === null) return "00:00";
    seconds = Math.floor(seconds);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) {
      return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  // ============================================================
  // Утилиты
  // ============================================================
  addStatusMessage(message, type = "info") {
    const container = document.getElementById("statusMessages");
    if (!container) return;

    const div = document.createElement("div");
    div.className = `status-message ${type}`;
    const icons = { success: "✅", error: "❌", info: "ℹ️" };
    div.textContent = `${icons[type] || "ℹ️"} [${new Date().toLocaleTimeString()}] ${message}`;
    container.appendChild(div);
    div.scrollIntoView({ behavior: "smooth", block: "nearest" });

    if (container.children.length > 50) {
      container.removeChild(container.children[0]);
    }
  }

  showProgress() {
    const bar = document.querySelector(".progress-bar");
    const fill = document.querySelector(".progress-fill");
    if (!bar || !fill) return;

    bar.style.display = "block";
    fill.style.width = "0%";

    let width = 0;
    this.progressInterval = setInterval(() => {
      if (width < 90) {
        width += 5;
        fill.style.width = width + "%";
      }
    }, 500);
  }

  hideProgress() {
    const bar = document.querySelector(".progress-bar");
    const fill = document.querySelector(".progress-fill");
    if (!bar || !fill) return;

    fill.style.width = "100%";
    setTimeout(() => {
      bar.style.display = "none";
      fill.style.width = "0%";
    }, 500);

    if (this.progressInterval) {
      clearInterval(this.progressInterval);
      this.progressInterval = null;
    }
  }

  escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  window.client = new GigaAMClient();
});
