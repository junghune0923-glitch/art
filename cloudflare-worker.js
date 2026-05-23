export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/room\/([^/]+)\/ws$/);

    if (match && request.headers.get("Upgrade") === "websocket") {
      const roomName = decodeURIComponent(match[1]);
      const id = env.ROOMS.idFromName(roomName);
      return env.ROOMS.get(id).fetch(request);
    }

    return new Response("Realtime endpoint not found", { status: 404 });
  }
};

export class RoomObject {
  constructor(state) {
    this.state = state;
    this.sessions = new Map();
    this.participants = new Map();
    this.messages = [];
    this.shares = [];
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;
    const stored = await this.state.storage.get(["messages", "shares"]);
    this.messages = stored.get("messages") || [];
    this.shares = stored.get("shares") || [];
    this.loaded = true;
  }

  async fetch(request) {
    await this.load();

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected websocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const socketId = crypto.randomUUID();

    server.accept();
    this.sessions.set(socketId, { socket: server, user: null });

    server.send(JSON.stringify({
      type: "init",
      participants: [...this.participants.values()],
      messages: this.messages.slice(-80),
      shares: this.shares
    }));

    server.addEventListener("message", (event) => {
      this.handleMessage(socketId, event.data);
    });

    server.addEventListener("close", () => {
      this.closeSession(socketId);
    });

    server.addEventListener("error", () => {
      this.closeSession(socketId);
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  async handleMessage(socketId, raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    const session = this.sessions.get(socketId);
    if (!session) return;

    if (message.user?.id) {
      session.user = message.user;
      this.participants.set(message.user.id, {
        ...message.user,
        updatedAt: Date.now()
      });
    }

    if (message.type === "join" || message.type === "presence") {
      this.broadcast({ type: "presence", room: message.room });
      return;
    }

    if (message.type === "chat" && message.message) {
      this.messages.push(message.message);
      this.messages = this.messages.slice(-80);
      await this.state.storage.put("messages", this.messages);
      this.broadcast({ type: "chat", room: message.room, message: message.message });
      return;
    }

    if (message.type === "share" && message.share) {
      if (!this.shares.some((share) => String(share.id) === String(message.share.id))) {
        this.shares.unshift(message.share);
        this.shares = this.shares.slice(0, 80);
        await this.state.storage.put("shares", this.shares);
      }
      this.broadcast({ type: "share", room: message.room, share: message.share });
      return;
    }

    if (message.type === "comment" && message.comment) {
      const share = this.shares.find((item) => String(item.id) === String(message.shareId));
      if (share) {
        share.comments = Array.isArray(share.comments) ? share.comments : [];
        if (!share.comments.some((comment) => comment.id === message.comment.id)) {
          share.comments.push(message.comment);
        }
        await this.state.storage.put("shares", this.shares);
      }
      this.broadcast({
        type: "comment",
        room: message.room,
        shareId: message.shareId,
        comment: message.comment
      });
      return;
    }

    if (message.type === "reaction") {
      const share = this.shares.find((item) => String(item.id) === String(message.shareId));
      if (share) {
        share.reactions = Math.max(share.reactions || 0, message.reactions || 0);
        await this.state.storage.put("shares", this.shares);
      }
      this.broadcast({
        type: "reaction",
        room: message.room,
        shareId: message.shareId,
        reactions: message.reactions
      });
      return;
    }

    if (message.type === "signal" && message.to) {
      this.sendTo(message.to, {
        type: "signal",
        room: message.room,
        to: message.to,
        from: message.from,
        signal: message.signal
      });
    }
  }

  closeSession(socketId) {
    const session = this.sessions.get(socketId);
    this.sessions.delete(socketId);
    if (session?.user?.id) {
      this.participants.delete(session.user.id);
      this.broadcast({ type: "presence" });
    }
  }

  sendTo(userId, payload) {
    const message = JSON.stringify({
      ...payload,
      participants: [...this.participants.values()]
    });
    for (const session of this.sessions.values()) {
      if (session.user?.id === userId) {
        session.socket.send(message);
      }
    }
  }

  broadcast(payload) {
    const message = JSON.stringify({
      ...payload,
      participants: [...this.participants.values()]
    });
    for (const session of this.sessions.values()) {
      session.socket.send(message);
    }
  }
}
