import { DurableObject } from "cloudflare:workers";

// Limits keep one room from using unbounded storage or bandwidth.
const MAX_CLIPS = 20; // recent clips kept per room
const MAX_CLIP_BYTES = 128 * 1024; // max size of one encrypted message
const CLIP_TTL_MS = 24 * 60 * 60 * 1000; // clips older than this are dropped
const IDLE_WIPE_MS = 24 * 60 * 60 * 1000; // wipe a room after a day of no activity

// The room id is a SHA-256 hash computed in the browser from the pairing code,
// so the server never learns the code (and therefore never has the key).
const ROOM_ID = /^[0-9a-f]{64}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/ws\/([^/]+)$/);

    if (match) {
      const roomId = match[1];
      if (!ROOM_ID.test(roomId)) {
        return new Response("Invalid room", { status: 400 });
      }
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected a WebSocket", { status: 426 });
      }
      const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
      return stub.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};

/**
 * One Room = one clipboard shared by the devices that know the same pairing code.
 * It only relays and briefly stores encrypted blobs; it cannot read them.
 *
 * Uses the WebSocket Hibernation API, so idle connections cost nothing.
 */
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Answer keepalive pings without waking the object up.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch() {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);

    server.send(JSON.stringify({ type: "history", clips: await this.loadClips() }));
    this.broadcastPresence();
    await this.touch();

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > MAX_CLIP_BYTES) {
      ws.send(JSON.stringify({ type: "error", message: "Clip too large" }));
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "clip") {
      const clip = {
        id: String(msg.id || crypto.randomUUID()).slice(0, 64),
        iv: String(msg.iv || ""),
        data: String(msg.data || ""),
        ts: Date.now(),
      };
      if (!clip.iv || !clip.data) return;

      const clips = await this.loadClips();
      clips.push(clip);
      await this.ctx.storage.put("clips", clips.slice(-MAX_CLIPS));

      this.broadcast({ type: "clip", clip });
      await this.touch();
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
    this.broadcastPresence(ws);
  }

  async webSocketError(ws) {
    this.broadcastPresence(ws);
  }

  // Called after a day without activity: forget everything in this room.
  async alarm() {
    await this.ctx.storage.deleteAll();
  }

  async loadClips() {
    const clips = (await this.ctx.storage.get("clips")) || [];
    const cutoff = Date.now() - CLIP_TTL_MS;
    return clips.filter((c) => c.ts >= cutoff);
  }

  async touch() {
    await this.ctx.storage.setAlarm(Date.now() + IDLE_WIPE_MS);
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
    const devices = this.ctx.getWebSockets().filter((ws) => ws !== leaving).length;
    this.broadcast({ type: "presence", devices }, leaving);
  }
}
