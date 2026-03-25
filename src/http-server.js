const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function handleRequest(req, res) {
  // Only serve GET requests
  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0]);
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';

  // Prevent directory traversal
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404);
        res.end('Not Found');
      } else {
        res.writeHead(500);
        res.end('Internal Server Error');
      }
      return;
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
    res.end(data);
  });
}

function createServer(config) {
  let server;

  if (config.tlsCert && config.tlsKey) {
    const tlsOptions = {
      cert: fs.readFileSync(config.tlsCert),
      key: fs.readFileSync(config.tlsKey),
    };
    server = https.createServer(tlsOptions, handleRequest);
    server._isTLS = true;
  } else {
    server = http.createServer(handleRequest);
    server._isTLS = false;
  }

  return server;
}

module.exports = { createServer };
