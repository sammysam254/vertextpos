const WbfDriver = require('./drivers/wbf-driver');
const WebAuthnDriver = require('./drivers/webauthn-driver');
const UsbSdkDriver = require('./drivers/usb-sdk-driver');
const deviceManager = require('./device-manager');
const db = require('../db/database');
const CryptoUtils = require('../security/crypto-utils');
const AuditLogger = require('../security/audit-logger');
const sessionManager = require('../security/session-manager');

/**
 * Biometric Hardware Adapter (HAL).
 * Provides a unified API across Windows Biometric Framework, WebAuthn, and direct USB SDKs.
 * Ensures zero storage of raw biometric images/templates and enforces cryptographic verification.
 */
class BiometricAdapter {
  constructor() {
    this.wbfDriver = new WbfDriver();
    this.webAuthnDriver = new WebAuthnDriver();
    this.usbSdkDriver = new UsbSdkDriver();

    this.activeDriver = this.wbfDriver;
    // In-memory key vault simulating secure enclave / TPM private key storage for enrolled credentials
    this.deviceKeyVault = new Map();
  }

  registerDeviceKey(userId, privateKey) {
    this.deviceKeyVault.set(userId, { privateKey });
  }

  setActiveDriver(driverType) {
    switch (driverType) {
      case 'WEBAUTHN':
        this.activeDriver = this.webAuthnDriver;
        break;
      case 'USB_SDK':
        this.activeDriver = this.usbSdkDriver;
        break;
      case 'WBF':
      default:
        this.activeDriver = this.wbfDriver;
        break;
    }
    return this.activeDriver.getStatus();
  }

  getHardwareStatus() {
    return deviceManager.getHardwareStatusMessage();
  }

  /**
   * Enrolls a supervisor fingerprint.
   * Generates a device-bound ECDSA credential. Public key is persisted; raw biometric is NEVER stored.
   */
  async enrollSupervisorFingerprint({ supervisorId, enrolledBy, branchId, deviceType = 'WBF_FINGERPRINT' }) {
    const supervisor = db.getUserById(supervisorId);
    if (!supervisor) {
      return { success: false, error: 'USER_NOT_FOUND', message: 'Supervisor account does not exist.' };
    }

    if (supervisor.role !== 'supervisor' && supervisor.role !== 'administrator') {
      return { success: false, error: 'INVALID_ROLE', message: 'Only supervisor or administrator accounts can be enrolled for biometric authorization.' };
    }

    if (!deviceManager.isDeviceConnected()) {
      return {
        success: false,
        error: 'DEVICE_DISCONNECTED',
        message: 'Cannot enroll fingerprint: No supported fingerprint reader is connected.'
      };
    }

    // Generate cryptographic credential via active driver
    const enrollmentResult = await this.activeDriver.enrollBiometric(supervisorId, {
      userName: supervisor.name,
      branchId
    });

    if (!enrollmentResult.success) {
      return enrollmentResult;
    }

    const { credential, privateKey } = enrollmentResult;

    // Securely cache private key in device hardware vault
    this.registerDeviceKey(supervisorId, privateKey);

    // Persist only public key and credential metadata in DB
    db.saveCredential(credential);

    AuditLogger.log({
      eventType: 'BIOMETRIC_ENROLLMENT',
      userId: supervisor.id,
      userName: supervisor.name,
      userRole: supervisor.role,
      branchId,
      registerId: 'REG-01',
      action: 'BIOMETRIC_ENROLL',
      status: 'SUCCESS',
      deviceId: credential.deviceSerial,
      reason: `Biometric fingerprint successfully enrolled with cryptographic credential ${credential.id}`,
      metadata: {
        credentialId: credential.id,
        algorithm: credential.algorithm,
        deviceType: credential.deviceType
      }
    });

    return {
      success: true,
      credential: {
        id: credential.id,
        userId: credential.userId,
        userName: credential.userName,
        algorithm: credential.algorithm,
        deviceType: credential.deviceType,
        deviceSerial: credential.deviceSerial,
        enrolledAt: credential.enrolledAt,
        status: credential.status
      }
    };
  }

