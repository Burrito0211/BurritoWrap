// BurritoWrap client.
//
// How the pairing code works:
//   code (12 chars, shown as XXXX-XXXX-XXXX, ~60 bits of randomness)
//     ├─ SHA-256  → room id   (sent to the server, used to group devices)
//     └─ PBKDF2   → AES key   (never leaves the browser)
// The server only ever sees the room id and encrypted blobs.

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32: no I, L, O, U
const CODE_LEN = 12;
const STORAGE_KEY = "burritowrap:code";

const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();
const dec = new TextDecoder();

let state = null; // { code, roomId, key, ws, clips: Map, retry, pingTimer, closed }

// ---------- Pairing code ----------

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LEN));
  return Array.from(bytes, (b) => ALPHABET[b & 31]).join("");
}

// Accepts user input like "abcd efgh-1jk0" and returns "ABCDEFGH1JK0", or null.
function normalizeCode(input) {
  const s = String(input || "")
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (s.length !== CODE_LEN) return null;
  for (const ch of s) if (!ALPHABET.includes(ch)) return null;
  return s;
}

const formatCode = (c) => c.match(/.{1,4}/g).join("-");

// ---------- Crypto ----------

const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveRoomId(code) {
  const hash = await crypto.subtle.digest("SHA-256", enc.encode("burritowrap-room:" + code));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function deriveKey(code) {
  const base = await crypto.subtle.importKey("raw", enc.encode(code), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: enc.encode("burritowrap-key-v1"), iterations: 200000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encrypt(key, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify({ text })));
  return { iv: toB64(iv), data: toB64(data) };
}

async function decrypt(key, clip) {
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(clip.iv) }, key, fromB64(clip.data));
    return JSON.parse(dec.decode(plain)).text;
  } catch {
    return null; // wrong key or corrupted
  }
}

// ---------- Storage (best effort; may be unavailable) ----------

function remember(code) {
  try { code ? localStorage.setItem(STORAGE_KEY, code) : localStorage.removeItem(STORAGE_KEY); } catch {}
}
function recall() {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
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
  toast("Copied");
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
    li.className = "clip" + (clip.text == null ? " unreadable" : "") + (clip.id === newId ? " new" : "");

    const pre = document.createElement("pre");
    pre.textContent = clip.text ?? "Couldn't decrypt this clip.";
    li.appendChild(pre);

    const foot = document.createElement("div");
    foot.className = "clip-foot";
    const time = document.createElement("time");
    time.dataset.ts = clip.ts;
    time.textContent = timeAgo(clip.ts);
    foot.appendChild(time);

    const actions = document.createElement("div");
    actions.className = "row";
    if (clip.text != null) {
      const copy = document.createElement("button");
      copy.className = "small primary";
      copy.textContent = "Copy";
      copy.onclick = () => copyText(clip.text);
      actions.appendChild(copy);
    }
    const del = document.createElement("button");
    del.className = "small ghost";
    del.textContent = "Delete";
    del.onclick = () => send({ type: "delete", id: clip.id });
    actions.appendChild(del);
    foot.appendChild(actions);

    li.appendChild(foot);
    list.appendChild(li);
  }
}

setInterval(() => {
  document.querySelectorAll("time[data-ts]").forEach((t) => (t.textContent = timeAgo(+t.dataset.ts)));
}, 15000);

function showQR() {
  const box = $("qr");
  if (!box.hidden) { box.hidden = true; return; }
  const qr = qrcode(0, "M");
  qr.addData(shareLink());
  qr.make();
  box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  box.hidden = false;
}

const shareLink = () => `${location.origin}/#${formatCode(state.code)}`;

// ---------- Connection ----------

function send(msg) {
  if (state?.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(msg));
    return true;
  }
  toast("Not connected — retrying…");
  return false;
}

async function addClip(raw, isNew) {
  const text = await decrypt(state.key, raw);
  state.clips.set(raw.id, { id: raw.id, ts: raw.ts, text });
  return isNew ? raw.id : null;
}

