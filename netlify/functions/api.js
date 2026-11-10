/**
 * Netlify Serverless API Gateway for VERTEXT POS SaaS
 * Powered by Supabase Cloud Database & GoTrue Authentication
 */
require('../../src/load-env');
const SaasRouter = require('../../src/server/saas-router');
const ApiRouter = require('../../src/server/router');
const { seedSaasData } = require('../../src/db/saas-seed');
const { seedDatabase } = require('../../src/db/seed');

let isInitialized = false;

function ensureInitialized() {
  if (!isInitialized) {
    try {
      seedDatabase();
      seedSaasData();
      isInitialized = true;
      console.log('[NETLIFY] Gateway initialized with Supabase Cloud connection');
    } catch (e) {
      console.warn('Initialization notice:', e.message);
    }
  }
}

exports.handler = async (event, context) => {
  ensureInitialized();

  // Strip prefix '/.netlify/functions/api' or handle path
  let path = event.path;
  if (path.startsWith('/.netlify/functions/api')) {
    path = path.replace('/.netlify/functions/api', '/api');
  }

  const method = event.httpMethod;
  const headers = event.headers || {};
  let body = {};
  if (event.body) {
    try {
      body = JSON.parse(event.body);
    } catch (e) {
      body = {};
    }
  }

  const query = event.queryStringParameters || {};

  return new Promise((resolve) => {
    let statusCode = 200;
    const responseHeaders = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Tenant-Id, X-Branch-Id, X-Register-Id',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, DELETE'
    };
    let responseBody = '';

    const mockRes = {
      statusCode: 200,
      setHeader: (k, v) => {
        responseHeaders[k] = v;
      },
      writeHead: (code, hdrs) => {
        statusCode = code;
        if (hdrs) Object.assign(responseHeaders, hdrs);
      },
      end: (data) => {
        responseBody = data || '';
        resolve({
          statusCode: mockRes.statusCode || statusCode,
          headers: responseHeaders,
          body: responseBody
        });
      }
    };

    const mockReq = {
      method,
      url: path + (event.rawQuery ? `?${event.rawQuery}` : ''),
      headers
    };

    if (method === 'OPTIONS') {
      return resolve({
        statusCode: 204,
        headers: responseHeaders,
        body: ''
      });
    }

    const isBiometricRoute = path.startsWith('/api/biometric/') ||
      path.startsWith('/api/pos/transaction') ||
      path === '/api/pos/emergency-override' ||
      (!headers['x-tenant-id'] && path === '/api/pos/suspended') ||
      (!headers['x-tenant-id'] && path === '/api/audit/logs');

    if (isBiometricRoute) {
      ApiRouter.handle(mockReq, mockRes, path, query, body).catch(err => {
        resolve({
          statusCode: 500,
          headers: responseHeaders,
          body: JSON.stringify({ error: 'SERVER_ERROR', message: err.message })
        });
      });
    } else {
      SaasRouter.handle(mockReq, mockRes, path, query, body).catch(err => {
        resolve({
          statusCode: 500,
          headers: responseHeaders,
          body: JSON.stringify({ error: 'SERVER_ERROR', message: err.message })
        });
      });
    }
  });
};
