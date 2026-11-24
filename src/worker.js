import { DurableObject } from "cloudflare:workers";

// Limits keep one room from using unbounded storage or bandwidth.
const MAX_CLIPS = 20; // recent clips (text or files) kept per room
const MAX_CLIP_CHARS = 64 * 1024; // max length of one text clip
const MAX_FILE_BYTES = 10 * 1024 * 1024; // max size of one uploaded file
const MAX_ROOM_FILE_BYTES = 50 * 1024 * 1024; // max total size of files in one room
const CHUNK_BYTES = 128 * 1024; // files are stored in pieces of this size
const CLIP_TTL_MS = 24 * 60 * 60 * 1000; // even in a busy room, clips older than this are dropped
const SAFETY_CHECK_MS = 24 * 60 * 60 * 1000; // re-check an occupied room once a day
// When the last device leaves, the room waits this long before it is destroyed
// (with all its clips). The pause covers phones that drop the connection when
// the screen locks. Set EMPTY_GRACE_SECONDS in wrangler.toml to change it.
const DEFAULT_GRACE_SECONDS = 60;

// Only these types are shown as images in the page. Everything else is a
// download, so an uploaded HTML or SVG file can never run as part of this site.
const PREVIEW_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

// Room numbers are 4 to 8 digits, e.g. 1234.
const ROOM_CODE = /^\d{4,8}$/;
const FILE_ID = /^[0-9a-f-]{36}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // /ws/1234                    → live connection to room 1234
    // /api/rooms/1234             → "is room 1234 in use?"
    // /api/rooms/1234/files       → upload a file (POST)
    // /api/rooms/1234/files/<id>  → download a file (GET)
    const match = url.pathname.match(/^\/(ws|api\/rooms)\/([^/]+)(?:\/files(?:\/([^/]+))?)?$/);
    if (!match) return env.ASSETS.fetch(request);

    const [, kind, code, fileId] = match;
    const isFiles = url.pathname.includes("/files");
    if (!ROOM_CODE.test(code)) {
      return new Response("Room numbers are 4 to 8 digits", { status: 400 });
    }

    const stub = env.ROOMS.get(env.ROOMS.idFromName(code));

    // Downloads need the file's long random id, which can't be guessed,
    // so they skip the rate limit (a room full of images loads many at once).
    if (isFiles && fileId) {
      if (!FILE_ID.test(fileId) || request.method !== "GET") return new Response("Not found", { status: 404 });
      return stub.fetch(new Request(`https://room/files/${fileId}`));
    }

    // Short numeric codes are guessable, so limit how fast one visitor can try them.
    if (env.ROOM_LIMITER) {
      const ip = request.headers.get("CF-Connecting-IP") || "local";
      const { success } = await env.ROOM_LIMITER.limit({ key: ip });
      if (!success) return new Response("Too many tries. Wait a minute.", { status: 429 });
    }

    if (isFiles) {
      if (kind !== "api/rooms" || request.method !== "POST") return new Response("Not found", { status: 404 });
      return stub.fetch(new Request("https://room/files", request));
    }
    if (kind === "api/rooms") {
      return stub.fetch(new Request("https://room/status"));
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket", { status: 426 });
    }
    return stub.fetch(request);
  },
};

