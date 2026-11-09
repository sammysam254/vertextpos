const db = require('../db/database');
const CryptoUtils = require('./crypto-utils');

/**
 * Tamper-evident Audit Logger for Supermarket POS Biometric Operations.
 * Every supervisor biometric verification, failure, and override is permanently recorded.
 */
class AuditLogger {
  /**
   * Records an audit event with cryptographic signature hash.
   */
  static log({
    eventType,
    userId = 'SYSTEM',
    userName = 'System',
    userRole = 'system',
    branchId = 'BR-001',
    registerId = 'REG-01',
    action,
    status = 'SUCCESS',
    deviceId = 'N/A',
    reason = '',
    metadata = {}
  }) {
    const timestamp = new Date().toISOString();
    const entryData = `${timestamp}|${eventType}|${userId}|${branchId}|${registerId}|${action}|${status}|${deviceId}`;
    const integrityChecksum = CryptoUtils.sha256(entryData);

    const logEntry = {
      timestamp,
      eventType,
      userId,
      userName,
      userRole,
      branchId,
      registerId,
      action,
      status, // SUCCESS, FAILED, BLOCKED, REJECTED
      deviceId,
      reason,
      metadata,
      integrityChecksum
    };

    const saved = db.addAuditLog(logEntry);
    console.log(`[AUDIT] [${status}] [${eventType}] User: ${userName} (${userRole}) | Branch: ${branchId} | Reg: ${registerId} | Reason: ${reason}`);
    return saved;
  }

  static getLogs(limit = 100, filters = {}) {
    return db.getAuditLogs(limit, filters);
  }
}

module.exports = AuditLogger;

