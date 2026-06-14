/**
 * Tiny JSON POST helper built on Node's `http`/`https`.
 *
 * The extension host always ships these built-in modules, so this avoids depending on a
 * global `fetch` (whose ambient typing can clash with `@types/node` across versions) and on
 * any third-party HTTP package. It never rejects — failures resolve to `{ ok:false }`.
 */

import * as http from "http";
import * as https from "https";
import { URL } from "url";

export interface PostResult {
  ok: boolean;
  status: number;
  data: any;
}

/**
 * POST a JSON body and return the parsed JSON response.
 *
 * Example:
 *   const r = await postJson("http://127.0.0.1:4317/api/agents/abc/heartbeat", { agent });
 *   if (r.ok) { use(r.data.commands); }
 */
export function postJson(targetUrl: string, body: unknown, timeoutMs = 8000): Promise<PostResult> {
  return new Promise((resolve) => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(targetUrl);
    } catch {
      resolve({ ok: false, status: 0, data: null });
      return;
    }
    const payload = Buffer.from(JSON.stringify(body ?? {}));
    const transport = parsedUrl.protocol === "https:" ? https : http;
    const request = transport.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": payload.length,
        },
      },
      (response) => {
        let data = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (data += chunk));
        response.on("end", () => {
          let parsed: any = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            /* non-JSON response */
          }
          const status = response.statusCode || 0;
          resolve({ ok: status >= 200 && status < 300, status, data: parsed });
        });
      }
    );
    request.on("error", () => resolve({ ok: false, status: 0, data: null }));
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      resolve({ ok: false, status: 0, data: null });
    });
    request.write(payload);
    request.end();
  });
}
