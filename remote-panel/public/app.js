const app = document.querySelector("#app");
let state = { user: null, cameras: [], groups: [], admin: null, tab: "live", group: "all", recordings: [], localAlarms: [], localCurrent: null, localIndex: 0, localBaseOffset: 0, nvrFiles: [], nvrAlarms: [], nvrCurrent: null, nvrIndex: 0, nvrMessage: "", alarms: [], alarmStatus: null };
const nvrPlayerLimitBytes = 256 * 1024 * 1024;

async function api(path, options = {}) {
  const { timeoutMs = 20000, ...fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(fetchOptions.headers || {}) },
    ...fetchOptions,
    signal: fetchOptions.signal || controller.signal
  }).catch((error) => {
    if (error.name === "AbortError") throw new Error("Tempo limite de comunicacao");
    throw error;
  }).finally(() => clearTimeout(timer));
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Erro de comunicacao");
  return data;
}

function setNvrMessage(message) {
  state.nvrMessage = message;
  const box = document.querySelector("#nvrStatus");
  if (!box) return;
  box.textContent = message || "";
  box.classList.toggle("hidden", !message);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char]));
}

function icon(name) {
  const icons = {
    camera: '<svg viewBox="0 0 24 24"><path d="M4 7h10a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Zm13 3 5-3v10l-5-3V10Z"/></svg>',
    users: '<svg viewBox="0 0 24 24"><path d="M16 11a4 4 0 1 0-3.4-6.1A5 5 0 1 0 9 14c-3.3 0-6 1.7-6 3.8V20h12v-2.2c0-.9-.5-1.8-1.4-2.4A7.8 7.8 0 0 1 18 14c2.8 0 5 1.4 5 3.1V20h-6v-2.2c0-1.2-.5-2.3-1.4-3.2A4 4 0 0 0 16 11Z"/></svg>',
    logout: '<svg viewBox="0 0 24 24"><path d="M10 4H5v16h5v-2H7V6h3V4Zm5.6 4.4L14.2 9.8 16.4 12H10v2h6.4l-2.2 2.2 1.4 1.4L20.2 13l-4.6-4.6Z"/></svg>'
  };
  return `<span class="ico">${icons[name] || ""}</span>`;
}

function renderLogin(error = "") {
  app.innerHTML = `
    <section class="login-wrap">
      <form class="login-box" id="loginForm">
        <div class="brand"><span class="brand-mark">${icon("camera")}</span><span>Portal CFTV</span></div>
        <h1>Acesso local</h1>
        <p>Painel de visualizacao e permissoes das cameras.</p>
        ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
        <label>Usuario<input name="username" autocomplete="username" required value="admin"></label>
        <label>Senha<input name="password" type="password" autocomplete="current-password" required></label>
        <button class="primary" type="submit">Entrar</button>
      </form>
    </section>`;
  document.querySelector("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/login", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) });
      await boot();
    } catch (err) {
      renderLogin(err.message);
    }
  });
}

function shell(content) {
  const adminActive = state.tab === "admin" || state.tab === "adminLogs";
  const adminButton = state.user?.role === "admin" ? `<button class="tab ${adminActive ? "active" : ""}" data-tab="admin">${icon("users")} Admin</button>` : "";
  app.innerHTML = `
    <section class="shell">
      <header class="topbar">
        <div class="brand"><span class="brand-mark">${icon("camera")}</span><span>Portal CFTV</span></div>
        <div class="actions">
          <div class="tabs">
            <button class="tab ${state.tab === "live" ? "active" : ""}" data-tab="live">${icon("camera")} Ao vivo</button>
            <button class="tab ${state.tab === "recordings" ? "active" : ""}" data-tab="recordings">Gravacoes</button>
            <button class="tab ${state.tab === "alarms" ? "active" : ""}" data-tab="alarms">Alarmes</button>
            ${adminButton}
          </div>
          <span class="muted">${escapeHtml(state.user.username)}</span>
          <button class="ghost" id="logoutBtn" title="Sair">${icon("logout")}</button>
        </div>
      </header>
      <div class="content">${content}</div>
    </section>`;
  document.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", async () => {
    state.tab = button.dataset.tab;
    if (state.tab === "admin" || state.tab === "adminLogs") await loadAdmin();
    if (state.tab === "recordings") state.recordings = [];
    if (state.tab === "alarms") await loadAlarms();
    render();
  }));
  document.querySelector("#logoutBtn").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST", body: "{}" });
    state = { user: null, cameras: [], groups: [], admin: null, tab: "live", group: "all", recordings: [], localAlarms: [], nvrFiles: [], nvrAlarms: [], alarms: [], alarmStatus: null };
    renderLogin();
  });
}

function groupName(id) {
  return state.groups.find((group) => group.id === id)?.name || "Sem grupo";
}

