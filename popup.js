const statusEl = document.getElementById("status");

const startVideoBtn = document.getElementById("startVideoBtn");
const stopVideoBtn = document.getElementById("stopVideoBtn");
const videoWithAudio = document.getElementById("videoWithAudio");
const videoTimerEl = document.getElementById("videoTimer");

const audioFormatEl = document.getElementById("audioFormat");
const startAudioBtn = document.getElementById("startAudioBtn");
const stopAudioBtn = document.getElementById("stopAudioBtn");
const audioTimerEl = document.getElementById("audioTimer");

const AUDIO_GAIN = 2.0;
const targetTabId = Number(new URLSearchParams(window.location.search).get("targetTabId"));

let videoState = null;
let audioState = null;

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#fca5a5" : "#9ca3af";
}

function getSupportedMimeType(candidates) {
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: true }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });
}

function timestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function stopTracks(stream) {
  if (!stream) return;
  stream.getTracks().forEach((track) => track.stop());
}

function formatDuration(totalSeconds) {
  const hh = Math.floor(totalSeconds / 3600);
  const mm = Math.floor((totalSeconds % 3600) / 60);
  const ss = totalSeconds % 60;
  const pad = (v) => String(v).padStart(2, "0");
  return hh > 0 ? `${pad(hh)}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
}

function startTimer(state, timerEl) {
  state.elapsed = 0;
  timerEl.textContent = `录制时长：${formatDuration(0)}`;
  state.timerId = setInterval(() => {
    state.elapsed += 1;
    timerEl.textContent = `录制时长：${formatDuration(state.elapsed)}`;
  }, 1000);
}

function stopTimer(state) {
  if (state?.timerId) {
    clearInterval(state.timerId);
    state.timerId = null;
  }
}

async function closeAudioContext(ctx) {
  if (!ctx) return;
  try {
    await ctx.close();
  } catch (_) {
    // Ignore close errors from inactive contexts.
  }
}

function captureCurrentTab(constraints) {
  const captureOptions = { ...constraints };
  if (Number.isInteger(targetTabId) && targetTabId > 0) {
    captureOptions.targetTabId = targetTabId;
  }

  return new Promise((resolve, reject) => {
    chrome.tabCapture.capture(captureOptions, (stream) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      if (!stream) {
        reject(new Error("无法捕获当前标签页，请确认标签页可见且正在播放内容。"));
        return;
      }
      resolve(stream);
    });
  });
}

function amplifyCapturedStream(inputStream, gainValue, keepVideoTrack) {
  const audioTracks = inputStream.getAudioTracks();
  const videoTracks = keepVideoTrack ? inputStream.getVideoTracks() : [];
  if (!audioTracks.length) {
    return { stream: inputStream, audioContext: null };
  }

  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(new MediaStream(audioTracks));
  const gainNode = audioContext.createGain();
  gainNode.gain.value = gainValue;
  const destination = audioContext.createMediaStreamDestination();

  source.connect(gainNode);
  gainNode.connect(destination);

  const outputTracks = [...videoTracks, ...destination.stream.getAudioTracks()];
  const outputStream = new MediaStream(outputTracks);
  return { stream: outputStream, audioContext };
}

function audioBufferToWavBlob(buffer) {
  const channels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const samples = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const dataLength = samples * blockAlign;
  const totalLength = 44 + dataLength;
  const out = new ArrayBuffer(totalLength);
  const view = new DataView(out);

  let offset = 0;
  const writeString = (text) => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset, text.charCodeAt(i));
      offset += 1;
    }
  };

  writeString("RIFF");
  view.setUint32(offset, 36 + dataLength, true);
  offset += 4;
  writeString("WAVE");
  writeString("fmt ");
  view.setUint32(offset, 16, true);
  offset += 4;
  view.setUint16(offset, 1, true);
  offset += 2;
  view.setUint16(offset, channels, true);
  offset += 2;
  view.setUint32(offset, sampleRate, true);
  offset += 4;
  view.setUint32(offset, sampleRate * blockAlign, true);
  offset += 4;
  view.setUint16(offset, blockAlign, true);
  offset += 2;
  view.setUint16(offset, 16, true);
  offset += 2;
  writeString("data");
  view.setUint32(offset, dataLength, true);

  const interleaved = new Int16Array(samples * channels);
  for (let i = 0; i < samples; i += 1) {
    for (let ch = 0; ch < channels; ch += 1) {
      const sample = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
      interleaved[i * channels + ch] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
  }

  new Int16Array(out, 44).set(interleaved);
  return new Blob([out], { type: "audio/wav" });
}

async function transcodeToWav(recordedBlob) {
  const ab = await recordedBlob.arrayBuffer();
  const audioCtx = new AudioContext();
  try {
    const decoded = await audioCtx.decodeAudioData(ab.slice(0));
    return audioBufferToWavBlob(decoded);
  } finally {
    await audioCtx.close();
  }
}

startVideoBtn.addEventListener("click", async () => {
  if (videoState?.recorder?.state === "recording") return;

  try {
    setStatus("正在捕获当前标签页视频...");
    const baseStream = await captureCurrentTab({
      video: true,
      audio: Boolean(videoWithAudio.checked),
      videoConstraints: {
        mandatory: {
          maxWidth: 1920,
          maxHeight: 1080,
          maxFrameRate: 30
        }
      }
    });

    const { stream, audioContext } = videoWithAudio.checked
      ? amplifyCapturedStream(baseStream, AUDIO_GAIN, true)
      : { stream: baseStream, audioContext: null };

    const mp4Type = getSupportedMimeType([
      "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
      "video/mp4"
    ]);
    if (!mp4Type) {
      stopTracks(stream);
      if (stream !== baseStream) stopTracks(baseStream);
      await closeAudioContext(audioContext);
      throw new Error("当前浏览器不支持 MP4 编码。");
    }

    const chunks = [];
    const recorder = new MediaRecorder(stream, { mimeType: mp4Type });
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    recorder.onstop = async () => {
      const blob = new Blob(chunks, { type: mp4Type });
      const filename = `video_${timestamp()}.mp4`;
      downloadBlob(blob, filename);
      stopTracks(stream);
      if (stream !== baseStream) stopTracks(baseStream);
      await closeAudioContext(audioContext);
      stopTimer(videoState);
      videoState = null;
      startVideoBtn.disabled = false;
      stopVideoBtn.disabled = true;
      videoTimerEl.textContent = "录制时长：00:00";
      setStatus(`视频已保存：${filename}`);
    };

    recorder.start(1000);
    videoState = { recorder, timerId: null, elapsed: 0 };
    startTimer(videoState, videoTimerEl);
    startVideoBtn.disabled = true;
    stopVideoBtn.disabled = false;
    setStatus("视频录制中...");
  } catch (err) {
    setStatus(`视频录制失败：${err?.message || "未知错误"}`, true);
  }
});

stopVideoBtn.addEventListener("click", () => {
  const recorder = videoState?.recorder;
  if (!recorder || recorder.state !== "recording") return;
  recorder.stop();
  setStatus("正在处理并导出 MP4...");
});

startAudioBtn.addEventListener("click", async () => {
  if (audioState?.recorder?.state === "recording") return;

  try {
    const format = audioFormatEl.value;
    setStatus("正在捕获当前标签页声音...");
    const baseStream = await captureCurrentTab({
      audio: true,
      video: false
    });
    const { stream, audioContext } = amplifyCapturedStream(baseStream, AUDIO_GAIN, false);

    let mimeType = "";
    if (format === "mp3") {
      mimeType = getSupportedMimeType(["audio/mpeg", "audio/mp3"]);
      if (!mimeType) {
        stopTracks(stream);
        if (stream !== baseStream) stopTracks(baseStream);
        await closeAudioContext(audioContext);
        throw new Error("当前浏览器不支持 MP3 直接编码，请选择 WAV。");
      }
    } else {
      mimeType = getSupportedMimeType(["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]);
      if (!mimeType) {
        stopTracks(stream);
        if (stream !== baseStream) stopTracks(baseStream);
        await closeAudioContext(audioContext);
        throw new Error("未找到可用音频编码器。");
      }
    }

    const chunks = [];
    const recorder = new MediaRecorder(stream, { mimeType });
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    recorder.onstop = async () => {
      try {
        const rawBlob = new Blob(chunks, { type: mimeType });
        const filenameBase = `audio_${timestamp()}`;
        if (format === "wav") {
          setStatus("正在转码为 WAV...");
          const wavBlob = await transcodeToWav(rawBlob);
          const filename = `${filenameBase}.wav`;
          downloadBlob(wavBlob, filename);
          setStatus(`音频已保存：${filename}`);
        } else {
          const filename = `${filenameBase}.mp3`;
          downloadBlob(rawBlob, filename);
          setStatus(`音频已保存：${filename}`);
        }
      } catch (err) {
        setStatus(`音频导出失败：${err?.message || "未知错误"}`, true);
      } finally {
        stopTracks(stream);
        if (stream !== baseStream) stopTracks(baseStream);
        await closeAudioContext(audioContext);
        stopTimer(audioState);
        audioState = null;
        startAudioBtn.disabled = false;
        stopAudioBtn.disabled = true;
        audioTimerEl.textContent = "录制时长：00:00";
      }
    };

    recorder.start(500);
    audioState = { recorder, timerId: null, elapsed: 0 };
    startTimer(audioState, audioTimerEl);
    startAudioBtn.disabled = true;
    stopAudioBtn.disabled = false;
setStatus(`音频录制中（${format.toUpperCase()}，增益 x${AUDIO_GAIN}）...`);
  } catch (err) {
    setStatus(`音频录制失败：${err?.message || "未知错误"}`, true);
  }
});

if (!Number.isInteger(targetTabId) || targetTabId <= 0) {
  startVideoBtn.disabled = true;
  startAudioBtn.disabled = true;
  setStatus("未绑定目标标签页，请回到要录制的页面后重新点击扩展图标。", true);
}

stopAudioBtn.addEventListener("click", () => {
  const recorder = audioState?.recorder;
  if (!recorder || recorder.state !== "recording") return;
  recorder.stop();
  setStatus("正在处理音频文件...");
});
