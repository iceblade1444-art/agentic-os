import httpProxy from "http-proxy";

export function mountAtlasProxy(app) {
  const target = String(process.env.ATLAS_API_URL || "http://host.docker.internal:8000").replace(/\/$/, "");
  const proxy = httpProxy.createProxyServer({ target, changeOrigin: false, xfwd: true });

  proxy.on("error", (error, req, res) => {
    if (res.headersSent) return res.end();
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: "ATLAS backend unavailable", code: "atlas_upstream_error" }));
    console.error(`[atlas-proxy] ${error.message}`);
  });

  app.use("/atlas-api", (req, res) => proxy.web(req, res));
}

