import type { Express, Response } from "express";

const sseClients: Set<Response> = new Set();

export function broadcastSSE(eventType: string, data: unknown): void {
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
      if (typeof (client as any).flush === "function") (client as any).flush();
    } catch (_e) {
      sseClients.delete(client);
    }
  }
}

export function registerSseRoutes(app: Express): void {
  app.get("/api/events", (req, res) => {
    if (!(req as any).session?.authenticated) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    console.log("[SSE] Client connected, total clients:", sseClients.size + 1);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-cache, must-revalidate, no-transform",
      Pragma: "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    const flush = typeof (res as any).flush === "function" ? () => (res as any).flush() : () => {};
    res.write("event: connected\ndata: {}\n\n");
    flush();
    sseClients.add(res);
    const keepAlive = setInterval(() => {
      try {
        res.write(":ping\n\n");
        flush();
      } catch (_e) {
        clearInterval(keepAlive);
        sseClients.delete(res);
      }
    }, 15000);
    const removeClient = () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
      console.log("[SSE] Client disconnected, remaining:", sseClients.size);
    };
    req.on("close", removeClient);
    res.on("error", () => {
      removeClient();
    });
  });
}
