const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const roots = ["build", "src", "lib", "doc", "tests/manual"].map(root => path.resolve(root));
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".otf": "font/otf",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  const relative = pathname.replace(/^\/+/, "");
  const file = roots
    .map(root => path.resolve(root, relative))
    .find(candidate => roots.some(root => candidate.startsWith(root + path.sep)) && fs.existsSync(candidate));

  if (!file || !fs.statSync(file).isFile()) {
    response.writeHead(404, { "Content-Length": "0" });
    return response.end();
  }

  const data = fs.readFileSync(file);
  response.writeHead(200, {
    "Content-Type": mimeTypes[path.extname(file)] || "application/octet-stream",
    "Content-Length": data.length,
    "Cache-Control": "no-store",
  });
  response.end(data);
}).listen(9876, "127.0.0.1");
