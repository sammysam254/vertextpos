const transactionService = require('../pos/transaction-service');
const biometricAdapter = require('../biometric/biometric-adapter');
const deviceManager = require('../biometric/device-manager');
const db = require('../db/database');
const AuditLogger = require('../security/audit-logger');

class ApiRouter {
  static async handle(req, res, pathname, query, body) {
    res.setHeader('Content-Type', 'application/json');

    try {
      // 1. Health & Status
      if (pathname === '/api/status' && req.method === 'GET') {
        const hw = deviceManager.getHardwareStatusMessage();
        return this.sendJson(res, 200, {
          status: 'ONLINE',
          timestamp: new Date().toISOString(),
          hardware: hw,
          branchId: 'BR-001',
          registerId: 'REG-01'
        });
      }

      // 2. Hardware Status & Diagnostics
      if (pathname === '/api/biometric/device' && req.method === 'GET') {
        return this.sendJson(res, 200, deviceManager.getHardwareStatusMessage());
      }

      if (pathname === '/api/biometric/device/simulate-connection' && req.method === 'POST') {
        const { state, reason } = body;
        const result = deviceManager.setDeviceConnectionState(state, reason);
        return this.sendJson(res, 200, result);
      }

      // 3. Biometric Fingerprint Scanning Simulation / Driver Interface
      if (pathname === '/api/biometric/scan-simulate' && req.method === 'POST') {
        const { challenge, userId, errorSimulation } = body;
        const scanResult = await biometricAdapter.scanFingerprint({
          challenge,
          userId,
          errorSimulation
        });
        return this.sendJson(res, scanResult.success ? 200 : 400, scanResult);
      }

      // 4. Supervisor Biometric Enrollment
      if (pathname === '/api/biometric/enroll' && req.method === 'POST') {
        const { supervisorId, enrolledBy, branchId, deviceType } = body;
        const result = await biometricAdapter.enrollSupervisorFingerprint({
          supervisorId,
          enrolledBy: enrolledBy || supervisorId,
          branchId: branchId || 'BR-001',
          deviceType
        });
        return this.sendJson(res, result.success ? 201 : 400, result);
      }

      // 5. Revoke Credential
      if (pathname === '/api/biometric/revoke' && req.method === 'POST') {
        const { credentialId, revokedBy, reason } = body;
        const result = await biometricAdapter.revokeCredential(credentialId, revokedBy, reason);
        return this.sendJson(res, result.success ? 200 : 400, result);
      }

      if (pathname === '/api/biometric/credentials' && req.method === 'GET') {
        const creds = db.getAllCredentials().map(c => ({
          id: c.id,
          userId: c.userId,
          userName: c.userName,
          deviceType: c.deviceType,
          deviceSerial: c.deviceSerial,
          enrolledAt: c.enrolledAt,
          status: c.status,
          branchPermissions: c.branchPermissions
        }));
        return this.sendJson(res, 200, { credentials: creds });
      }

      // 6. POS Transactions
      if (pathname === '/api/pos/transaction/new' && req.method === 'POST') {
        const { cashierId, branchId, registerId } = body;
        const tx = transactionService.createNewTransaction(cashierId || 'user_c01', branchId || 'BR-001', registerId || 'REG-01');
        return this.sendJson(res, 201, { transaction: tx });
      }

      if (pathname.match(/^\/api\/pos\/transaction\/([^/]+)$/) && req.method === 'GET') {
        const txId = pathname.split('/')[4];
        const tx = db.getTransactionById(txId);
        if (!tx) return this.sendJson(res, 404, { error: 'NOT_FOUND', message: 'Transaction not found' });
        return this.sendJson(res, 200, { transaction: tx });
      }

      if (pathname.match(/^\/api\/pos\/transaction\/([^/]+)\/item$/) && req.method === 'POST') {
        const txId = pathname.split('/')[4];
        const { barcodeOrId, quantity } = body;
        const result = transactionService.addItemToCart(txId, barcodeOrId, quantity || 1);
        return this.sendJson(res, result.success ? 200 : 400, result);
      }

      if (pathname.match(/^\/api\/pos\/transaction\/([^/]+)\/payment$/) && req.method === 'POST') {
        const txId = pathname.split('/')[4];
        const { method, amount, cardLast4 } = body;
        const result = transactionService.addPaymentAttempt(txId, { method, amount, cardLast4 });
        return this.sendJson(res, result.success ? 200 : 400, result);
      }

      if (pathname === '/api/pos/suspended' && req.method === 'GET') {
        const branchId = query.branchId || null;
        const suspended = db.getSuspendedTransactions(branchId);
        return this.sendJson(res, 200, { suspendedTransactions: suspended, suspendedSales: suspended });
      }

      // 7. Suspension Workflow
      if (pathname.match(/^\/api\/pos\/transaction\/([^/]+)\/suspend\/request$/) && req.method === 'POST') {
        const txId = pathname.split('/')[4];
        const { cashierId, branchId, registerId, reason } = body;
        const result = transactionService.requestSuspension(
          txId,
          cashierId || 'user_c01',
          branchId || 'BR-001',
          registerId || 'REG-01',
          reason
        );
        return this.sendJson(res, result.success ? 200 : 400, result);
      }

      if (pathname.match(/^\/api\/pos\/transaction\/([^/]+)\/suspend\/authorize$/) && req.method === 'POST') {
        const txId = pathname.split('/')[4];
        const { challenge, assertion, branchId, registerId, reason } = body;
        const result = await transactionService.authorizeSuspensionWithBiometrics({
          txId,
          challenge,
          assertion,
          branchId: branchId || 'BR-001',
          registerId: registerId || 'REG-01',
          reason
        });
        return this.sendJson(res, result.authorized ? 200 : 403, result);
      }

      // 8. Resumption Workflow
      if (pathname.match(/^\/api\/pos\/transaction\/([^/]+)\/resume\/request$/) && req.method === 'POST') {
        const txId = pathname.split('/')[4];
        const { cashierId, branchId, registerId } = body;
        const result = transactionService.requestResumption(
          txId,
          cashierId || 'user_c01',
          branchId || 'BR-001',
          registerId || 'REG-01'
        );
        return this.sendJson(res, result.success ? 200 : 400, result);
      }

      if (pathname.match(/^\/api\/pos\/transaction\/([^/]+)\/resume\/authorize$/) && req.method === 'POST') {
        const txId = pathname.split('/')[4];
        const { challenge, assertion, branchId, registerId } = body;
        const result = await transactionService.authorizeResumptionWithBiometrics({
          txId,
          challenge,
          assertion,
          branchId: branchId || 'BR-001',
          registerId: registerId || 'REG-01'
        });
        return this.sendJson(res, result.authorized ? 200 : 403, result);
      }

      // 9. Emergency Fallback Override
      if (pathname === '/api/pos/emergency-override' && req.method === 'POST') {
        const result = transactionService.processEmergencyOverride(body);
        return this.sendJson(res, result.authorized ? 200 : 403, result);
      }

      // 10. Audit Logs
      if (pathname === '/api/audit/logs' && req.method === 'GET') {
        const limit = parseInt(query.limit) || 100;
        const logs = AuditLogger.getLogs(limit, query);
        return this.sendJson(res, 200, { logs });
      }

      // 11. Users & Products
      if (pathname === '/api/users' && req.method === 'GET') {
        const safeUsers = db.getAllUsers().map(u => ({
          id: u.id,
          username: u.username,
          name: u.name,
          role: u.role,
          title: u.title,
          branchId: u.branchId,
          allowedRegisters: u.allowedRegisters,
          permissions: u.permissions,
          active: u.active,
          lockedUntil: u.lockedUntil
        }));
        return this.sendJson(res, 200, { users: safeUsers });
      }

      if (pathname === '/api/products' && req.method === 'GET') {
        return this.sendJson(res, 200, { products: db.getAllProducts() });
      }

      // 404 Route Not Found
      return this.sendJson(res, 404, { error: 'NOT_FOUND', message: `Route ${pathname} not found` });
    } catch (err) {
      console.error('API Error:', err);
      return this.sendJson(res, 500, { error: 'INTERNAL_ERROR', message: err.message });
    }
  }

  static sendJson(res, statusCode, data) {
    res.statusCode = statusCode;
    res.end(JSON.stringify(data));
  }
}

module.exports = ApiRouter;