/**
 * One Room = one shared clipboard, identified by its room number.
 * It keeps every device's WebSocket open, relays new clips to the others
 * and stores the most recent ones (text, or files split into chunks).
 *
 * Storage layout:
 *   "clips"           → list of clip info, newest last
 *   "file:<id>:<n>"   → piece n of an uploaded file
 *
 * Uses the WebSocket Hibernation API, so idle connections cost nothing.
 */
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.graceMs = (Number(env.EMPTY_GRACE_SECONDS) || DEFAULT_GRACE_SECONDS) * 1000;
    // Answer keepalive pings without waking the object up.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request) {
    const { pathname } = new URL(request.url);

    if (pathname === "/status") {
      const inUse = this.devices() > 0 || (await this.loadClips()).length > 0;
      return Response.json({ inUse });
    }
    if (pathname === "/files" && request.method === "POST") return this.upload(request);
    if (pathname.startsWith("/files/")) return this.download(pathname.slice("/files/".length));

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);

    server.send(JSON.stringify({ type: "history", clips: await this.loadClips() }));
    this.broadcastPresence();
    // Someone is here: cancel any pending destruction.
    await this.ctx.storage.setAlarm(Date.now() + SAFETY_CHECK_MS);

    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------- Files ----------

  async upload(request) {
    // Only devices in the room can add files, so an empty room never fills up.
    if (this.devices() === 0) return new Response("Join the room first", { status: 409 });

    const declared = Number(request.headers.get("Content-Length") || 0);
    if (declared > MAX_FILE_BYTES) return tooLarge();
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length === 0) return new Response("Empty file", { status: 400 });
    if (bytes.length > MAX_FILE_BYTES) return tooLarge();

    const clips = await this.loadClips();
    const used = clips.reduce((sum, c) => sum + (c.kind === "file" ? c.size : 0), 0);
    if (used + bytes.length > MAX_ROOM_FILE_BYTES) {
      return new Response("This room is full (50 MB of files). Delete some first.", { status: 413 });
    }

    const id = crypto.randomUUID();
    const chunks = Math.ceil(bytes.length / CHUNK_BYTES);
    const pieces = {};
    for (let i = 0; i < chunks; i++) {
      pieces[`file:${id}:${i}`] = bytes.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
    }
    await this.ctx.storage.put(pieces);

    const clip = {
      id,
      kind: "file",
      name: cleanName(decodeURIComponent(request.headers.get("X-File-Name") || "file")),
      type: cleanType(request.headers.get("Content-Type")),
      size: bytes.length,
      chunks,
      ts: Date.now(),
    };
    await this.saveClips([...clips, clip].slice(-MAX_CLIPS), clips);
    this.broadcast({ type: "clip", clip });
    return Response.json({ id });
  }

  async download(id) {
    const clip = (await this.loadClips()).find((c) => c.id === id && c.kind === "file");
    if (!clip) return new Response("This file is gone", { status: 404 });

    const keys = Array.from({ length: clip.chunks }, (_, i) => `file:${id}:${i}`);
    const found = await this.ctx.storage.get(keys);
    const body = new Uint8Array(clip.size);
    let offset = 0;
    for (const key of keys) {
      const piece = found.get(key);
      if (!piece) return new Response("This file is incomplete", { status: 500 });
      body.set(piece, offset);
      offset += piece.length;
    }

    const preview = PREVIEW_TYPES.has(clip.type);
    return new Response(body, {
      headers: {
        "Content-Type": preview ? clip.type : "application/octet-stream",
        "Content-Disposition": `${preview ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(clip.name)}`,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'",
        "Cache-Control": "private, max-age=3600",
      },
    });
  }

  // ---------- Messages ----------

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > MAX_CLIP_CHARS + 512) {
      ws.send(JSON.stringify({ type: "error", message: "That clip is too large" }));
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    const clips = await this.loadClips();
    if (msg.type === "clip") {
      const text = typeof msg.text === "string" ? msg.text : "";
      if (!text || text.length > MAX_CLIP_CHARS) return;
      const clip = { id: crypto.randomUUID(), kind: "text", text, ts: Date.now() };
      await this.saveClips([...clips, clip].slice(-MAX_CLIPS), clips);
      this.broadcast({ type: "clip", clip });
    } else if (msg.type === "delete") {
      await this.saveClips(clips.filter((c) => c.id !== msg.id), clips);
      this.broadcast({ type: "delete", id: msg.id });
    } else if (msg.type === "clear") {
      await this.saveClips([], clips);
      this.broadcast({ type: "clear" });
    }
  }

  async webSocketClose(ws, code) {
    try {
      ws.close(code === 1005 ? 1000 : code, "bye");
    } catch {}
    await this.deviceLeft(ws);
  }

  async webSocketError(ws) {
    await this.deviceLeft(ws);
  }

  async deviceLeft(ws) {
    this.broadcastPresence(ws);
    if (this.devices(ws) === 0) {
      // Last one out: destroy the room unless someone returns within the grace period.
      await this.ctx.storage.setAlarm(Date.now() + this.graceMs);
    }
  }

  async alarm() {
    if (this.devices() === 0) {
      // Still empty: destroy the room and every clip and file in it.
      await this.ctx.storage.deleteAll();
    } else {
      // Occupied: drop clips older than a day and check again tomorrow.
      const all = (await this.ctx.storage.get("clips")) || [];
      await this.saveClips(await this.loadClips(), all);
      await this.ctx.storage.setAlarm(Date.now() + SAFETY_CHECK_MS);
    }
  }

  // ---------- Helpers ----------

  devices(leaving) {
    return this.ctx.getWebSockets().filter((ws) => ws !== leaving).length;
  }

  async loadClips() {
    const clips = (await this.ctx.storage.get("clips")) || [];
    const cutoff = Date.now() - CLIP_TTL_MS;
    return clips.filter((c) => c.ts >= cutoff);
  }

  // Save the new clip list and delete the stored pieces of any file that left it.
  async saveClips(next, previous) {
    await this.ctx.storage.put("clips", next);
    const kept = new Set(next.map((c) => c.id));
    const keys = previous
      .filter((c) => c.kind === "file" && !kept.has(c.id))
      .flatMap((c) => Array.from({ length: c.chunks }, (_, i) => `file:${c.id}:${i}`));
    for (let i = 0; i < keys.length; i += 128) {
      await this.ctx.storage.delete(keys.slice(i, i + 128)); // at most 128 keys per call
    }
  }

  broadcast(msg, except) {
    const text = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(text);
      } catch {}
    }
  }

  broadcastPresence(leaving) {
    this.broadcast({ type: "presence", devices: this.devices(leaving) }, leaving);
  }
}

function tooLarge() {
  return new Response("Files can be at most 10 MB", { status: 413 });
}

// Keep file names short and free of path separators or control characters.
function cleanName(name) {
  const cleaned = name.replace(/[\u0000-\u001f\u007f/\\]/g, "_").trim().slice(0, 120);
  return cleaned || "file";
}

function cleanType(type) {
  const t = String(type || "").split(";")[0].trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(t) ? t : "application/octet-stream";
}