function renderLive() {
  const groupButtons = [
    `<button class="filter ${state.group === "all" ? "active" : ""}" data-group="all">Todas</button>`,
    ...state.groups.map((group) => `<button class="filter ${state.group === group.id ? "active" : ""}" data-group="${escapeHtml(group.id)}">${escapeHtml(group.name)}</button>`)
  ].join("");
  const cameras = state.group === "all" ? state.cameras : state.cameras.filter((camera) => camera.groupId === state.group);
  const cards = cameras.map((camera) => `
    <article class="camera-card">
      <div class="camera-head">
        <div><div class="camera-title">${escapeHtml(camera.name)}</div><div class="camera-meta">${escapeHtml(groupName(camera.groupId))}</div></div>
        <span class="badge">${escapeHtml(camera.id)}</span>
      </div>
      <iframe class="player" allow="autoplay; fullscreen" src="${escapeHtml(camera.hlsUrl)}"></iframe>
      <div class="stream-links"><a target="_blank" href="${escapeHtml(camera.hlsUrl)}">Abrir HLS</a><a target="_blank" href="${escapeHtml(camera.webrtcUrl)}">Abrir WebRTC</a></div>
    </article>`).join("");
  shell(`
    <section class="toolbar">${groupButtons}</section>
    <section class="grid">${cards || '<div class="panel">Nenhuma camera liberada para este filtro.</div>'}</section>`);
  document.querySelectorAll("[data-group]").forEach((button) => button.addEventListener("click", () => {
    state.group = button.dataset.group;
    renderLive();
  }));
}

