import { DurableObject } from "cloudflare:workers";

// Limits keep one room from using unbounded storage or bandwidth.
const MAX_CLIPS = 20; // recent clips kept per room
const MAX_CLIP_CHARS = 64 * 1024; // max length of one clip
const CLIP_TTL_MS = 24 * 60 * 60 * 1000; // even in a busy room, clips older than this are dropped
const SAFETY_CHECK_MS = 24 * 60 * 60 * 1000; // re-check an occupied room once a day
// When the last device leaves, the room waits this long before it is destroyed
// (with all its clips). The pause covers phones that drop the connection when
// the screen locks. Set EMPTY_GRACE_SECONDS in wrangler.toml to change it.
const DEFAULT_GRACE_SECONDS = 60;

// Room numbers are 4 to 8 digits, e.g. 1234.
const ROOM_CODE = /^\d{4,8}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // /ws/1234          → live connection to room 1234
    // /api/rooms/1234   → "is room 1234 in use?" (used to pick a free random room)
    const match = url.pathname.match(/^\/(ws|api\/rooms)\/([^/]+)$/);
    if (!match) return env.ASSETS.fetch(request);

    const [, kind, code] = match;
    if (!ROOM_CODE.test(code)) {
      return new Response("Room numbers are 4 to 8 digits", { status: 400 });
    }

    // Short numeric codes are guessable, so limit how fast one visitor can try them.
    if (env.ROOM_LIMITER) {
      const ip = request.headers.get("CF-Connecting-IP") || "local";
      const { success } = await env.ROOM_LIMITER.limit({ key: ip });
      if (!success) return new Response("Too many rooms tried. Wait a minute.", { status: 429 });
    }

    const stub = env.ROOMS.get(env.ROOMS.idFromName(code));

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
 * and briefly stores the most recent ones.
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
    if (new URL(request.url).pathname === "/status") {
      const inUse = this.ctx.getWebSockets().length > 0 || (await this.loadClips()).length > 0;
      return Response.json({ inUse });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);

    server.send(JSON.stringify({ type: "history", clips: await this.loadClips() }));
    this.broadcastPresence();
    // Someone is here: cancel any pending destruction.
    await this.ctx.storage.setAlarm(Date.now() + SAFETY_CHECK_MS);

    return new Response(null, { status: 101, webSocket: client });
  }

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

    if (msg.type === "clip") {
      const text = typeof msg.text === "string" ? msg.text : "";
      if (!text || text.length > MAX_CLIP_CHARS) return;
      const clip = { id: crypto.randomUUID(), text, ts: Date.now() };

      const clips = await this.loadClips();
      clips.push(clip);
      await this.ctx.storage.put("clips", clips.slice(-MAX_CLIPS));

      this.broadcast({ type: "clip", clip });
    } else if (msg.type === "delete") {
      const clips = (await this.loadClips()).filter((c) => c.id !== msg.id);
      await this.ctx.storage.put("clips", clips);
      this.broadcast({ type: "delete", id: msg.id });
    } else if (msg.type === "clear") {
      await this.ctx.storage.put("clips", []);
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
      // Still empty: destroy the room and every clip in it.
      await this.ctx.storage.deleteAll();
    } else {
      // Occupied: drop clips older than a day and check again tomorrow.
      await this.ctx.storage.put("clips", await this.loadClips());
      await this.ctx.storage.setAlarm(Date.now() + SAFETY_CHECK_MS);
    }
  }

  devices(leaving) {
    return this.ctx.getWebSockets().filter((ws) => ws !== leaving).length;
  }

  async loadClips() {
    const clips = (await this.ctx.storage.get("clips")) || [];
    const cutoff = Date.now() - CLIP_TTL_MS;
    return clips.filter((c) => c.ts >= cutoff);
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
