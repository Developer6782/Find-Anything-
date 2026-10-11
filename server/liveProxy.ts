import type { IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';

/**
 * Gemini Live API proxy.
 *
 * The browser never sends the API key in a URL (URLs leak into logs, proxies and
 * history). Instead it opens a websocket to `/api/live` on the same origin and
 * sends ONE auth frame first:
 *
 *   { "auth": { "apiKey": "...", "model": "gemini-2.5-flash-live" } }
 *
 * The server then opens the upstream Google websocket with that key and pipes
 * frames both ways verbatim (setup / realtimeInput / serverContent / toolCall…).
 * The key is only held in memory for the lifetime of the socket.
 */

const UPSTREAM_HOST = 'generativelanguage.googleapis.com';
const UPSTREAM_PATH =
  '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

interface AuthFrame {
  auth?: { apiKey?: string; model?: string };
}

export function attachLiveProxy(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = req.url ?? '';
    if (!url.startsWith('/api/live')) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket as any, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (client: WebSocket) => {
    let upstream: WebSocket | null = null;
    let authed = false;
    let closed = false;

    const fail = (code: string, message: string, hint?: string) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ __error: { code, message, hint } }));
      }
      client.close();
    };

    const queue: string[] = [];
    let upstreamReady = false;

    client.on('message', (data, isBinary) => {
      if (isBinary) return; // the client only sends JSON (audio is base64 inside JSON)
      const text = data.toString();

      if (!authed) {
        let frame: AuthFrame;
        try {
          frame = JSON.parse(text) as AuthFrame;
        } catch {
          fail('BAD_REQUEST', 'First websocket frame must be JSON with {auth:{apiKey,model}}.');
          return;
        }
        const apiKey = frame.auth?.apiKey?.trim();
        const model = frame.auth?.model?.trim();
        if (!apiKey || !model) {
          fail('NO_KEY', 'Missing Gemini API key or model for the Live session.');
          return;
        }
        authed = true;

        const upstreamUrl = `wss://${UPSTREAM_HOST}${UPSTREAM_PATH}?key=${encodeURIComponent(apiKey)}`;
        upstream = new WebSocket(upstreamUrl);
        const ws = upstream;

        const openTimeout = setTimeout(() => {
          if (ws.readyState !== WebSocket.OPEN) {
            fail('TIMEOUT', 'The Live API connection timed out.', 'Check your network and try again.');
            ws.terminate();
          }
        }, 15_000);

        ws.on('open', () => {
          clearTimeout(openTimeout);
          upstreamReady = true;
          for (const q of queue) ws.send(q);
          queue.length = 0;
        });

        ws.on('message', (msg, bin) => {
          if (client.readyState !== WebSocket.OPEN) return;
          client.send(bin ? (msg as Buffer) : msg.toString(), { binary: bin });
        });

        ws.on('unexpected-response', (_req, res) => {
          clearTimeout(openTimeout);
          const status = res.statusCode ?? 0;
          if (status === 401 || status === 403) {
            fail('INVALID_KEY', 'Gemini rejected the API key for the Live API.', 'Create a fresh key in Google AI Studio.');
          } else if (status === 404) {
            fail(
              'MODEL_UNSUPPORTED',
              `The Live API model "${model}" is not available for this key.`,
              'Switch to a Live-compatible model, or continue in push-to-talk mode.',
            );
          } else {
            fail('UPSTREAM', `Live API handshake failed (HTTP ${status}).`, 'Retry, or use push-to-talk mode.');
          }
        });

        ws.on('error', (err) => {
          clearTimeout(openTimeout);
          if (!closed) {
            fail('UPSTREAM', `Live connection error: ${err.message}`, 'Retry, or switch to push-to-talk mode.');
          }
        });

        ws.on('close', (code, reason) => {
          clearTimeout(openTimeout);
          const detail = reason?.toString()?.slice(0, 240) ?? '';
          if (!closed && client.readyState === WebSocket.OPEN) {
            client.send(
              JSON.stringify({
                __closed: { code, reason: detail || 'Live session closed by server.' },
              }),
            );
            client.close();
          }
        });
        return;
      }

      // Authenticated: forward verbatim.
      if (upstreamReady && upstream && upstream.readyState === WebSocket.OPEN) {
        upstream.send(text);
      } else {
        queue.push(text);
        if (queue.length > 40) queue.shift();
      }
    });

    const keepAlive = setInterval(() => {
      if (client.readyState === WebSocket.OPEN) client.ping();
      if (upstream && upstream.readyState === WebSocket.OPEN) upstream.ping();
    }, 25_000);

    client.on('close', () => {
      closed = true;
      clearInterval(keepAlive);
      try {
        upstream?.close();
      } catch {
        /* ignore */
      }
    });

    client.on('error', () => {
      closed = true;
      clearInterval(keepAlive);
      try {
        upstream?.close();
      } catch {
        /* ignore */
      }
    });
  });

  return wss;
}
