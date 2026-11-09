const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const SaasRouter = require('./saas-router');
const ApiRouter = require('./router');
const { seedSaasData } = require('../db/saas-seed');
const { seedDatabase, aliceKeys, bobKeys, carolKeys, cashierDaveKeys } = require('../db/seed');
const biometricAdapter = require('../biometric/biometric-adapter');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function createServer() {
  // Ensure both SaaS Store and Biometric Hardware Store are seeded
  try {
    seedDatabase();
    biometricAdapter.registerDeviceKey('user_s01', aliceKeys.privateKey);
    biometricAdapter.registerDeviceKey('user_s02', bobKeys.privateKey);
    biometricAdapter.registerDeviceKey('user_s03', carolKeys.privateKey);
    biometricAdapter.registerDeviceKey('user_c01', cashierDaveKeys.privateKey);
    seedSaasData();
  } catch (e) {
    console.error('Seed load error:', e.message);
  }

  const server = http.createServer((req, res) => {
    // CORS Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Tenant-Id, X-Branch-Id, X-Register-Id');

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;
    const query = Object.fromEntries(parsedUrl.searchParams.entries());

    // API Routes & Public Digital Receipts
    if (pathname.startsWith('/api/') || pathname.startsWith('/receipt/')) {
      let bodyData = '';
      req.on('data', chunk => {
        bodyData += chunk;
      });
      req.on('end', async () => {
        let body = {};
        if (bodyData) {
          try {
            body = JSON.parse(bodyData);
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'INVALID_JSON', message: 'Malformed JSON payload' }));
            return;
          }
        }

        // Route to Biometric Router or SaaS POS Router
        const isBiometricRoute = pathname.startsWith('/api/biometric/') ||
          pathname.startsWith('/api/pos/transaction') ||
          pathname === '/api/pos/emergency-override' ||
          (!req.headers['x-tenant-id'] && pathname === '/api/pos/suspended') ||
          (!req.headers['x-tenant-id'] && pathname === '/api/audit/logs');

        if (isBiometricRoute) {
          await ApiRouter.handle(req, res, pathname, query, body);
        } else {
          await SaasRouter.handle(req, res, pathname, query, body);
        }
      });
      return;
    }

    // Static File Serving
    let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);

    // Prevent path traversal
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.statusCode = 403;
      res.end('Access Forbidden');
      return;
    }

    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        filePath = path.join(PUBLIC_DIR, 'index.html');
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      fs.readFile(filePath, (readErr, content) => {
        if (readErr) {
          res.statusCode = 500;
          res.end('Internal Server Error');
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', contentType);
        res.end(content);
      });
    });
  });

  return server;
}

function startServer(port = config.server.port) {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        const nextPort = Number(port) + 1;
        console.warn(`[VERTEXT POS] Port ${port} is in use, falling back to port ${nextPort}...`);
        startServer(nextPort).then(resolve).catch(reject);
      } else {
        reject(err);
      }
    });

    server.listen(port, config.server.host, () => {
      console.log(`[VERTEXT POS SERVER] Kenyan Supermarket POS SaaS running at http://${config.server.host}:${port}`);
      resolve(server);
    });
  });
}

module.exports = { createServer, startServer };

if (require.main === module) {
  startServer();
}