function connect() {
  const s = state;
  if (!s || s.closed) return;

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws/${s.roomId}`);
  s.ws = ws;
  setStatus("wait", "Connecting…");

  ws.onopen = () => {
    s.retry = 0;
    clearInterval(s.pingTimer);
    // Keep the connection alive through proxies and mobile networks.
    s.pingTimer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 30000);
  };

  ws.onmessage = async (e) => {
    if (e.data === "pong" || state !== s) return;
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    if (msg.type === "history") {
      s.clips.clear();
      for (const c of msg.clips) await addClip(c, false);
      renderClips();
    } else if (msg.type === "clip") {
      const id = await addClip(msg.clip, true);
      renderClips(id);
    } else if (msg.type === "delete") {
      s.clips.delete(msg.id);
      renderClips();
    } else if (msg.type === "clear") {
      s.clips.clear();
      renderClips();
    } else if (msg.type === "presence") {
      const n = msg.devices;
      setStatus("ok", n === 1 ? "Connected · only this device" : `Connected · ${n} devices`);
    } else if (msg.type === "error") {
      toast(msg.message);
    }
  };

  ws.onclose = () => {
    clearInterval(s.pingTimer);
    if (s.closed || state !== s) return;
    // Reconnect with backoff: 1s, 2s, 4s … up to 15s
    const delay = Math.min(15000, 1000 * 2 ** s.retry++);
    setStatus("bad", "Offline · reconnecting");
    setTimeout(connect, delay);
  };
}

// Reconnect quickly when a phone comes back from sleep or the network returns.
function nudge() {
  if (state && !state.closed && state.ws?.readyState !== WebSocket.OPEN && state.ws?.readyState !== WebSocket.CONNECTING) {
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
  $("join-error").hidden = true;
}

async function enterRoom(code) {
  leaveRoom(false);
  $("start").hidden = true;
  $("room").hidden = false;
  $("qr").hidden = true;
  $("code").textContent = formatCode(code);
  $("clips").textContent = "";
  $("empty").hidden = false;
  $("clear").hidden = true;
  setStatus("wait", "Preparing…");

  history.replaceState(null, "", "#" + formatCode(code));
  remember(code);

  const [roomId, key] = await Promise.all([deriveRoomId(code), deriveKey(code)]);
  state = { code, roomId, key, ws: null, clips: new Map(), retry: 0, pingTimer: null, closed: false };
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
    remember(null);
    history.replaceState(null, "", location.pathname);
    showStart();
  }
}

// ---------- Events ----------

$("create").onclick = () => enterRoom(newCode());

$("join-form").onsubmit = (e) => {
  e.preventDefault();
  const code = normalizeCode($("join-code").value);
  if (!code) {
    $("join-error").textContent = "That code doesn't look right. It should be 12 letters/numbers.";
    $("join-error").hidden = false;
    return;
  }
  $("join-code").value = "";
  enterRoom(code);
};

$("send-form").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("text").value;
  if (!text.trim() || !state) return;
  const payload = await encrypt(state.key, text);
  if (send({ type: "clip", id: crypto.randomUUID(), ...payload })) {
    $("text").value = "";
  }
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
    toast("Clipboard access was blocked — paste into the box instead");
    $("text").focus();
  }
};

$("show-qr").onclick = showQR;
$("copy-link").onclick = () => copyText(shareLink());
$("leave").onclick = () => leaveRoom(true);
$("clear").onclick = () => {
  if (confirm("Delete all clips on every device?")) send({ type: "clear" });
};

window.addEventListener("hashchange", () => {
  const code = normalizeCode(decodeURIComponent(location.hash.slice(1)));
  if (code && code !== state?.code) enterRoom(code);
});

// ---------- Start ----------

const fromHash = normalizeCode(decodeURIComponent(location.hash.slice(1)));
const initial = fromHash || normalizeCode(recall());
initial ? enterRoom(initial) : showStart();
