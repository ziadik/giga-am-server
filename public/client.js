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
    this.lastDiarized = null; // {text, dialog, segments, speakers}
    this.viewMode = "with-time";
    this.currentMode = "offline";

    // ---- Voice typing ----
    this.voiceActive = false;
    this.voiceStartTime = null;
    this.voiceTimer = null;
    this.pcmBuffer = [];
    this.scriptProcessor = null;
    this.chunkCounter = 0;
    this.lastChunkEndMs = 0;
    this.speechMs = 0;
    this.silenceMs = 0;

    // ---- Индикатор ----
    this.isSpeaking = false;
    this.lastIndicatorUpdate = 0;
    this._diagCount = 0;

    // VAD
    this.VAD_RMS_THRESHOLD = 0.012;
    this.VAD_SILENCE_MS = 600;
    this.VAD_MIN_SPEECH_MS = 500;
    this.VAD_MAX_CHUNK_MS = 15000;

    this.init();
  }

  async init() {
    this.bindEvents();
    this.initModeTabs();
    this.initViewMode();
    await this.checkServerStatus();
    this.initWebSocket();
    this.checkMicrophoneSupport();
    await this.loadTestFiles();
    console.log("[INIT] client ready");
  }

  // ============================================================
  // Режимы: offline / diarized / live
  // ============================================================
  initModeTabs() {
    const tabs = document.querySelectorAll(".mode-tab");
    const panels = document.querySelectorAll(".mode-panel");
    const testSection = document.getElementById("testFilesSection");

    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const mode = tab.dataset.mode;
        this.currentMode = mode;
        tabs.forEach((t) => t.classList.toggle("active", t === tab));
        panels.forEach((p) =>
          p.classList.toggle("active", p.dataset.mode === mode),
        );
        if (testSection) {
          testSection.style.display = mode === "live" ? "none" : "block";
        }
        console.log(`[MODE] -> ${mode}`);
      });
    });
  }

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

    const voiceBtn = document.getElementById("voiceTypingBtn");
    const stopVoiceBtn = document.getElementById("stopVoiceBtn");
    if (voiceBtn) {
      voiceBtn.addEventListener("click", () => {
        console.log("[BTN] voiceTypingBtn clicked");
        this.startVoiceTyping();
      });
    }
    if (stopVoiceBtn)
      stopVoiceBtn.addEventListener("click", () => this.stopVoiceTyping());

    const fileInput = document.getElementById("fileInput");
    const uploadBtn = document.getElementById("uploadBtn");
    if (fileInput)
      fileInput.addEventListener("change", (e) => this.handleFileSelect(e));
    if (uploadBtn) uploadBtn.addEventListener("click", () => this.uploadFile());

    // diarized
    const diarFileInput = document.getElementById("diarFileInput");
    const diarUploadBtn = document.getElementById("diarUploadBtn");
    if (diarFileInput) {
      diarFileInput.addEventListener("change", (e) => {
        const file = e.target.files[0];
        const info = document.getElementById("diarFileInfo");
        if (!file) {
          if (diarUploadBtn) diarUploadBtn.disabled = true;
          if (info) info.innerHTML = "";
          return;
        }
        if (diarUploadBtn) diarUploadBtn.disabled = false;
        if (info) {
          info.innerHTML = `📁 ${file.name}<br>📦 ${(file.size / 1024 / 1024).toFixed(2)} MB`;
        }
      });
    }
    if (diarUploadBtn) {
      diarUploadBtn.addEventListener("click", () => this.uploadDiarized());
    }

    const copyBtn = document.getElementById("copyBtn");
    if (copyBtn) copyBtn.addEventListener("click", () => this.copyResult());
  }

  // ============================================================
  // Проверки
  // ============================================================
  checkMicrophoneSupport() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      console.error("[MIC] getUserMedia not supported");
      this.addStatusMessage("❌ Браузер не поддерживает микрофон", "error");
      const recordBtn = document.getElementById("recordBtn");
      if (recordBtn) recordBtn.disabled = true;
      return false;
    }

    const isSecure =
      location.protocol === "https:" ||
      location.hostname === "localhost" ||
      location.hostname === "127.0.0.1";
    console.log(
      `[MIC] protocol=${location.protocol} host=${location.hostname} secure=${isSecure} isSecureContext=${window.isSecureContext}`,
    );
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
      console.log("[STATUS] /api/status:", data);

      const statusText = document.getElementById("statusText");
      const indicator = document.querySelector(".status-indicator");

      if (data.scriptExists) {
        if (statusText) statusText.textContent = `✅ ${data.backend}`;
        if (indicator) indicator.style.background = "#4ade80";
        this.addStatusMessage(`Бэкенд: ${data.backend}`, "success");
        this.addStatusMessage(`Модель: ${data.model}`, "info");
        if (data.workerReady) {
          this.addStatusMessage(
            `🎯 Voice typing worker готов: ${data.workerInfo?.device} (${data.workerInfo?.gpuName})`,
            "success",
          );
        } else {
          this.addStatusMessage(
            `⏳ Voice typing worker загружается...`,
            "info",
          );
        }
      } else {
        if (statusText) statusText.textContent = "⚠️ Скрипт не найден";
        if (indicator) indicator.style.background = "#f59e0b";
        this.addStatusMessage("gigaam_transcribe.py не найден", "error");
      }

      return data;
    } catch (error) {
      console.error("[STATUS] error:", error);
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
        console.log("[WS] connected");
        this.addStatusMessage("WebSocket соединение установлено", "success");
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          console.log("[WS] msg:", data);
          if (data.type === "connected") {
            this.addStatusMessage(data.message, "success");
          } else if (data.type === "status") {
            if (data.status === "worker_ready") {
              this.addStatusMessage(
                `🎯 Worker готов: ${data.data?.device} (${data.data?.gpuName})`,
                "success",
              );
            } else {
              this.addStatusMessage(data.data?.message || data.status, "info");
              if (data.status === "processing") this.showProgress();
            }
          }
        } catch (err) {
          console.error("[WS] parse error:", err);
        }
      };

      this.ws.onerror = (err) => {
        console.error("[WS] error:", err);
      };

      this.ws.onclose = () => {
        console.warn("[WS] closed, reconnect in 5s");
        setTimeout(() => {
          if (this.ws && this.ws.readyState === WebSocket.CLOSED) {
            this.initWebSocket();
          }
        }, 5000);
      };
    } catch (err) {
      console.error("[WS] init error:", err);
    }
  }

  // ============================================================
  // Микрофон — запись целиком (offline STT)
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

      this.startVisualization(this.stream, "visualizer");
      this.updateRecordingTime();

      this.addStatusMessage("🎤 Запись началась...", "success");
    } catch (error) {
      console.error("[REC] error:", error);
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

  startVisualization(stream, canvasId = "visualizer") {
    try {
      if (!this.audioContext) {
        this.audioContext = new (
          window.AudioContext || window.webkitAudioContext
        )();
      }
      this.analyser = this.audioContext.createAnalyser();
      const source = this.audioContext.createMediaStreamSource(stream);
      source.connect(this.analyser);
      this.analyser.fftSize = 256;

      const canvas = document.getElementById(canvasId);
      if (!canvas) return;

      const ctx = canvas.getContext("2d");
      const bufferLength = this.analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      const draw = () => {
        if (!this.analyser) return;
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
      if (this.audioContext.state === "suspended") {
        this.audioContext.resume();
      }
    } catch (err) {
      console.error("[VIZ] error:", err);
    }
  }

  stopVisualization() {
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
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
  // VOICE TYPING (live)
  // ============================================================
  async startVoiceTyping() {
    console.log("[VT] ===== startVoiceTyping() called =====");
    if (!this.checkMicrophoneSupport()) {
      console.error("[VT] microphone support check FAILED");
      return;
    }
    if (this.voiceActive) {
      console.warn("[VT] already active, skip");
      return;
    }

    try {
      this.addStatusMessage("Voice typing: запрос микрофона...", "info");
      console.log("[VT] requesting getUserMedia...");

      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      const tracks = this.stream.getAudioTracks().map((t) => ({
        label: t.label,
        enabled: t.enabled,
        muted: t.muted,
        readyState: t.readyState,
      }));
      console.log("[VT] stream tracks:", tracks);

      this.audioContext = new (
        window.AudioContext || window.webkitAudioContext
      )({
        sampleRate: 16000,
      });
      console.log("[VT] audioContext created, state=", this.audioContext.state);

      if (this.audioContext.state === "suspended") {
        console.log("[VT] resuming suspended audioContext...");
        await this.audioContext.resume();
        console.log(
          "[VT] audioContext state after resume=",
          this.audioContext.state,
        );
      }

      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.3;

      const source = this.audioContext.createMediaStreamSource(this.stream);
      source.connect(this.analyser);

      const bufferSize = 4096;
      this.scriptProcessor = this.audioContext.createScriptProcessor(
        bufferSize,
        1,
        1,
      );

      source.connect(this.scriptProcessor);
      this.scriptProcessor.connect(this.audioContext.destination);
      console.log(
        `[VT] source -> scriptProcessor -> destination (bufferSize=${bufferSize})`,
      );

      this.voiceActive = true;
      this.voiceStartTime = Date.now();
      this.pcmBuffer = [];
      this.speechMs = 0;
      this.silenceMs = 0;
      this.lastChunkEndMs = 0;
      this.chunkCounter = 0;
      this.isSpeaking = false;
      this.lastIndicatorUpdate = 0;
      this._diagCount = 0;

      // сброс общего результата для нового сеанса live
      this.lastResult = { text: "", segments: [] };
      this.lastDiarized = null;
      document.getElementById("copyBtn").disabled = true;
      this.renderResult();

      this.scriptProcessor.onaudioprocess = (e) => {
        if (!this.voiceActive) return;
        const input = e.inputBuffer.getChannelData(0);
        const blockMs = (input.length / 16000) * 1000;

        let sum = 0;
        for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
        const rms = Math.sqrt(sum / input.length);
        const speakingNow = rms >= this.VAD_RMS_THRESHOLD;

        this._diagCount++;
        if (this._diagCount % 8 === 0) {
          console.log(
            `[VAD] rms=${rms.toFixed(4)} thr=${this.VAD_RMS_THRESHOLD} ` +
              `speech=${this.speechMs.toFixed(0)}ms silence=${this.silenceMs.toFixed(0)}ms ` +
              `buf=${this.pcmBuffer.length} speaking=${speakingNow}`,
          );
        }

        const now = performance.now();
        if (now - this.lastIndicatorUpdate > 100) {
          this.lastIndicatorUpdate = now;
          this.updateSpeechIndicator(speakingNow);
        }

        if (speakingNow) {
          this.speechMs += blockMs;
          this.silenceMs = 0;
          this.pcmBuffer.push(new Float32Array(input));
        } else {
          this.silenceMs += blockMs;
          if (this.speechMs > 0) {
            this.pcmBuffer.push(new Float32Array(input));
          }
        }

        const shouldCut =
          (this.silenceMs >= this.VAD_SILENCE_MS &&
            this.speechMs >= this.VAD_MIN_SPEECH_MS) ||
          (this.speechMs + this.silenceMs >= this.VAD_MAX_CHUNK_MS &&
            this.speechMs >= this.VAD_MIN_SPEECH_MS);

        if (shouldCut) {
          console.log(
            `[VAD] >>> shouldCut! speech=${this.speechMs.toFixed(0)}ms ` +
              `silence=${this.silenceMs.toFixed(0)}ms buf=${this.pcmBuffer.length}`,
          );
          this.flushVoiceChunk();
        }
      };

      this.startVisualization(this.stream, "visualizerLive");
      this.startVoiceTimer();

      document.getElementById("voiceTypingBtn").disabled = true;
      document.getElementById("stopVoiceBtn").disabled = false;

      const liveDiv = document.getElementById("liveTranscript");
      liveDiv.style.display = "block";
      liveDiv.innerHTML = "";

      this.updateSpeechIndicator(false);
      console.log("[VT] voice typing STARTED");
      this.addStatusMessage("🎯 Voice typing запущен, говорите...", "success");
    } catch (e) {
      console.error("[VT] FATAL error:", e);
      this.addStatusMessage(`Ошибка: ${e.message}`, "error");
    }
  }

  stopVoiceTyping() {
    console.log("[VT] stopVoiceTyping() called");
    if (!this.voiceActive) {
      console.warn("[VT] not active, skip");
      return;
    }

    if (this.pcmBuffer.length > 0 && this.speechMs >= this.VAD_MIN_SPEECH_MS) {
      console.log("[VT] flushing remaining buffer on stop");
      this.flushVoiceChunk();
    }

    this.voiceActive = false;
    this.isSpeaking = false;

    if (this.scriptProcessor) {
      try {
        this.scriptProcessor.disconnect();
      } catch (e) {}
      this.scriptProcessor = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this.stopVisualization();
    if (this.audioContext) {
      try {
        this.audioContext.close();
      } catch (e) {}
      this.audioContext = null;
    }
    if (this.voiceTimer) {
      clearTimeout(this.voiceTimer);
      this.voiceTimer = null;
    }

    document.getElementById("voiceTypingBtn").disabled = false;
    document.getElementById("stopVoiceBtn").disabled = true;
    const vadStatus = document.getElementById("vadStatus");
    if (vadStatus) vadStatus.textContent = "";

    this.setSpeechIndicatorState("off", "Остановлено");
    console.log("[VT] voice typing STOPPED");
    this.addStatusMessage("🎯 Voice typing остановлен", "info");
  }

  flushVoiceChunk() {
    console.log(
      `[FLUSH] entering. buf=${this.pcmBuffer.length} ` +
        `speech=${this.speechMs.toFixed(0)}ms silence=${this.silenceMs.toFixed(0)}ms`,
    );
    if (!this.pcmBuffer.length) {
      console.warn("[FLUSH] empty buffer, skip");
      return;
    }

    const totalLen = this.pcmBuffer.reduce((a, b) => a + b.length, 0);
    const merged = new Float32Array(totalLen);
    let off = 0;
    for (const b of this.pcmBuffer) {
      merged.set(b, off);
      off += b.length;
    }

    const chunkId = ++this.chunkCounter;
    const startMs = this.lastChunkEndMs;
    const endMs = startMs + (merged.length / 16000) * 1000;
    this.lastChunkEndMs = endMs;

    const durationSec = (merged.length / 16000).toFixed(2);
    console.log(
      `[FLUSH] chunk #${chunkId}: samples=${merged.length} ` +
        `duration=${durationSec}s start=${(startMs / 1000).toFixed(2)}s end=${(endMs / 1000).toFixed(2)}s`,
    );

    this.pcmBuffer = [];
    this.speechMs = 0;
    this.silenceMs = 0;

    const wavBlob = this.float32ToWav(merged, 16000);
    const filename = `voice-${chunkId}.wav`;
    console.log(`[FLUSH] wav blob size=${wavBlob.size} bytes`);

    const liveDiv = document.getElementById("liveTranscript");
    const el = document.createElement("div");
    el.className = "chunk pending";
    el.innerHTML = `<span class="time">[${this.formatTime(startMs / 1000)}]</span> ...`;
    liveDiv.appendChild(el);
    liveDiv.scrollTop = liveDiv.scrollHeight;

    this.setSpeechIndicatorState("pending", "Распознаю...");
    this.sendVoiceChunk(wavBlob, filename, startMs, endMs, el);
  }

  async sendVoiceChunk(wavBlob, filename, startMs, endMs, el) {
    const formData = new FormData();
    formData.append("audio", wavBlob, filename);

    const url = "/api/stream/chunk";
    console.log(`[CHUNK] POST ${url} file=${filename} size=${wavBlob.size}`);

    const t0 = performance.now();
    try {
      const resp = await fetch(url, { method: "POST", body: formData });
      const latency = Math.round(performance.now() - t0);
      console.log(`[CHUNK] HTTP ${resp.status} in ${latency}ms`);

      const data = await resp.json();
      console.log("[CHUNK] response:", data);

      if (data.error) {
        el.className = "chunk";
        el.innerHTML = `<span class="time">[${this.formatTime(startMs / 1000)}]</span>
                        <span style="color:#ef4444;">⚠ ${this.escapeHtml(data.error)}</span>`;
      } else {
        const text = (data.text || "").trim();
        if (!text) {
          console.log("[CHUNK] empty text, removing placeholder");
          el.remove();
        } else {
          el.className = "chunk";
          el.innerHTML = `<span class="time">[${this.formatTime(startMs / 1000)}]</span>
                          ${this.escapeHtml(text)} <small style="color:#9ca3af;">(${latency} ms)</small>`;

          this.lastResult.text =
            (this.lastResult.text ? this.lastResult.text + " " : "") + text;
          this.lastResult.segments.push({
            start: startMs / 1000,
            end: endMs / 1000,
            text,
            speaker: null,
          });
          document.getElementById("copyBtn").disabled = false;

          // отражаем в общем результате (если пользователь смотрит не live)
          if (
            this.viewMode === "with-time" ||
            this.viewMode === "without-time"
          ) {
            this.renderResult();
          }
        }
      }
    } catch (e) {
      console.error("[CHUNK] FATAL:", e);
      el.className = "chunk";
      el.innerHTML = `<span class="time">[${this.formatTime(startMs / 1000)}]</span>
                      <span style="color:#ef4444;">❌ ${this.escapeHtml(e.message)}</span>`;
    }

    if (this.voiceActive) {
      this.updateSpeechIndicator(this.isSpeaking);
    }
  }

  startVoiceTimer() {
    if (!this.voiceActive) return;
    const elapsed = Math.floor((Date.now() - this.voiceStartTime) / 1000);
    const timeEl = document.getElementById("recordingTimeLive");
    if (timeEl) {
      timeEl.textContent = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;
    }
    const vadStatus = document.getElementById("vadStatus");
    if (vadStatus) {
      vadStatus.textContent =
        this.speechMs > 0 ? `🎙 ${(this.speechMs / 1000).toFixed(1)}s` : "";
    }
    this.voiceTimer = setTimeout(() => this.startVoiceTimer(), 500);
  }

  updateSpeechIndicator(speakingNow) {
    this.isSpeaking = speakingNow;
    if (!this.voiceActive) return;
    if (speakingNow) {
      this.setSpeechIndicatorState("speaking", "🎙 ГОВОРИТ");
    } else {
      this.setSpeechIndicatorState("idle", "⏸ тишина");
    }
  }

  setSpeechIndicatorState(state, text) {
    const el = document.getElementById("speechIndicator");
    const txt = document.getElementById("speechIndicatorText");
    if (!el) return;
    const prev = el.className;
    el.classList.remove("idle", "speaking", "pending", "off");
    el.classList.add(state);
    if (txt && text !== undefined) txt.textContent = text;
    if (prev !== `speech-indicator ${state}`) {
      console.log(`[IND] state -> ${state} (${text})`);
    }
  }

  float32ToWav(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);

    const writeString = (off, str) => {
      for (let i = 0; i < str.length; i++)
        view.setUint8(off + i, str.charCodeAt(i));
    };

    writeString(0, "RIFF");
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, "data");
    view.setUint32(40, samples.length * 2, true);

    let off = 44;
    for (let i = 0; i < samples.length; i++) {
      let s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
    return new Blob([view], { type: "audio/wav" });
  }

  // ============================================================
  // Загрузка файла (offline STT)
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

  async transcribeBlob(blob, filename) {
    const formData = new FormData();
    formData.append("audio", blob, filename);

    this.resetResult();
    this.showProgress();
    document.getElementById("transcriptionResult").innerHTML =
      `<div class="processing" style="text-align:center;color:#667eea;">🎙️ GigaAM обрабатывает...</div>`;

    console.log(`[TR] POST /api/transcribe file=${filename} size=${blob.size}`);
    try {
      const response = await this.fetchWithTimeout(
        "/api/transcribe",
        { method: "POST", body: formData },
        60 * 60 * 1000,
      );

      const data = await response.json();
      console.log("[TR] response:", data);

      if (data.success) {
        this.lastResult = {
          text: data.text || "",
          segments: data.segments || [],
        };
        this.lastDiarized = null;
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
      console.error("[TR] FATAL:", error);
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
  // DIARIZED
  // ============================================================
  async uploadDiarized() {
    const fileInput = document.getElementById("diarFileInput");
    const file = fileInput?.files[0];
    if (!file) {
      this.addStatusMessage("Выберите файл", "error");
      return;
    }
    await this.transcribeDiarized(file, file.name);
  }

  async transcribeDiarized(file, filename) {
    const formData = new FormData();
    formData.append("audio", file, filename);

    this.resetResult();
    this.showProgress();
    document.getElementById("transcriptionResult").innerHTML =
      `<div class="processing" style="text-align:center;color:#667eea;">👥 Диаризация + GigaAM (это может занять время)...</div>`;
    this.addStatusMessage(`👥 Диаризация: ${filename}`, "info");

    console.log(
      `[DIAR] POST /api/transcribe-diarized file=${filename} size=${file.size}`,
    );
    try {
      const response = await this.fetchWithTimeout(
        "/api/transcribe-diarized",
        { method: "POST", body: formData },
        60 * 60 * 1000,
      );
      const data = await response.json();
      console.log("[DIAR] response:", data);

      if (!data.success) {
        throw new Error(data.error || data.details || "Unknown error");
      }

      this.lastDiarized = {
        text: data.text || "",
        dialog: data.dialog || "",
        segments: data.segments || [],
        speakers: data.speakers || [],
      };

      this.lastResult = {
        text: data.text || "",
        segments: data.segments || [],
      };

      this.renderResult();
      document.getElementById("copyBtn").disabled = false;

      this.addStatusMessage(
        `✅ Готово: ${data.speakers?.length || 0} спикеров, ${data.segments?.length || 0} сегментов, ${data.elapsedSec}s`,
        "success",
      );
      this.addStatusMessage(
        `💡 Переключите вид на «👥 Диалог», чтобы увидеть разбивку по спикерам`,
        "info",
      );
    } catch (error) {
      console.error("[DIAR] FATAL:", error);
      document.getElementById("transcriptionResult").innerHTML =
        `<div class="error-text" style="text-align:center;color:#ef4444;">❌ ${this.escapeHtml(error.message)}</div>`;
      this.addStatusMessage(`Ошибка: ${error.message}`, "error");
    } finally {
      this.hideProgress();
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
            <button class="btn-test-transcribe" data-file="${file.name}" data-path="${file.path}">🎯 STT</button>
            <button class="btn-test-diarize" data-file="${file.name}" data-path="${file.path}">👥 Диаризация</button>
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
        item
          .querySelector(".btn-test-diarize")
          .addEventListener("click", () =>
            this.transcribeTestFileDiarized(file.name, file.path),
          );
        list.appendChild(item);
      }
    } catch (err) {
      console.error("[FILES] error:", err);
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

  async transcribeTestFileDiarized(fileName, filePath) {
    try {
      const response = await fetch(filePath);
      const blob = await response.blob();
      await this.transcribeDiarized(blob, fileName);
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

    // 👥 Диалог по спикерам
    if (this.viewMode === "dialog") {
      if (!this.lastDiarized?.segments?.length) {
        resultDiv.innerHTML = `<div class="placeholder">Диалог доступен только после STT с диаризацией.</div>`;
        return;
      }
      const lines = [];
      for (const seg of this.lastDiarized.segments) {
        const speaker = seg.speaker || "SPEAKER";
        if (lines.length && lines[lines.length - 1].speaker === speaker) {
          lines[lines.length - 1].text += " " + seg.text;
        } else {
          lines.push({ speaker, text: seg.text });
        }
      }
      const html = lines
        .map(
          (l) => `
            <div class="dialog-line">
              <span class="dialog-speaker">${this.escapeHtml(l.speaker)}</span>
              <span class="dialog-text">${this.escapeHtml(l.text)}</span>
            </div>`,
        )
        .join("");
      resultDiv.innerHTML = `<div class="result-dialog">${html}</div>`;
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
              <span class="result-segment-text">${seg.speaker ? `<b>${this.escapeHtml(seg.speaker)}:</b> ` : ""}${this.escapeHtml(seg.text)}</span>
            </div>`,
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

    if (this.viewMode === "dialog" && this.lastDiarized?.dialog) {
      textToCopy = this.lastDiarized.dialog;
    } else if (this.viewMode === "without-time") {
      textToCopy = this.lastResult.text;
    } else if (this.lastResult.segments?.length > 0) {
      textToCopy = this.lastResult.segments
        .map(
          (seg) =>
            `[${this.formatTime(seg.start)} – ${this.formatTime(seg.end)}] ${seg.speaker ? seg.speaker + ": " : ""}${seg.text}`,
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
