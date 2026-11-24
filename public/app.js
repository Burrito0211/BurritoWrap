// BurritoWrap client.
//
// A room is just a number (4 to 8 digits). Every device that opens the same
// number joins the same room: wrap.burrito.rip/1234 → WebSocket /ws/1234.

const MIN_LEN = 4;
const MAX_LEN = 8;
const ROOM_KEY = "burritowrap:room";
const THEME_KEY = "burritowrap:theme";

const $ = (id) => document.getElementById(id);

let state = null; // { code, ws, clips: Map, retry, pingTimer, closed }

// ---------- Room numbers ----------

// "12 34" → "1234"; returns null unless it is 4–8 digits.
function normalizeCode(input) {
  const s = String(input || "").replace(/\D/g, "");
  return s.length >= MIN_LEN && s.length <= MAX_LEN ? s : null;
}

function randomDigits(len) {
  const bytes = crypto.getRandomValues(new Uint32Array(len));
  return Array.from(bytes, (b) => b % 10).join("");
}

// Ask the server whether a room already has devices or clips in it.
async function roomInUse(code) {
  const res = await fetch(`/api/rooms/${code}`);
  if (res.status === 429) throw new Error("Too many tries. Wait a minute and try again.");
  if (!res.ok) throw new Error("Couldn't reach the server.");
  return (await res.json()).inUse;
}

// Pick a random 4-digit room nobody is using (5 digits if we're unlucky).
async function pickFreeRoom() {
  for (let i = 0; i < 8; i++) {
    const code = randomDigits(i < 5 ? 4 : 5);
    if (!(await roomInUse(code))) return code;
  }
  return randomDigits(6);
}

const roomFromPath = () => normalizeCode(location.pathname.slice(1));
const shareLink = () => `${location.origin}/${state.code}`;

// ---------- Storage (best effort; may be unavailable) ----------

function save(key, value) {
  try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch {}
}
function load(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

// ---------- UI helpers ----------

let toastTimer;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 1800);
}

function setStatus(kind, text) {
  const el = $("status");
  el.hidden = false;
  el.className = "status " + kind;
  el.textContent = text;
}

function showJoinError(msg) {
  $("join-error").textContent = msg;
  $("join-error").hidden = !msg;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for browsers without the async clipboard API
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  toast("Copied!");
}

function timeAgo(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  return Math.floor(s / 3600) + "h ago";
}

function renderClips(newId) {
  const list = $("clips");
  list.textContent = "";
  const clips = [...state.clips.values()].sort((a, b) => b.ts - a.ts);
  $("empty").hidden = clips.length > 0;
  $("clear").hidden = clips.length === 0;

  for (const clip of clips) {
    const li = document.createElement("li");
    li.className = "clip" + (clip.id === newId ? " new" : "");

    const pre = document.createElement("pre");
    pre.textContent = clip.text; // textContent, never innerHTML: clips are untrusted
    li.appendChild(pre);

    const foot = document.createElement("div");
    foot.className = "clip-foot";
    const time = document.createElement("time");
    time.dataset.ts = clip.ts;
    time.textContent = timeAgo(clip.ts);
    foot.appendChild(time);

    const actions = document.createElement("div");
    actions.className = "row";
    const copy = document.createElement("button");
    copy.className = "btn small primary";
    copy.textContent = "Copy";
    copy.onclick = () => copyText(clip.text);
    const del = document.createElement("button");
    del.className = "btn small ghost";
    del.textContent = "Delete";
    del.onclick = () => send({ type: "delete", id: clip.id });
    actions.append(copy, del);
    foot.appendChild(actions);

    li.appendChild(foot);
    list.appendChild(li);
  }
}

setInterval(() => {
  document.querySelectorAll("time[data-ts]").forEach((t) => (t.textContent = timeAgo(+t.dataset.ts)));
}, 15000);

function toggleQR() {
  const box = $("qr");
  if (!box.hidden) { box.hidden = true; return; }
  const qr = qrcode(0, "M");
  qr.addData(shareLink());
  qr.make();
  box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  box.hidden = false;
}

// ---------- Connection ----------

function send(msg) {
  if (state?.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(msg));
    return true;
  }
  toast("Not connected. Retrying…");
  return false;
}

