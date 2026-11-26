// BurritoWrap client.
//
// A room is just a number (exactly 4 digits). Every device that opens the same
// number joins the same room: wrap.burrito.rip/1234 → WebSocket /ws/1234.

const MIN_LEN = 4;
const MAX_LEN = 4;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // must match src/worker.js
const PREVIEW_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const ROOM_KEY = "burritowrap:room";
const THEME_KEY = "burritowrap:theme";

const $ = (id) => document.getElementById(id);

let state = null; // { code, ws, clips: Map, retry, pingTimer, closed }

// ---------- Room numbers ----------

// "12 34" → "1234"; returns null unless it is exactly 4 digits.
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

// Pick a random 4-digit room nobody is using.
async function pickFreeRoom() {
  for (let i = 0; i < 6; i++) {
    const code = randomDigits(4);
    if (!(await roomInUse(code))) return code;
  }
  throw new Error("Couldn't find a free room. Try again, or type a number.");
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

// Restart a CSS animation class on an element, even if it is already running.
function replay(node, cls) {
  if (!node) return;
  node.classList.remove(cls);
  void node.offsetWidth; // force a reflow so the animation starts over
  node.classList.add(cls);
}

let toastTimer;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  el.classList.remove("out");
  replay(el, "in");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.add("out"); // slide away, then hide
    toastTimer = setTimeout(() => { el.hidden = true; el.classList.remove("out"); }, 200);
  }, 1800);
}

// Briefly swap a button's label (e.g. "Copy" → "Copied ✓") with a green flash.
function confirmButton(btn, label) {
  if (!btn) return;
  if (btn.dataset.label == null) btn.dataset.label = btn.textContent;
  btn.textContent = label;
  btn.classList.add("done");
  clearTimeout(btn.doneTimer);
  btn.doneTimer = setTimeout(() => {
    btn.textContent = btn.dataset.label;
    delete btn.dataset.label;
    btn.classList.remove("done");
  }, 1300);
}

// Every button gets a little squash-and-bounce when clicked.
document.addEventListener("click", (e) => {
  const btn = e.target.closest?.("button, a.btn");
  if (btn && !btn.disabled) replay(btn, "pop");
});

function setStatus(kind, text) {
  const el = $("status");
  el.hidden = false;
  el.className = "status " + kind;
  el.textContent = text;
}

function showJoinError(msg) {
  $("join-error").textContent = msg;
  $("join-error").hidden = !msg;
  if (msg) replay($("join-code"), "shake");
}

async function copyText(text, btn) {
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
  confirmButton(btn, "Copied ✓");
}

function timeAgo(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  return Math.floor(s / 3600) + "h ago";
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

// ---------- Markdown ----------

marked.setOptions({ gfm: true, breaks: true });
// Links open in a new tab and can't reach back into this page.
// Task-list checkboxes (- [ ] item) stay, read-only; any other input is removed.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  } else if (node.tagName === "INPUT") {
    if (node.getAttribute("type") === "checkbox") node.setAttribute("disabled", "");
    else node.remove();
  }
});

// Clips come from anyone who knows the room number, so the HTML marked
// produces is cleaned by DOMPurify before it touches the page. Remote images
// are blocked too: they could reveal your IP address to whoever posted them.
function renderMarkdown(text) {
  return DOMPurify.sanitize(marked.parse(text), { FORBID_TAGS: ["img", "style", "form", "button", "select", "textarea"] });
}

// ---------- Clip list ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(label, className, onclick) {
  const b = el("button", "btn small " + className, label);
  b.onclick = onclick;
  return b;
}

const fileUrl = (clip) => `/api/rooms/${state.code}/files/${clip.id}`;