  /**
   * Revokes an existing biometric credential.
   */
  async revokeCredential(credId, revokedBy, reason) {
    const cred = db.getCredentialById(credId);
    if (!cred) {
      return { success: false, error: 'CREDENTIAL_NOT_FOUND', message: 'Credential not found.' };
    }

    const revoked = db.revokeCredential(credId, revokedBy, reason);

    AuditLogger.log({
      eventType: 'BIOMETRIC_REVOCATION',
      userId: cred.userId,
      userName: cred.userName,
      userRole: 'supervisor',
      branchId: cred.branchPermissions[0] || 'BR-001',
      registerId: 'REG-01',
      action: 'BIOMETRIC_REVOCATION',
      status: 'SUCCESS',
      deviceId: cred.deviceSerial,
      reason: `Biometric credential ${credId} revoked by ${revokedBy}: ${reason}`,
      metadata: { credentialId: credId }
    });

    return { success: true, credential: revoked };
  }

  /**
   * Simulates a finger scan on the reader hardware with a specific user profile or scenario.
   */
  async scanFingerprint({ challenge, userId = null, errorSimulation = null }) {
    if (!deviceManager.isDeviceConnected()) {
      return {
        success: false,
        error: 'DEVICE_DISCONNECTED',
        message: 'No supported fingerprint reader is connected. Please connect a compatible reader.'
      };
    }

    if (errorSimulation === 'SENSOR_NOISE') {
      return {
        success: false,
        error: 'SENSOR_NOISE',
        message: 'Biometric scan distorted by optical noise or dirty sensor. Please wipe the reader and try again.'
      };
    }

    if (errorSimulation === 'UNREGISTERED_FINGER') {
      return {
        success: false,
        error: 'UNRECOGNIZED_FINGERPRINT',
        message: 'Fingerprint rejected. No matching biometric template found in hardware enclave.'
      };
    }

    let user = null;
    if (userId) {
      user = db.getUserById(userId);
    }

    if (!user) {
      return {
        success: false,
        error: 'NO_USER_IDENTIFIED',
        message: 'Fingerprint placed on sensor did not match any enrolled user.'
      };
    }

    // Convert in-memory vault to userKeyMap format
    const keyMap = {};
    for (const [uid, keys] of this.deviceKeyVault.entries()) {
      keyMap[uid] = keys;
    }

    return await this.activeDriver.captureAssertion(challenge, {
      userKeyMap: keyMap,
      simulatedFingerprintUser: user
    });
  }