function defaultRecordingWindow() {
  const now = new Date();
  const start = new Date(now.getTime() - 60 * 60 * 1000);
  const toLocal = (date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  return { start: toLocal(start), end: toLocal(now) };
}

async function loadRecordings() {
  const camera = document.querySelector("#recordingCamera").value;
  const start = new Date(document.querySelector("#recordingStart").value).toISOString();
  const end = new Date(document.querySelector("#recordingEnd").value).toISOString();
  const data = await api(`/api/recordings?camera=${encodeURIComponent(camera)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
  state.recordings = data.recordings;
  state.localAlarms = data.alarms || [];
  state.localIndex = 0;
  state.localBaseOffset = 0;
  state.localCurrent = data.recordings[0]?.url || null;
  renderRecordings();
}

async function loadNvrRecordings() {
  const camera = document.querySelector("#nvrCamera").value;
  const start = new Date(document.querySelector("#nvrStart").value).toISOString();
  const end = new Date(document.querySelector("#nvrEnd").value).toISOString();
  setNvrMessage("Buscando arquivos no NVR...");
  const data = await api(`/api/nvr-recordings?camera=${encodeURIComponent(camera)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`, { timeoutMs: 70000 });
  state.nvrFiles = data.files;
  state.nvrAlarms = data.alarms || [];
  state.nvrCurrent = null;
  state.nvrIndex = 0;
  state.nvrMessage = data.files.length ? `${data.files.length} arquivo(s) encontrado(s) no NVR.` : "Nenhuma gravacao encontrada no NVR nesse periodo.";
  renderRecordings();
}

function localTotalSeconds() {
  return state.recordings.reduce((sum, item) => sum + Math.max(1, Number(item.duration || 60)), 0);
}

function localOffsetBefore(index) {
  return state.recordings.slice(0, Math.max(0, Number(index))).reduce((sum, item) => sum + Math.max(1, Number(item.duration || 60)), 0);
}

function localPointAtOffset(offset) {
  let remaining = Math.max(0, Number(offset) || 0);
  for (let index = 0; index < state.recordings.length; index += 1) {
    const duration = Math.max(1, Number(state.recordings[index].duration || 60));
    if (remaining < duration || index === state.recordings.length - 1) {
      return { index, seconds: Math.min(Math.max(0, remaining), Math.max(0, duration - 1)) };
    }
    remaining -= duration;
  }
  return { index: 0, seconds: 0 };
}

function localUrlAt(item, seconds = 0) {
  const inside = Math.max(0, Number(seconds) || 0);
  const start = new Date(new Date(item.start).getTime() + inside * 1000);
  const duration = Math.max(1, Math.min(300, Number(item.duration || 60) - inside));
  const url = new URL(item.url);
  url.searchParams.set("start", start.toISOString());
  url.searchParams.set("duration", String(duration));
  url.searchParams.set("_", String(Date.now()));
  return url.toString();
}

function currentLocalOffset() {
  const player = document.querySelector("#localPlayer");
  const offset = player && Number.isFinite(player.currentTime) ? player.currentTime : 0;
  return Math.max(0, Number(state.localBaseOffset || 0) + offset);
}

function formatLocalOffset(offset) {
  const seconds = Math.max(0, Math.round(Number(offset) || 0));
  const start = state.recordings[0] ? new Date(state.recordings[0].start).getTime() : Date.now();
  return new Date(start + seconds * 1000).toLocaleTimeString("pt-BR");
}

function formatTimelineTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function alarmTimelineMarkers(startMs, totalSeconds, alarms, clickHandler) {
  if (!startMs || !totalSeconds || !alarms?.length) return "";
  const buckets = new Map();
  for (const alarm of alarms) {
    if (alarm.active === false || alarm.active === "false" || alarm.active === 0) continue;
    const alarmMs = new Date(alarm.at).getTime();
    if (!Number.isFinite(alarmMs)) continue;
    const offset = Math.round((alarmMs - startMs) / 1000);
    if (offset < 0 || offset > totalSeconds) continue;
    const bucket = Math.floor(offset / 60);
    const current = buckets.get(bucket);
    if (current) {
      current.count += 1;
      current.types.add(alarm.type || "alarme");
    } else {
      buckets.set(bucket, { offset, at: alarm.at, count: 1, types: new Set([alarm.type || "alarme"]) });
    }
  }
  return [...buckets.values()].map((item) => {
    const left = (item.offset / totalSeconds) * 100;
    const types = [...item.types].join(", ");
    const title = item.count > 1
      ? `${new Date(item.at).toLocaleString("pt-BR")} - ${item.count} alarmes (${types})`
      : `${new Date(item.at).toLocaleString("pt-BR")} - ${types}`;
    return `<button class="alarm-marker" type="button" title="${escapeHtml(title)}" style="left:${left.toFixed(3)}%" onclick="${clickHandler}(${item.offset})">${item.count > 1 ? item.count : ""}</button>`;
  }).join("");
}

function localTimelineMarks(totalSeconds) {
  if (!state.recordings[0] || !totalSeconds) return "";
  const start = new Date(state.recordings[0].start).getTime();
  const end = start + totalSeconds * 1000;
  const interval = totalSeconds <= 60 * 60 ? 2 * 60 : totalSeconds <= 4 * 60 * 60 ? 10 * 60 : 30 * 60;
  const first = Math.ceil(start / (interval * 1000)) * interval * 1000;
  const marks = [];
  for (let time = first; time < end; time += interval * 1000) {
    const left = ((time - start) / (totalSeconds * 1000)) * 100;
    if (left > 3 && left < 97) {
      marks.push(`<span class="timeline-mark" style="left:${left.toFixed(3)}%"><i></i><b>${formatTimelineTime(time)}</b></span>`);
    }
  }
  marks.push(alarmTimelineMarkers(start, totalSeconds, state.localAlarms, "window.localTimelineSeek"));
  return marks.join("");
}

function setLocalPlayerSource(url, index = state.localIndex, autoplay = false) {
  if (!url) return;
  state.localCurrent = url;
  state.localIndex = index;
  const player = document.querySelector("#localPlayer");
  if (!player) return;
  player.setAttribute("src", url);
  player.load();
  if (autoplay) player.play().catch(() => {});
}

function updateLocalTimelineActive(index) {
  document.querySelectorAll(".local-segment").forEach((segment) => {
    segment.classList.toggle("active", Number(segment.dataset.index) === Number(index));
  });
}

window.playLocalRecording = (index, seekSeconds = null) => {
  const nextIndex = Number(index);
  const item = state.recordings[nextIndex];
  if (!item) return;
  const startAt = seekSeconds === null ? 0 : seekSeconds;
  state.localBaseOffset = localOffsetBefore(nextIndex) + startAt;
  updateLocalTimelineActive(nextIndex);
  const slider = document.querySelector("#localTimelineRange");
  const label = document.querySelector("#localTimelineLabel");
  if (slider) slider.value = String(Math.round(state.localBaseOffset));
  if (label) label.textContent = formatLocalOffset(state.localBaseOffset);
  setLocalPlayerSource(localUrlAt(item, startAt), nextIndex, true);
};

window.localTimelinePreview = (value) => {
  const label = document.querySelector("#localTimelineLabel");
  if (label) label.textContent = formatLocalOffset(value);
};

window.localTimelineSeek = (value) => {
  const total = localTotalSeconds();
  if (!total) return;
  const target = Math.max(0, Math.min(total - 1, Number(value) || 0));
  const point = localPointAtOffset(target);
  window.playLocalRecording(point.index, point.seconds);
};

window.localPlayPause = () => {
  const player = document.querySelector("#localPlayer");
  if (!player?.src) return;
  player.paused ? player.play().catch(() => {}) : player.pause();
};

window.localSeek = (seconds) => {
  const offset = Number(seconds);
  const total = localTotalSeconds();
  if (!total || !state.recordings.length) return;
  const target = Math.max(0, Math.min(total - 1, currentLocalOffset() + offset));
  window.localTimelineSeek(target);
};

async function playNvrFile(token) {
  const data = await api(`/api/nvr-clip?token=${encodeURIComponent(token)}`, { timeoutMs: 8000 });
  if (data.status === "ready" && data.url) {
    setNvrPlayerSource(data.url, "Trecho pronto.");
    renderRecordings();
    return;
  }
  if (data.key) {
    state.nvrMessage = "Preparando trecho do NVR...";
    renderRecordings();
    pollNvrClip(data.key);
  }
}

async function pollNvrClip(key, attempt = 0) {
  try {
    const data = await api(`/api/nvr-clip-status?key=${encodeURIComponent(key)}`, { timeoutMs: 8000 });
    if (data.status === "ready" && data.url) {
      setNvrPlayerSource(data.url, "Trecho pronto.");
      renderRecordings();
      return;
    }
    state.nvrMessage = `Preparando trecho do NVR... ${Math.min(attempt + 1, 60)}s`;
    renderRecordings();
    setTimeout(() => pollNvrClip(key, attempt + 1), 2000);
  } catch (err) {
    const transient = /comunicacao|network|failed/i.test(err.message || "");
    if (transient && attempt < 10) {
      state.nvrMessage = `Preparando trecho do NVR... ${attempt + 1}s`;
      renderRecordings();
      setTimeout(() => pollNvrClip(key, attempt + 1), 2000);
      return;
    }
    state.nvrMessage = err.message || "Falha preparando trecho do NVR.";
    renderRecordings();
  }
}

function withCacheBust(url) {
  const joiner = url.includes("?") ? "&" : "?";
  return `${url}${joiner}_=${Date.now()}`;
}

function setNvrPlayerSource(url, message = "") {
  state.nvrCurrent = withCacheBust(url);
  state.nvrMessage = message;
}

function describeVideoError(player) {
  const code = player?.error?.code;
  if (code === 1) return "Carregamento do video cancelado.";
  if (code === 2) return "Falha de rede carregando video do NVR.";
  if (code === 3) return "Navegador nao conseguiu decodificar esse video.";
  if (code === 4) return "Formato do video nao suportado pelo navegador.";
  return "Falha carregando video do NVR.";
}

function activateNvrPlayer(autoplay = false) {
  const player = document.querySelector("#nvrPlayer");
  if (!player || !state.nvrCurrent) return;
  player.src = state.nvrCurrent;
  player.load();
  if (autoplay) player.play().catch(() => {});
}

function nvrDate(value) {
  return new Date(String(value || "").replace(" ", "T"));
}

function nvrFileDuration(file) {
  const start = nvrDate(file.begin).getTime();
  const end = nvrDate(file.end).getTime();
  return Math.max(1, Math.round((end - start) / 1000) || 60);
}

function nvrTotalSeconds() {
  if (!state.nvrFiles.length) return 0;
  const start = nvrDate(state.nvrFiles[0].begin).getTime();
  const end = nvrDate(state.nvrFiles[state.nvrFiles.length - 1].end).getTime();
  return Math.max(1, Math.round((end - start) / 1000));
}

function nvrOffsetForFile(index) {
  if (!state.nvrFiles[0] || !state.nvrFiles[index]) return 0;
  return Math.max(0, Math.round((nvrDate(state.nvrFiles[index].begin).getTime() - nvrDate(state.nvrFiles[0].begin).getTime()) / 1000));
}

function nvrIndexAtOffset(offset) {
  if (!state.nvrFiles.length) return 0;
  const base = nvrDate(state.nvrFiles[0].begin).getTime();
  const target = base + Math.max(0, Number(offset) || 0) * 1000;
  for (let index = 0; index < state.nvrFiles.length; index += 1) {
    const start = nvrDate(state.nvrFiles[index].begin).getTime();
    const end = nvrDate(state.nvrFiles[index].end).getTime();
    if (target >= start && target < end) return index;
  }
  return target >= nvrDate(state.nvrFiles[state.nvrFiles.length - 1].end).getTime() ? state.nvrFiles.length - 1 : 0;
}

function nvrFormatOffset(offset) {
  if (!state.nvrFiles[0]) return "";
  const start = nvrDate(state.nvrFiles[0].begin).getTime();
  return formatTimelineTime(start + Math.max(0, Number(offset) || 0) * 1000);
}

function nvrTimelineMarks(totalSeconds) {
  if (!state.nvrFiles[0] || !totalSeconds) return "";
  const start = nvrDate(state.nvrFiles[0].begin).getTime();
  const end = start + totalSeconds * 1000;
  const interval = totalSeconds <= 60 * 60 ? 2 * 60 : totalSeconds <= 4 * 60 * 60 ? 10 * 60 : 30 * 60;
  const first = Math.ceil(start / (interval * 1000)) * interval * 1000;
  const marks = [];
  for (let time = first; time < end; time += interval * 1000) {
    const left = ((time - start) / (totalSeconds * 1000)) * 100;
    if (left > 3 && left < 97) marks.push(`<span class="timeline-mark" style="left:${left.toFixed(3)}%"><i></i><b>${formatTimelineTime(time)}</b></span>`);
  }
  marks.push(alarmTimelineMarkers(start, totalSeconds, state.nvrAlarms, "window.nvrTimelineSeek"));
  return marks.join("");
}

function updateNvrSelection(index) {
  state.nvrIndex = Math.max(0, Math.min(state.nvrFiles.length - 1, Number(index) || 0));
  const offset = nvrOffsetForFile(state.nvrIndex);
  const slider = document.querySelector("#nvrTimelineRange");
  const label = document.querySelector("#nvrTimelineLabel");
  if (slider) slider.value = String(offset);
  if (label) label.textContent = nvrFormatOffset(offset);
  document.querySelectorAll(".nvr-row").forEach((row) => row.classList.toggle("active", Number(row.dataset.index) === state.nvrIndex));
  document.querySelectorAll(".nvr-select").forEach((input) => { input.checked = Number(input.value) === state.nvrIndex; });
}

window.nvrTimelinePreview = (value) => {
  const label = document.querySelector("#nvrTimelineLabel");
  if (label) label.textContent = nvrFormatOffset(value);
};

window.nvrTimelineSeek = (value) => {
  updateNvrSelection(nvrIndexAtOffset(value));
};

window.nvrSeek = (seconds) => {
  const total = nvrTotalSeconds();
  if (!total || !state.nvrFiles.length) return;
  const target = Math.max(0, Math.min(total - 1, nvrOffsetForFile(state.nvrIndex) + Number(seconds)));
  window.nvrTimelineSeek(target);
};

window.nvrLoadSelected = async () => {
  const file = state.nvrFiles[state.nvrIndex];
  if (!file) {
    setNvrMessage("Busque arquivos do NVR e selecione um trecho primeiro.");
    return;
  }
  if (Number(file.size || 0) > nvrPlayerLimitBytes) {
    renderRecordings("Arquivo do NVR muito grande para converter no player. Escolha um bloco menor.");
    return;
  }
  try {
    setNvrMessage("Solicitando trecho ao NVR...");
    await playNvrFile(file.token);
  } catch (err) {
    renderRecordings(err.message);
  }
};

window.nvrLoadFile = async (index) => {
  updateNvrSelection(index);
  await window.nvrLoadSelected();
};

window.nvrSelectFile = (index) => {
  updateNvrSelection(index);
  const file = state.nvrFiles[state.nvrIndex];
  if (file) setNvrMessage(`Selecionado: ${file.begin} - ${file.end}`);
};

function renderRecordings(error = "") {
  const defaults = defaultRecordingWindow();
  const cameraOptions = state.cameras.map((camera) => `<option value="${escapeHtml(camera.id)}">${escapeHtml(camera.name)}</option>`).join("");
  const rows = state.recordings.map((item, index) => {
    const start = new Date(item.start);
    const minutes = Math.round(Number(item.duration || 0) / 60);
    return `
      <article class="recording-row">
        <div><strong>${start.toLocaleString("pt-BR")}</strong><span>${minutes || 1} min</span></div>
        <button class="primary" type="button" onclick="window.playLocalRecording(${index})">Tocar trecho</button>
        <a class="download-link" href="${escapeHtml(item.url)}" target="_blank">Baixar</a>
      </article>`;
  }).join("");
  const totalLocalSeconds = localTotalSeconds();
  const localRangeValue = Math.max(0, Math.min(Math.round(currentLocalOffset()), Math.max(0, totalLocalSeconds - 1)));
  const localTimeline = totalLocalSeconds
    ? `<div class="timeline-range-wrap">
        <div class="timeline-marks">${localTimelineMarks(totalLocalSeconds)}</div>
        <input id="localTimelineRange" class="timeline-range" type="range" min="0" max="${Math.max(0, totalLocalSeconds - 1)}" step="1" value="${localRangeValue}" oninput="window.localTimelinePreview(this.value)" onchange="window.localTimelineSeek(this.value)">
        <div class="timeline-times"><span>${formatLocalOffset(0)}</span><strong id="localTimelineLabel">${formatLocalOffset(localRangeValue)}</strong><span>${formatLocalOffset(totalLocalSeconds)}</span></div>
      </div>`
    : '<span class="muted">Busque gravacoes para montar a linha do tempo.</span>';
  const nvrRows = state.nvrFiles.map((file, index) => {
    const mb = Math.round(Number(file.size || 0) / 1024 / 1024);
    const disabled = Number(file.size || 0) > nvrPlayerLimitBytes;
    const number = String(index + 1).padStart(3, "0");
    return `
      <tr class="nvr-row ${state.nvrIndex === index ? "active" : ""}" data-index="${index}" onclick="window.nvrSelectFile(${index})">
        <td><input class="nvr-select" type="radio" name="nvrFile" value="${index}" ${state.nvrIndex === index ? "checked" : ""} onclick="event.stopPropagation(); window.nvrSelectFile(${index})"></td>
        <td>${number}</td>
        <td><strong>${escapeHtml(file.begin)}-${escapeHtml(file.end.split(" ").pop() || file.end)}</strong><span>${escapeHtml(file.name)}</span></td>
        <td>${mb} MB</td>
        <td><button type="button" ${disabled ? "disabled" : ""} onclick="event.stopPropagation(); window.nvrLoadFile(${index})">${disabled ? "Grande" : "Carregar"}</button></td>
      </tr>`;
  }).join("");
  const totalNvrSeconds = nvrTotalSeconds();
  const nvrRangeValue = Math.max(0, Math.min(nvrOffsetForFile(state.nvrIndex), Math.max(0, totalNvrSeconds - 1)));
  const nvrTimeline = totalNvrSeconds
    ? `<div class="timeline-range-wrap">
        <div class="timeline-marks">${nvrTimelineMarks(totalNvrSeconds)}</div>
        <input id="nvrTimelineRange" class="timeline-range" type="range" min="0" max="${Math.max(0, totalNvrSeconds - 1)}" step="1" value="${nvrRangeValue}" oninput="window.nvrTimelinePreview(this.value)" onchange="window.nvrTimelineSeek(this.value)">
        <div class="timeline-times"><span>${nvrFormatOffset(0)}</span><strong id="nvrTimelineLabel">${nvrFormatOffset(nvrRangeValue)}</strong><span>${nvrFormatOffset(totalNvrSeconds)}</span></div>
      </div>`
    : '<span class="muted">Busque arquivos para montar a linha do tempo.</span>';
  shell(`
    <section class="panel">
      <h2>Gravacoes locais</h2>
      <div class="nvr-player">
        <video id="localPlayer" controls preload="metadata" src="${state.localCurrent ? escapeHtml(state.localCurrent) : ""}"></video>
        <div class="player-controls">
          <button id="localBack" type="button" onclick="window.localSeek(-60)">-1 min</button>
          <button id="localPlayPause" class="primary" type="button" onclick="window.localPlayPause()">Play/Pause</button>
          <button id="localForward" type="button" onclick="window.localSeek(60)">+1 min</button>
        </div>
        <div class="timeline local-timeline">${localTimeline}</div>
      </div>
      <form id="recordingSearch" class="recording-form">
        <label>Camera<select id="recordingCamera">${cameraOptions}</select></label>
        <label>Inicio<input id="recordingStart" type="datetime-local" value="${defaults.start}"></label>
        <label>Fim<input id="recordingEnd" type="datetime-local" value="${defaults.end}"></label>
        <button class="primary" type="submit">Buscar</button>
      </form>
      ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
      <div class="muted">Retencao local: ultimas 12 horas. Os videos sao gravados em blocos de ate 5 minutos.</div>
    </section>
    <section class="recording-list">${rows || '<div class="panel">Nenhuma gravacao local encontrada nesse periodo.</div>'}</section>
    <section class="panel">
      <h2>Arquivo NVR</h2>
      <div class="nvr-player">
        <video id="nvrPlayer" controls preload="metadata" src="${state.nvrCurrent ? escapeHtml(state.nvrCurrent) : ""}"></video>
        <div class="player-controls">
          <button id="nvrBack" type="button" onclick="window.nvrSeek(-60)">-1 min</button>
          <button id="nvrPlayPause" class="primary" type="button">Play/Pause</button>
          <button id="nvrForward" type="button" onclick="window.nvrSeek(60)">+1 min</button>
          <button class="primary" type="button" onclick="window.nvrLoadSelected()">Carregar trecho selecionado</button>
        </div>
        <div class="timeline local-timeline">${nvrTimeline}</div>
      </div>
      ${state.nvrCurrent ? `<div class="stream-links"><a target="_blank" href="${escapeHtml(state.nvrCurrent)}">Abrir video do NVR em nova aba</a></div>` : ""}
      <form id="nvrSearch" class="recording-form">
        <label>Camera<select id="nvrCamera">${cameraOptions}</select></label>
        <label>Inicio<input id="nvrStart" type="datetime-local" value="${defaults.start}"></label>
        <label>Fim<input id="nvrEnd" type="datetime-local" value="${defaults.end}"></label>
        <button class="primary" type="submit">Buscar</button>
      </form>
      <div id="nvrStatus" class="status-box ${state.nvrMessage ? "" : "hidden"}">${escapeHtml(state.nvrMessage)}</div>
      <div class="muted">Selecione o horario na linha e clique em carregar. Arquivos acima de 256 MB ficam bloqueados para evitar travar o painel.</div>
    </section>
    <section class="panel">
      <h2>Arquivos encontrados no NVR</h2>
      ${nvrRows ? `<div class="nvr-table-wrap"><table class="nvr-table"><thead><tr><th></th><th>#</th><th>Periodo</th><th>Tamanho</th><th>Ação</th></tr></thead><tbody>${nvrRows}</tbody></table></div>` : '<span class="muted">Nenhum arquivo do NVR listado ainda.</span>'}
    </section>`);
  document.querySelector("#recordingSearch").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await loadRecordings();
    } catch (err) {
      state.nvrMessage = "";
      renderRecordings(err.message);
    }
  });
  document.querySelector("#nvrSearch").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await loadNvrRecordings();
    } catch (err) {
      state.nvrMessage = err.message;
      renderRecordings();
    }
  });
  const player = document.querySelector("#nvrPlayer");
  document.querySelector("#nvrPlayPause").addEventListener("click", () => player.paused ? player.play().catch(() => setNvrMessage("Navegador nao conseguiu iniciar esse video.")) : player.pause());
  player.addEventListener("loadedmetadata", () => setNvrMessage(`Trecho carregado: ${Math.round(player.duration || 0)}s. Clique no Play do video.`), { once: true });
  player.addEventListener("playing", () => setNvrMessage("Reproduzindo trecho do NVR."), { once: true });
  player.addEventListener("error", () => setNvrMessage(describeVideoError(player)), { once: true });
  activateNvrPlayer();
}

async function loadAlarms() {
  const data = await api("/api/alarms");
  state.alarms = data.alarms || [];
  state.alarmStatus = data.status || null;
}

function cameraNameFromAlarm(alarm) {
  if (alarm.channel === null || alarm.channel === undefined) return "NVR";
  const channel = Number(alarm.channel);
  return state.cameras.find((camera) => camera.id === `camera${channel + 1}` || camera.id === `camera${channel}`)?.name || `Canal ${channel}`;
}

function renderAlarms(error = "") {
  const status = state.alarmStatus;
  const rows = state.alarms.map((alarm) => `
    <article class="alarm-row">
      <div><strong>${new Date(alarm.at).toLocaleString("pt-BR")}</strong><span>${escapeHtml(cameraNameFromAlarm(alarm))}</span></div>
      <div>${escapeHtml(alarm.type)}</div>
      <div>${alarm.active === null || alarm.active === undefined ? "-" : escapeHtml(alarm.active)}</div>
    </article>`).join("");
  shell(`
    <section class="panel">
      <h2>Alarmes</h2>
      <div class="status-line">
        <span class="status-dot ${status?.connected ? "online" : ""}"></span>
        <strong>${status?.connected ? "Monitor conectado" : "Monitor desconectado"}</strong>
        <span class="muted">${status?.lastEventAt ? `Ultimo evento: ${new Date(status.lastEventAt).toLocaleString("pt-BR")}` : "Aguardando eventos"}</span>
      </div>
      ${status?.lastError ? `<div class="error">${escapeHtml(status.lastError)}</div>` : ""}
      ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
      <button class="primary" id="refreshAlarms">Atualizar</button>
    </section>
    <section class="alarm-list">${rows || '<div class="panel">Nenhum alarme recebido ainda.</div>'}</section>`);
  document.querySelector("#refreshAlarms").addEventListener("click", async () => {
    try {
      await loadAlarms();
      renderAlarms();
    } catch (err) {
      renderAlarms(err.message);
    }
  });
}

async function loadAdmin() {
  state.admin = await api("/api/admin");
}

function cameraCheckboxes(selected = []) {
  return state.admin.cameras.map((camera) => `
    <label class="check"><input type="checkbox" name="cameras" value="${escapeHtml(camera.id)}" ${selected.includes(camera.id) ? "checked" : ""}>${escapeHtml(camera.name)}</label>`).join("");
}

function groupCheckboxes(selected = []) {
  return state.admin.groups.map((group) => `
    <label class="check group-check"><input type="checkbox" name="groups" value="${escapeHtml(group.id)}" ${selected.includes(group.id) ? "checked" : ""}>${escapeHtml(group.name)}</label>`).join("");
}

function groupOptions(selected) {
  return state.admin.groups.map((group) => `<option value="${escapeHtml(group.id)}" ${selected === group.id ? "selected" : ""}>${escapeHtml(group.name)}</option>`).join("");
}

function rtmpCameraField(camera) {
  if (!String(camera.sourceType || "").startsWith("rtmp")) {
    return '<span class="camera-source-field muted">Origem: NVR / RTSP</span>';
  }
  return `
    <label class="camera-source-field">Link RTMP para camera
      <span class="copy-field">
        <input class="camera-rtmp-link" readonly value="${escapeHtml(camera.rtmpPushUrl || "")}">
        <button class="copy-rtmp" type="button">Copiar</button>
      </span>
    </label>`;
}

function renderAdmin() {
  const groups = state.admin.groups.map((group) => {
    const groupCameras = state.admin.cameras.filter((camera) => camera.groupId === group.id);
    const cameraList = groupCameras.map((camera) => `<span class="badge">${escapeHtml(camera.name)}</span>`).join("") || '<span class="muted">Nenhuma camera neste grupo.</span>';
    return `
      <div class="group-row" data-group="${escapeHtml(group.id)}">
        <div>
          <strong>${escapeHtml(group.id)}</strong>
          <input class="group-name" value="${escapeHtml(group.name)}">
        </div>
        <div class="group-cameras">${cameraList}</div>
        <button class="save-group primary" type="button">Salvar</button>
      </div>`;
  }).join("");
  const cameras = state.admin.cameras.map((camera) => `
    <div class="camera-row" data-camera="${escapeHtml(camera.id)}" data-source-type="${escapeHtml(camera.sourceType || "rtsp")}">
      <strong>${escapeHtml(camera.id)}</strong>
      <input class="camera-name" value="${escapeHtml(camera.name)}">
      <select class="camera-group">${groupOptions(camera.groupId)}</select>
      <label class="check"><input class="camera-enabled" type="checkbox" ${camera.enabled ? "checked" : ""}>Ativa</label>
      <button class="save-camera primary">Salvar</button>
      <button class="archive-camera" type="button">${camera.enabled ? "Arquivar" : "Reativar"}</button>
      ${rtmpCameraField(camera)}
    </div>`).join("");
  const users = state.admin.users.map((user) => `
    <div class="user-row" data-user="${escapeHtml(user.id)}">
      <strong>${escapeHtml(user.username)}</strong>
      <select class="role"><option value="viewer" ${user.role === "viewer" ? "selected" : ""}>viewer</option><option value="admin" ${user.role === "admin" ? "selected" : ""}>admin</option></select>
      <div class="permission-block">
        <div class="permission-title">Grupos</div>
        <div class="camera-checks">${groupCheckboxes(user.groups || [])}</div>
        <div class="permission-title">Cameras avulsas</div>
        <div class="camera-checks">${cameraCheckboxes(user.cameras)}</div>
      </div>
      <div class="actions"><button class="save-user primary">Salvar</button><button class="toggle-user ${user.active ? "danger" : ""}">${user.active ? "Desativar" : "Ativar"}</button></div>
    </div>`).join("");
  shell(`
    <section class="panel">
      <div class="section-actions">
        <h2>Admin</h2>
        <div class="actions">
          <button type="button" onclick="window.syncIxcNow()">Sincronizar IXC</button>
          <button type="button" onclick="window.openAdminLogs()">Logs</button>
        </div>
      </div>
      <div id="ixcStatus" class="muted">IXC: ${state.admin.ixc?.enabled ? `ativo, produto ${escapeHtml(state.admin.ixc.product)}, sincroniza as ${escapeHtml(state.admin.ixc.syncHour)}:00` : "nao configurado"}</div>
    </section>
    <section class="admin-grid">
      <section class="panel">
        <h2>Cameras</h2>
        <form id="newCamera" class="compact-form">
          <label>Nova camera<input name="name" placeholder="Camera 9"></label>
          <label>Grupo<select name="groupId">${groupOptions(state.admin.groups[0]?.id)}</select></label>
          <input type="hidden" name="sourceType" value="rtmp_push">
          <button class="primary" type="submit">Adicionar</button>
        </form>
        <div class="table">${cameras}</div>
      </section>
      <section class="panel">
        <h2>Grupos</h2>
        <div class="table group-table">${groups}</div>
        <form id="newGroup" class="compact-form">
          <label>Novo grupo<input name="name" required placeholder="Recepcao, Galpao, Escritorio"></label>
          <button class="primary" type="submit">Criar</button>
        </form>
      </section>
    </section>
    <section class="panel">
      <h2>Novo usuario</h2>
      <form id="newUser" class="form-row">
        <label>Usuario<input name="username" required></label>
        <label>Senha<input name="password" type="password" required></label>
        <label>Perfil<select name="role"><option value="viewer">viewer</option><option value="admin">admin</option></select></label>
        <button class="primary" type="submit">Criar</button>
      </form>
      <div class="permission-title">Grupos liberados</div>
      <div class="camera-checks" id="newUserGroups">${groupCheckboxes([])}</div>
      <div class="permission-title">Cameras avulsas</div>
      <div class="camera-checks" id="newUserCameras">${cameraCheckboxes([])}</div>
    </section>
    <section class="panel">
      <h2>Usuarios</h2>
      <div class="table">${users}</div>
    </section>`);

  document.querySelector("#newGroup").addEventListener("submit", async (event) => {
    event.preventDefault();
    await api("/api/admin/groups", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
    await refreshAdmin();
  });

  document.querySelector("#newCamera").addEventListener("submit", async (event) => {
    event.preventDefault();
    await api("/api/admin/cameras", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
    await refreshAdmin();
  });

  document.querySelector("#newUser").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const cameras = [...document.querySelectorAll("#newUserCameras input:checked")].map((input) => input.value);
    const groups = [...document.querySelectorAll("#newUserGroups input:checked")].map((input) => input.value);
    await api("/api/admin/users", { method: "POST", body: JSON.stringify({ ...Object.fromEntries(form), cameras, groups }) });
    await refreshAdmin();
  });

  document.querySelectorAll(".camera-row").forEach((row) => {
    row.querySelector(".save-camera").addEventListener("click", async () => {
      await api(`/api/admin/cameras/${row.dataset.camera}`, {
        method: "PUT",
        body: JSON.stringify({
          name: row.querySelector(".camera-name").value,
          groupId: row.querySelector(".camera-group").value,
          enabled: row.querySelector(".camera-enabled").checked,
          sourceType: row.dataset.sourceType
        })
      });
      await refreshAdmin();
    });
    row.querySelector(".archive-camera").addEventListener("click", async () => {
      const enabled = !row.querySelector(".camera-enabled").checked;
      await api(`/api/admin/cameras/${row.dataset.camera}`, {
        method: "PUT",
        body: JSON.stringify({
          name: row.querySelector(".camera-name").value,
          groupId: row.querySelector(".camera-group").value,
          enabled,
          sourceType: row.dataset.sourceType
        })
      });
      await refreshAdmin();
    });
    row.querySelector(".copy-rtmp")?.addEventListener("click", async () => {
      const input = row.querySelector(".camera-rtmp-link");
      input.select();
      await navigator.clipboard?.writeText(input.value).catch(() => document.execCommand("copy"));
    });
  });

  document.querySelectorAll(".group-row").forEach((row) => {
    row.querySelector(".save-group").addEventListener("click", async () => {
      await api(`/api/admin/groups/${row.dataset.group}`, {
        method: "PUT",
        body: JSON.stringify({ name: row.querySelector(".group-name").value })
      });
      await refreshAdmin();
    });
  });

  document.querySelectorAll(".user-row").forEach((row) => {
    const id = row.dataset.user;
    const user = state.admin.users.find((item) => item.id === id);
    row.querySelector(".save-user").addEventListener("click", async () => {
      const cameras = [...row.querySelectorAll('input[name="cameras"]:checked')].map((input) => input.value);
      const groups = [...row.querySelectorAll('input[name="groups"]:checked')].map((input) => input.value);
      await api(`/api/admin/users/${id}`, { method: "PUT", body: JSON.stringify({ role: row.querySelector(".role").value, cameras, groups }) });
      await refreshAdmin();
    });
    row.querySelector(".toggle-user").addEventListener("click", async () => {
      await api(`/api/admin/users/${id}`, { method: "PUT", body: JSON.stringify({ active: !user.active }) });
      await refreshAdmin();
    });
  });
}

window.openAdminLogs = async () => {
  state.tab = "adminLogs";
  if (!state.admin) await loadAdmin();
  renderAdminLogs();
};

window.syncIxcNow = async () => {
  const status = document.querySelector("#ixcStatus");
  if (status) status.textContent = "IXC: sincronizando...";
  try {
    const result = await api("/api/admin/ixc-sync", { method: "POST", body: "{}" });
    const s = result.summary || {};
    if (status) status.textContent = `IXC: sincronizado. Criados ${s.created || 0}, atualizados ${s.updated || 0}, desativados ${s.disabled || 0}, ignorados ${s.skipped || 0}.`;
    await loadAdmin();
  } catch (err) {
    if (status) status.textContent = `IXC: ${err.message}`;
  }
};

window.backToAdmin = async () => {
  state.tab = "admin";
  if (!state.admin) await loadAdmin();
  renderAdmin();
};

function renderAdminLogs() {
  const audit = (state.admin?.audit || []).map((item) => `<div class="audit-row"><span>${new Date(item.at).toLocaleString("pt-BR")}</span><strong>${escapeHtml(item.action)}</strong><span>${escapeHtml(item.username || item.camera || item.group || "")}</span><span>${escapeHtml(item.by || "")}</span></div>`).join("");
  shell(`
    <section class="panel">
      <div class="section-actions">
        <h2>Logs</h2>
        <button type="button" onclick="window.backToAdmin()">Voltar ao Admin</button>
      </div>
      <div class="audit-table">${audit || '<span class="muted">Sem logs ainda.</span>'}</div>
    </section>`);
}

async function refreshAdmin() {
  await loadAdmin();
  state.groups = state.admin.groups;
  state.cameras = state.admin.cameras.filter((camera) => camera.enabled);
  renderAdmin();
}

function render() {
  if (!state.user) return renderLogin();
  if (state.tab === "admin") return renderAdmin();
  if (state.tab === "adminLogs") return renderAdminLogs();
  if (state.tab === "recordings") return renderRecordings();
  if (state.tab === "alarms") return renderAlarms();
  renderLive();
}

async function boot() {
  try {
    const data = await api("/api/me");
    state.user = data.user;
    state.cameras = data.cameras;
    state.groups = data.groups || [];
    render();
  } catch {
    renderLogin();
  }
}

boot();