// `stagger` fades the whole list in one by one (used when a room first loads).
function renderClips(newId, stagger = false) {
  const list = $("clips");
  list.textContent = "";
  const clips = [...state.clips.values()].sort((a, b) => b.ts - a.ts);
  $("empty").hidden = clips.length > 0;
  $("clear").hidden = clips.length === 0;
  $("clip-count").textContent = clips.length ? `(${clips.length})` : "";

  clips.forEach((clip, i) => {
    const isFile = clip.kind === "file";
    const li = el("li", "clip" + (isFile ? " file" : "") + (clip.id === newId ? " new" : "") + (stagger ? " enter" : ""));
    if (stagger) li.style.setProperty("--i", Math.min(i, 10));
    const actions = el("div", "row");

    if (isFile) {
      const url = fileUrl(clip);
      if (PREVIEW_TYPES.has(clip.type)) {
        const link = el("a", "preview");
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener";
        const img = el("img");
        img.src = url;
        img.alt = clip.name;
        img.loading = "lazy";
        link.appendChild(img);
        li.appendChild(link);
        actions.appendChild(button("Copy", "primary", (e) => copyImage(url, e.currentTarget)));
      }
      const info = el("div", "file-info");
      info.append(el("span", "file-icon", "▤"), el("span", "file-name", clip.name), el("span", "file-size", formatSize(clip.size)));
      li.appendChild(info);
      const dl = el("a", "btn small" + (PREVIEW_TYPES.has(clip.type) ? "" : " primary"), "Download");
      dl.href = url;
      dl.download = clip.name;
      actions.appendChild(dl);
    } else {
      const body = el("div", "md");
      body.innerHTML = renderMarkdown(clip.text);
      li.appendChild(body);
      actions.appendChild(button("Copy", "primary", (e) => copyText(clip.text, e.currentTarget)));
    }

    // Slide the clip away first, then tell the room to delete it.
    actions.appendChild(button("Delete", "ghost", () => {
      li.classList.add("leaving");
      setTimeout(() => { if (!send({ type: "delete", id: clip.id })) li.classList.remove("leaving"); }, 220);
    }));

    const foot = el("div", "clip-foot");
    const time = el("time", null, timeAgo(clip.ts));
    time.dataset.ts = clip.ts;
    foot.append(time, actions);
    li.appendChild(foot);
    list.appendChild(li);
  });
}

// Copy an uploaded image to the clipboard. Browsers only accept PNG here, so
// other formats are redrawn as PNG first. The ClipboardItem gets a promise so
// Safari still treats the copy as part of the click.
async function copyImage(url, btn) {
  const png = (async () => {
    const blob = await (await fetch(url)).blob();
    if (blob.type === "image/png") return blob;
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  })();
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    toast("Image copied!");
    confirmButton(btn, "Copied ✓");
  } catch {
    toast("This browser can't copy images. Use Download instead.");
  }
}

// ---------- Uploads ----------

// Screenshots arrive as "image.png"; give them a useful name instead.
function nameFor(file) {
  if (file.name && file.name !== "image.png") return file.name;
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ext = (file.type.split("/")[1] || "png").replace("jpeg", "jpg");
  return `screenshot-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${ext}`;
}

function uploadFiles(files) {
  for (const file of files) uploadFile(file);
}

// Uses XMLHttpRequest instead of fetch because it reports upload progress.
function uploadFile(file) {
  if (!state) return;
  const name = nameFor(file);
  if (file.size > MAX_FILE_BYTES) return toast(`${name} is over 10 MB`);
  if (file.size === 0) return toast(`${name} is empty`);

  const box = $("uploads");
  const row = el("div", "upload");
  const label = el("span", "upload-name", name);
  const bar = el("span", "upload-bar");
  const fill = el("span", "upload-fill");
  bar.appendChild(fill);
  row.append(label, bar);
  box.appendChild(row);
  box.hidden = false;

  const done = (ok) => {
    const finish = () => {
      row.remove();
      box.hidden = box.childElementCount === 0;
    };
    if (!ok) return finish();
    fill.style.width = "100%";
    row.classList.add("complete"); // flash the bar green, then fade the row out
    setTimeout(finish, 450);
  };

  const xhr = new XMLHttpRequest();
  xhr.open("POST", `/api/rooms/${state.code}/files`);
  xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
  xhr.setRequestHeader("X-File-Name", encodeURIComponent(name));
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) fill.style.width = Math.round((e.loaded / e.total) * 100) + "%";
  };
  xhr.onload = () => {
    done(xhr.status < 300);
    if (xhr.status >= 300) toast(xhr.responseText || "Upload failed");
  };
  xhr.onerror = () => {
    done(false);
    toast("Upload failed. Check your connection.");
  };
  xhr.send(file);
}

setInterval(() => {
  document.querySelectorAll("time[data-ts]").forEach((t) => (t.textContent = timeAgo(+t.dataset.ts)));
}, 15000);

function toggleQR() {
  const box = $("qr");
  const open = box.hidden;
  if (open) {
    const qr = qrcode(0, "M");
    qr.addData(shareLink());
    qr.make();
    $("qr-code").innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  }
  box.hidden = !open;
  $("show-qr").setAttribute("aria-expanded", String(open));
}

// ---------- Composer folding (remembered per device) ----------

const COMPOSE_KEY = "burritowrap:compose";

function setComposer(open, focus = false) {
  $("compose-body").hidden = !open;
  $("compose-toggle").setAttribute("aria-expanded", String(open));
  $("send-form").classList.toggle("open", open);
  save(COMPOSE_KEY, open ? "open" : "closed");
  if (open && focus) $("text").focus();
}