function connect() {
  const s = state;
  if (!s || s.closed) return;

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws/${s.code}`);
  s.ws = ws;
  setStatus("wait", "Connecting…");

  ws.onopen = () => {
    s.retry = 0;
    clearInterval(s.pingTimer);
    // Keep the connection alive through proxies and mobile networks.
    s.pingTimer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 30000);
  };

  ws.onmessage = (e) => {
    if (e.data === "pong" || state !== s) return;
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    if (msg.type === "history") {
      s.clips = new Map(msg.clips.map((c) => [c.id, c]));
      renderClips();
    } else if (msg.type === "clip") {
      s.clips.set(msg.clip.id, msg.clip);
      renderClips(msg.clip.id);
    } else if (msg.type === "delete") {
      s.clips.delete(msg.id);
      renderClips();
    } else if (msg.type === "clear") {
      s.clips.clear();
      renderClips();
    } else if (msg.type === "presence") {
      const n = msg.devices;
      setStatus("ok", n === 1 ? "Online · 1 device" : `Online · ${n} devices`);
    } else if (msg.type === "error") {
      toast(msg.message);
    }
  };

  ws.onclose = () => {
    clearInterval(s.pingTimer);
    if (s.closed || state !== s) return;
    // Reconnect with backoff: 1s, 2s, 4s … up to 15s
    const delay = Math.min(15000, 1000 * 2 ** s.retry++);
    setStatus("bad", "Offline · retrying");
    setTimeout(connect, delay);
  };
}

// Reconnect quickly when a phone comes back from sleep or the network returns.
function nudge() {
  const ws = state?.ws;
  if (state && !state.closed && ws?.readyState !== WebSocket.OPEN && ws?.readyState !== WebSocket.CONNECTING) {
    state.retry = 0;
    connect();
  }
}
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && nudge());
window.addEventListener("online", nudge);

// ---------- Screens ----------

function showStart() {
  $("room").hidden = true;
  $("start").hidden = false;
  $("status").hidden = true;
  showJoinError("");
  $("join-code").focus();
}

function enterRoom(code) {
  leaveRoom(false);
  $("start").hidden = true;
  $("room").hidden = false;
  $("qr").hidden = true;
  $("code").textContent = code;
  $("room-link").textContent = `${location.host}/${code}`;
  $("clips").textContent = "";
  $("empty").hidden = false;
  $("clear").hidden = true;

  if (location.pathname !== "/" + code) history.pushState(null, "", "/" + code);
  save(ROOM_KEY, code);

  state = { code, ws: null, clips: new Map(), retry: 0, pingTimer: null, closed: false };
  connect();
}

function leaveRoom(goHome = true) {
  if (state) {
    state.closed = true;
    clearInterval(state.pingTimer);
    try { state.ws?.close(); } catch {}
    state = null;
  }
  if (goHome) {
    save(ROOM_KEY, null);
    if (location.pathname !== "/") history.pushState(null, "", "/");
    showStart();
  }
}

// ---------- Theme (follows the device until you pick one) ----------

const SUN = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M7 0h2v3H7zM7 13h2v3H7zM0 7h3v2H0zM13 7h3v2h-3zM2 2h2v2H2zM12 2h2v2h-2zM2 12h2v2H2zM12 12h2v2h-2zM5 4h6v1h1v6h-1v1H5v-1H4V5h1z"/></svg>';
const MOON = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M6 1h4v1H8v1H7v2H6v4h1v2h1v1h2v1h4v1h-1v1h-2v1H6v-1H4v-1H3v-1H2v-2H1V6h1V4h1V3h1V2h2z"/></svg>';

const isNight = () =>
  document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === "dark"
    : matchMedia("(prefers-color-scheme: dark)").matches;

function paintToggle() {
  const night = isNight();
  const btn = $("theme-toggle");
  btn.classList.toggle("night", night);
  // Show what you'll switch to, like on burrito.rip
  btn.querySelector(".theme-icon").innerHTML = night ? SUN : MOON;
  btn.querySelector(".theme-label").textContent = night ? "Light" : "Dark";
}

$("theme-toggle").onclick = () => {
  const next = isNight() ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  save(THEME_KEY, next);
  paintToggle();
};
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", paintToggle);
paintToggle();

// ---------- Events ----------

$("join-code").addEventListener("input", (e) => {
  e.target.value = e.target.value.replace(/\D/g, "").slice(0, MAX_LEN);
  showJoinError("");
});

$("join-form").onsubmit = (e) => {
  e.preventDefault();
  const code = normalizeCode($("join-code").value);
  if (!code) return showJoinError(`Room numbers are ${MIN_LEN} to ${MAX_LEN} digits.`);
  $("join-code").value = "";
  enterRoom(code);
};

$("random").onclick = async () => {
  const btn = $("random");
  btn.disabled = true;
  showJoinError("");
  try {
    enterRoom(await pickFreeRoom());
  } catch (err) {
    showJoinError(err.message);
  } finally {
    btn.disabled = false;
  }
};

$("send-form").onsubmit = (e) => {
  e.preventDefault();
  const text = $("text").value;
  if (!text.trim() || !state) return;
  if (send({ type: "clip", text })) $("text").value = "";
};

$("text").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("send-form").requestSubmit();
});

$("paste").onclick = async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) return toast("Clipboard is empty");
    $("text").value = text;
    $("send-form").requestSubmit();
  } catch {
    toast("Clipboard access blocked. Paste into the box instead.");
    $("text").focus();
  }
};

$("show-qr").onclick = toggleQR;
$("copy-link").onclick = () => copyText(shareLink());
$("leave").onclick = () => leaveRoom(true);
$("clear").onclick = () => {
  if (confirm("Delete all clips on every device?")) send({ type: "clear" });
};

// Back/forward buttons move between rooms and the start screen.
window.addEventListener("popstate", () => {
  const code = roomFromPath();
  if (code) { if (code !== state?.code) enterRoom(code); }
  else leaveRoom(true);
});

// ---------- Start ----------

const initial = roomFromPath() || normalizeCode(load(ROOM_KEY));
if (initial) enterRoom(initial);
else {
  if (location.pathname !== "/") history.replaceState(null, "", "/");
  showStart();
}
