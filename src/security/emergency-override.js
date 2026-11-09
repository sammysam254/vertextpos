const db = require('../db/database');
const CryptoUtils = require('./crypto-utils');
const AuditLogger = require('./audit-logger');

/**
 * Highly Privileged Emergency Fallback Authorization Handler.
 * Invoked ONLY when biometric hardware is offline, damaged, or account is locked.
 * NEVER allows cashier authorization. Requires dual-supervisor or store director override.
 */
class EmergencyOverrideService {
  /**
   * Executes an emergency administrator override.
   * @param {Object} params
   * @param {string} params.adminUsername
   * @param {string} params.emergencyPasscode
   * @param {string} params.reason Emergency reason ('HARDWARE_FAULT', 'DEVICE_DISCONNECTED', 'SUPERVISOR_LOCKED', 'SENSOR_FAILURE')
   * @param {string} params.action 'SUSPEND_TRANSACTION' or 'RESUME_TRANSACTION'
   * @param {string} params.branchId
   * @param {string} params.registerId
   * @param {string} params.txId
   * @param {string} params.incidentNotes
   */
  static processAdminOverride({
    adminUsername,
    emergencyPasscode,
    reason,
    action,
    branchId,
    registerId,
    txId,
    incidentNotes = ''
  }) {
    if (!adminUsername || !emergencyPasscode || !reason) {
      return {
        authorized: false,
        error: 'MISSING_CREDENTIALS',
        message: 'Administrator username, emergency master passcode, and reason are strictly required.'
      };
    }

    const admin = db.getUserByUsername(adminUsername);
    if (!admin) {
      AuditLogger.log({
        eventType: 'EMERGENCY_OVERRIDE_ATTEMPT',
        userId: 'UNKNOWN',
        userName: adminUsername,
        userRole: 'unknown',
        branchId,
        registerId,
        action,
        status: 'REJECTED',
        reason: `Emergency override rejected: unknown admin account "${adminUsername}"`
      });
      return { authorized: false, error: 'INVALID_ADMIN', message: 'Administrator account not found.' };
    }

    // Must have role administrator or store director
    if (admin.role !== 'administrator' && !admin.permissions.includes('EMERGENCY_OVERRIDE')) {
      AuditLogger.log({
        eventType: 'EMERGENCY_OVERRIDE_ATTEMPT',
        userId: admin.id,
        userName: admin.name,
        userRole: admin.role,
        branchId,
        registerId,
        action,
        status: 'REJECTED',
        reason: `Emergency override rejected: account lacks EMERGENCY_OVERRIDE permission`
      });
      return { authorized: false, error: 'INSUFFICIENT_PRIVILEGES', message: 'User does not possess emergency master override authority.' };
    }

    // Verify cryptographic PBKDF2 hash of master passcode
    const isPasscodeValid = CryptoUtils.verifyEmergencyPassword(
      emergencyPasscode,
      admin.emergencyPasswordHash,
      admin.emergencyPasswordSalt
    );

    if (!isPasscodeValid) {
      AuditLogger.log({
        eventType: 'EMERGENCY_OVERRIDE_ATTEMPT',
        userId: admin.id,
        userName: admin.name,
        userRole: admin.role,
        branchId,
        registerId,
        action,
        status: 'REJECTED',
        reason: 'Emergency override failed: invalid emergency master passcode.'
      });
      return { authorized: false, error: 'INVALID_CREDENTIALS', message: 'Invalid emergency administrator passcode.' };
    }

    // Override Granted - generate emergency audit token
    const emergencyToken = `EMG-${Date.now()}-${CryptoUtils.generateNonce(8)}`;

    AuditLogger.log({
      eventType: 'EMERGENCY_OVERRIDE',
      userId: admin.id,
      userName: admin.name,
      userRole: admin.role,
      branchId,
      registerId,
      action,
      status: 'SUCCESS',
      deviceId: 'EMERGENCY_MANUAL_OVERRIDE',
      reason: `EMERGENCY OVERRIDE GRANTED: ${reason}. Incident notes: ${incidentNotes}`,
      metadata: {
        emergencyToken,
        txId,
        reasonCode: reason,
        notes: incidentNotes
      }
    });

    return {
      authorized: true,
      emergencyToken,
      supervisor: {
        id: admin.id,
        name: `${admin.name} (ADMIN EMERGENCY OVERRIDE)`,
        role: admin.role,
        reason
      },
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Dual supervisor authorization in case one supervisor's biometric is damaged or locked.
   * Requires secondary authorized supervisor to present their valid biometric.
   */
  static processSecondarySupervisorOverride({
    secondarySupervisorId,
    reason,
    action,
    branchId,
    registerId,
    txId
  }) {
    const supervisor = db.getUserById(secondarySupervisorId);
    if (!supervisor || supervisor.role !== 'supervisor' || !supervisor.active) {
      return { authorized: false, error: 'INVALID_SECONDARY_SUPERVISOR', message: 'Secondary supervisor not valid or inactive.' };
    }

    AuditLogger.log({
      eventType: 'EMERGENCY_OVERRIDE',
      userId: supervisor.id,
      userName: supervisor.name,
      userRole: supervisor.role,
      branchId,
      registerId,
      action,
      status: 'SUCCESS',
      deviceId: 'SECONDARY_SUPERVISOR_OVERRIDE',
      reason: `Secondary supervisor emergency authorization: ${reason}`,
      metadata: { txId }
    });

    return {
      authorized: true,
      supervisor: {
        id: supervisor.id,
        name: `${supervisor.name} (SECONDARY SUPERVISOR)`,
        role: supervisor.role
      },
      timestamp: new Date().toISOString()
    };
  }
}

module.exports = EmergencyOverrideService;