$("compose-toggle").onclick = () => setComposer($("compose-body").hidden, true);
setComposer(load(COMPOSE_KEY) === "open");

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
      renderClips(null, true);
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
    } else if (msg.type === "destroyed") {
      roomDestroyed(s);
    } else if (msg.type === "error") {
      toast(msg.message);
    }
  };

  ws.onclose = (e) => {
    clearInterval(s.pingTimer);
    if (s.closed || state !== s) return;
    if (e.code === 4000) return roomDestroyed(s); // missed the message, but the room is gone
    // Reconnect with backoff: 1s, 2s, 4s … up to 15s
    const delay = Math.min(15000, 1000 * 2 ** s.retry++);
    setStatus("bad", "Offline · retrying");
    setTimeout(connect, delay);
  };
}

// Someone pressed Destroy: stop reconnecting, play the burrito wrap-up, then go home.
function roomDestroyed(s) {
  if (s.closed) return;
  s.closed = true;
  clearInterval(s.pingTimer);
  playWrapUp(s.code, () => { if (state === s) leaveRoom(true); });
}

// Wrap the whole page up like a burrito. The visible part of the page is the
// tortilla: it shrinks into a sheet, the left and right sides fold over it,
// it rolls into a burrito, gets foil on one end, wobbles and zips away.
const WRAP_MS = 2800;

function playWrapUp(code, then) {
  const msg = $("wrapup");
  $("wrap-code").textContent = code;
  msg.classList.remove("out");
  msg.hidden = false; // also blocks clicks while the page wraps

  const finish = () => {
    then();
    $("start").classList.remove("arrive");
    if (!$("start").hidden) replay($("start"), "arrive");
    msg.classList.add("out");
    setTimeout(() => { msg.hidden = true; msg.classList.remove("out"); }, 300);
  };

  if (matchMedia("(prefers-reduced-motion: reduce)").matches || !Element.prototype.animate) {
    setTimeout(finish, 1500); // just show the message, no motion
    return;
  }

  const main = document.querySelector("main");
  document.body.classList.add("wrapping");

  // Measure the part of the page that's on screen; that's what gets wrapped.
  const r = main.getBoundingClientRect();
  const top = Math.max(0, -r.top);
  const bottom = Math.max(0, r.bottom - innerHeight);
  const h = r.height - top - bottom;
  const cx = innerWidth / 2 - r.left;
  const cy = top + h / 2;
  const band = Math.min(h * 0.6, r.width * 0.3); // the rolled burrito's thickness

  // Tortilla flaps and foil, laid over the visible part of the page
  const layer = el("div", "wrap-layer");
  layer.style.top = top + "px";
  layer.style.height = h + "px";
  const left = el("div", "wrap-flap left");
  const right = el("div", "wrap-flap right");
  const foil = el("div", "wrap-foil");
  foil.innerHTML = "WRAP<b>.</b>";
  foil.style.top = h / 2 - band / 2 + "px";
  foil.style.height = band + "px";
  layer.append(left, right, foil);
  main.appendChild(layer);

  const sheet = `inset(${top}px 0px ${bottom}px 0px round 0px)`;
  const card = `inset(${top}px 0px ${bottom}px 0px round 28px)`;
  const rolled = `inset(${cy - band / 2}px 0px ${r.height - cy - band / 2}px 0px round ${band / 2}px)`;
  const tilt = "scale(0.62) rotate(-12deg)";

  main.style.transformOrigin = `${cx}px ${cy}px`;
  const anims = [
    main.animate([
      { offset: 0,    transform: "none",        clipPath: sheet,  opacity: 1, easing: "cubic-bezier(.3,1.3,.5,1)" },
      { offset: 0.16, transform: "scale(0.6)",  clipPath: card },                          // page → sheet
      { offset: 0.32, transform: "scale(0.6)",  clipPath: card,   easing: "cubic-bezier(.5,0,.3,1.3)" },
      { offset: 0.5,  transform: tilt,          clipPath: rolled },                        // roll up
      { offset: 0.58, transform: "scale(0.62) rotate(-4deg) translateY(-12px)", clipPath: rolled },
      { offset: 0.66, transform: "scale(0.62) rotate(-18deg) translateY(-4px)", clipPath: rolled },
      { offset: 0.74, transform: tilt,          clipPath: rolled },                        // wobble
      { offset: 0.84, transform: "scale(0.66) rotate(-9deg) translateY(14px)", clipPath: rolled, opacity: 1, easing: "ease-in" },
      { offset: 1,    transform: "translateY(-75vh) scale(0.08) rotate(25deg)", clipPath: rolled, opacity: 0 },
    ], { duration: WRAP_MS, fill: "forwards" }),
    // left side folds over, then the right
    left.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }],
      { duration: 260, delay: 450, fill: "forwards", easing: "ease-out" }),
    right.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }],
      { duration: 260, delay: 620, fill: "forwards", easing: "ease-out" }),
    // foil wraps one end once it's rolled
    foil.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }],
      { duration: 240, delay: 1420, fill: "forwards", easing: "ease-out" }),
  ];

  setTimeout(() => {
    finish(); // switch to the home page first, so the reset is never visible
    anims.forEach((a) => a.cancel());
    layer.remove();
    main.style.transformOrigin = "";
    document.body.classList.remove("wrapping");
  }, WRAP_MS + 50);
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
  $("show-qr").setAttribute("aria-expanded", "false");
  $("clip-count").textContent = "";
  $("code").textContent = code;
  replay($("code"), "pop-in");
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
  replay($("theme-toggle").querySelector(".theme-icon"), "spin");
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
  if (!code) return showJoinError(`Room numbers are ${MAX_LEN} digits.`);
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
  if (!text.trim() || !state) {
    replay($("text"), "shake");
    return;
  }
  if (send({ type: "clip", text })) {
    $("text").value = "";
    confirmButton($("send-form").querySelector("[type=submit]"), "Sent ✓");
  }
};

