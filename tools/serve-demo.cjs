const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const allowed = new Set(['demo.html', 'demo.js', 'popup.html', 'popup.css', 'popup.js']);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
http.createServer(async (request, response) => {
  const name = new URL(request.url, 'http://127.0.0.1').pathname.slice(1) || 'demo.html';
  if (!allowed.has(name)) { response.writeHead(404).end(); return; }
  try {
    const body = await fs.readFile(path.join(root, name));
    response.writeHead(200, { 'Content-Type': mime[path.extname(name)], 'Cache-Control': 'no-store' }).end(body);
  } catch { response.writeHead(500).end(); }
}).listen(8765, '127.0.0.1', () => console.log('演示页面：http://127.0.0.1:8765/demo.html\n按 Ctrl+C 停止。'));
