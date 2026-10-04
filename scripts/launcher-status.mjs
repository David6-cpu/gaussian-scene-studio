import { readFileSync } from "node:fs";
const html = readFileSync(
  new URL("./launcher-status.html", import.meta.url),
  "utf8",
);
export function statusMiddleware(state, requestStop) {
  return (req, res, next) => {
    if (!req.url?.startsWith("/_local/")) return next();
    const origin = "http://127.0.0.1:4173";
    const send = (code, value, type = "application/json; charset=utf-8") => {
      res.writeHead(code, {
        "content-type": type,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
      });
      res.end(
        type.startsWith("application/json") ? JSON.stringify(value) : value,
      );
    };
    if (
      req.headers.host !== "127.0.0.1:4173" ||
      (req.headers.origin && req.headers.origin !== origin)
    )
      return send(403, { error: "仅允许同源本机访问" });
    if (req.method === "GET" && req.url === "/_local/")
      return send(200, html, "text/html; charset=utf-8");
    if (req.method === "GET" && req.url === "/_local/status.json")
      return send(200, state);
    if (req.method === "POST" && req.url === "/_local/stop") {
      if (
        req.headers.origin !== origin ||
        req.headers["content-type"] !== "application/json"
      )
        return send(403, { error: "需要同源JSON请求" });
      requestStop();
      return send(202, { requested: true });
    }
    send(404, { error: "未知启动器接口" });
  };
}