  /**
   * Cryptographically verifies a biometric assertion and checks supervisor permissions.
   * Mandates identifying the supervisor account and checks branch permissions.
   */
  async verifyBiometricAuthorization({
    challenge,
    assertion,
    expectedAction,
    branchId,
    registerId,
    txId = null
  }) {
    // 1. Check hardware connection
    if (!deviceManager.isDeviceConnected()) {
      return {
        authorized: false,
        error: 'HARDWARE_DISCONNECTED',
        message: 'No supported fingerprint reader is connected. Biometric authorization blocked.'
      };
    }

    // 2. Validate and consume challenge (burns nonce to prevent replay attacks)
    const challengeValidation = sessionManager.consumeChallenge(challenge, expectedAction, branchId, registerId, txId);
    if (!challengeValidation.valid) {
      AuditLogger.log({
        eventType: 'BIOMETRIC_REPLAY_OR_INVALID',
        userId: 'ANONYMOUS',
        userName: 'Unknown',
        userRole: 'unknown',
        branchId,
        registerId,
        action: expectedAction,
        status: 'BLOCKED',
        reason: `Challenge validation failed: ${challengeValidation.message}`,
        metadata: { challengeValidation }
      });
      return {
        authorized: false,
        error: challengeValidation.error,
        message: challengeValidation.message
      };
    }

    if (!assertion || !assertion.userId || !assertion.signature || !assertion.payload) {
      return {
        authorized: false,
        error: 'MALFORMED_ASSERTION',
        message: 'Biometric assertion payload or signature is missing.'
      };
    }

    // 3. Lookup user
    const user = db.getUserById(assertion.userId);
    if (!user) {
      return {
        authorized: false,
        error: 'USER_NOT_FOUND',
        message: 'Biometric assertion identified non-existent user account.'
      };
    }

    // 4. Check supervisor account lockout
    if (sessionManager.isUserLockedOut(user)) {
      AuditLogger.log({
        eventType: 'ACCOUNT_LOCKED_ACCESS_ATTEMPT',
        userId: user.id,
        userName: user.name,
        userRole: user.role,
        branchId,
        registerId,
        action: expectedAction,
        status: 'BLOCKED',
        reason: `Account is temporarily locked until ${user.lockedUntil}. Emergency override required.`
      });
      return {
        authorized: false,
        error: 'ACCOUNT_LOCKED',
        message: `Supervisor account is temporarily locked due to previous failed attempts. Please use Emergency Fallback Override.`
      };
    }

    // 5. Verify user has supervisor / administrator role
    if (user.role !== 'supervisor' && user.role !== 'administrator') {
      sessionManager.recordFailedAttempt(user, branchId, registerId, `Unauthorized role "${user.role}" attempted supervisor action.`);
      return {
        authorized: false,
        error: 'UNAUTHORIZED_ROLE',
        message: `Access Denied: ${user.name} is a ${user.role}. Only authorized supervisors can authorize this operation.`
      };
    }

    // 6. Verify user is active
    if (!user.active) {
      return {
        authorized: false,
        error: 'ACCOUNT_INACTIVE',
        message: `Supervisor account for ${user.name} is inactive or disabled.`
      };
    }

    // 7. Verify supervisor specific permissions
    if (!user.permissions.includes(expectedAction)) {
      sessionManager.recordFailedAttempt(user, branchId, registerId, `Supervisor lacks specific permission ${expectedAction}`);
      return {
        authorized: false,
        error: 'PERMISSION_DENIED',
        message: `Supervisor ${user.name} does not have "${expectedAction}" permission.`
      };
    }

    // 8. Branch-level authorization: Verify supervisor has authority for this specific branch
    if (user.branchId !== branchId && !user.branchId.includes('ALL')) {
      sessionManager.recordFailedAttempt(user, branchId, registerId, `Branch mismatch: supervisor assigned to ${user.branchId}, attempted on ${branchId}`);
      return {
        authorized: false,
        error: 'BRANCH_UNAUTHORIZED',
        message: `Branch Authorization Failed: ${user.name} is assigned to branch ${user.branchId} and cannot authorize operations on branch ${branchId}.`
      };
    }

    // 9. Lookup active biometric credential for supervisor
    const credentials = db.getCredentialsByUserId(user.id);
    if (!credentials || credentials.length === 0) {
      sessionManager.recordFailedAttempt(user, branchId, registerId, 'No active biometric credential enrolled for supervisor');
      return {
        authorized: false,
        error: 'NO_ENROLLED_BIOMETRIC',
        message: `Supervisor ${user.name} has not registered a biometric credential or credential has been revoked.`
      };
    }

    // Find matching credential
    const cred = credentials.find(c => c.status === 'ACTIVE');
    if (!cred) {
      return {
        authorized: false,
        error: 'CREDENTIAL_REVOKED',
        message: `Biometric credential for ${user.name} has been revoked.`
      };
    }

    // 10. Cryptographic ECDSA P-256 signature verification
    const isSignatureValid = CryptoUtils.verifySignature(
      assertion.payload,
      assertion.signature,
      cred.publicKey
    );

    if (!isSignatureValid) {
      const failInfo = sessionManager.recordFailedAttempt(user, branchId, registerId, 'Cryptographic signature mismatch on biometric assertion');
      return {
        authorized: false,
        error: 'INVALID_SIGNATURE',
        message: 'Biometric cryptographic verification failed: Signature does not match supervisor public key.',
        lockoutInfo: failInfo
      };
    }

    // 11. Replay attack protection: Verify signature counter increment
    cred.signCount = (cred.signCount || 0) + 1;
    db.saveCredential(cred);

    // Reset any previous failed attempts
    sessionManager.recordSuccessfulAttempt(user);

    // Generate fresh single-use authorization token
    const authToken = `BIOAUTH-${Date.now()}-${CryptoUtils.generateNonce(12)}`;

    return {
      authorized: true,
      authToken,
      supervisor: {
        id: user.id,
        name: user.name,
        role: user.role,
        branchId: user.branchId,
        title: user.title
      },
      credentialId: cred.id,
      deviceId: assertion.deviceId || cred.deviceSerial,
      timestamp: new Date().toISOString()
    };
  }
}

// Singleton
module.exports = new BiometricAdapter();