// Enter sends, Shift+Enter starts a new line. Phones have no Shift key, so
// there Enter adds a line and the Send button sends.
// Enter while an input method (e.g. Chinese/Japanese) is picking characters
// only confirms the characters, so it never sends.
const touchOnly = matchMedia("(hover: none) and (pointer: coarse)").matches;
if (touchOnly) document.documentElement.classList.add("touch");
$("text").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return;
  const sendKey = e.ctrlKey || e.metaKey || (!e.shiftKey && !e.altKey && !touchOnly);
  if (sendKey) {
    e.preventDefault();
    $("send-form").requestSubmit();
  }
});

// "Paste from clipboard" sends an image if the clipboard holds one, otherwise text.
$("paste").onclick = async () => {
  try {
    if (navigator.clipboard.read) {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((t) => t.startsWith("image/"));
        if (type) {
          const blob = await item.getType(type);
          return uploadFile(new File([blob], "image.png", { type }));
        }
      }
    }
    const text = await navigator.clipboard.readText();
    if (!text) return toast("Clipboard is empty");
    $("text").value = text;
    $("send-form").requestSubmit();
  } catch {
    toast("Clipboard access blocked. Press Ctrl+V instead.");
    setComposer(true, true);
  }
};

// Ctrl+V anywhere in a room: files and screenshots upload straight away.
// Plain text pasted into the box behaves normally; text pasted elsewhere
// lands in the box so you can check it before sending.
document.addEventListener("paste", (e) => {
  if (!state || $("room").hidden) return;
  const files = [...(e.clipboardData?.files || [])];
  const text = e.clipboardData?.getData("text/plain") || "";
  if (files.length && !text) {
    e.preventDefault();
    uploadFiles(files);
  } else if (text && e.target !== $("text") && !(e.target instanceof HTMLInputElement)) {
    e.preventDefault();
    $("text").value += text;
    setComposer(true, true); // unfold so you can check the text before sending
  }
});

$("attach").onclick = () => $("file-input").click();
$("file-input").onchange = (e) => {
  uploadFiles([...e.target.files]);
  e.target.value = "";
};

// Drag files anywhere onto the page.
let dragDepth = 0;
const hasFiles = (e) => state && !$("room").hidden && [...(e.dataTransfer?.types || [])].includes("Files");
window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  $("drop").hidden = false;
});
window.addEventListener("dragover", (e) => hasFiles(e) && e.preventDefault());
window.addEventListener("dragleave", (e) => {
  if (!hasFiles(e)) return;
  if (--dragDepth <= 0) { dragDepth = 0; $("drop").hidden = true; }
});
window.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $("drop").hidden = true;
  uploadFiles([...e.dataTransfer.files]);
});

$("show-qr").onclick = toggleQR;
$("copy-link").onclick = (e) => copyText(shareLink(), e.currentTarget);
$("leave").onclick = () => leaveRoom(true);
$("destroy").onclick = () => {
  if (!state) return;
  if (confirm(`Destroy room ${state.code}? Every clip and file in it is deleted on every device.`)) send({ type: "destroy" });
};
$("clear").onclick = () => {
  if (!confirm("Delete all clips on every device?")) return;
  // Sweep the clips away one after another, then clear the room.
  document.querySelectorAll("#clips .clip").forEach((li, i) => {
    li.style.setProperty("--i", Math.min(i, 10));
    li.classList.add("leaving");
  });
  setTimeout(() => {
    if (!send({ type: "clear" })) document.querySelectorAll("#clips .leaving").forEach((li) => li.classList.remove("leaving"));
  }, 260);
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
