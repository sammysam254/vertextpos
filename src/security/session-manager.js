const CryptoUtils = require('./crypto-utils');
const AuditLogger = require('./audit-logger');
const config = require('../config');
const db = require('../db/database');

/**
 * Manages authorization challenges, single-use nonces, and replay protection.
 * Ensures fresh biometric prompt for every transaction suspension or resumption.
 */
class SessionManager {
  constructor() {
    this.challenges = new Map(); // challenge -> { action, branchId, registerId, txId, createdAt, expiresAt, used }
  }

  /**
   * Generates a fresh, single-use cryptographic challenge for a specific operation.
   */
  createAuthorizationChallenge(action, branchId, registerId, txId = null) {
    const nonce = CryptoUtils.generateNonce(32);
    const now = Date.now();
    const expiresAt = now + config.security.challengeTimeoutMs;

    const challengeRecord = {
      challenge: nonce,
      action, // 'SUSPEND_TRANSACTION' or 'RESUME_TRANSACTION' or 'BIOMETRIC_ENROLL'
      branchId,
      registerId,
      txId,
      createdAt: now,
      expiresAt,
      used: false
    };

    this.challenges.set(nonce, challengeRecord);

    // Clean up stale challenges after 2 minutes (unref so tests/scripts exit cleanly)
    const cleanupTimer = setTimeout(() => {
      this.challenges.delete(nonce);
    }, config.security.challengeTimeoutMs * 2);
    if (cleanupTimer.unref) cleanupTimer.unref();

    return {
      challenge: nonce,
      expiresAt,
      timeoutSeconds: Math.floor(config.security.challengeTimeoutMs / 1000)
    };
  }

  /**
   * Validates and immediately burns the challenge to prevent replay attacks.
   */
  consumeChallenge(challenge, expectedAction, branchId, registerId, txId = null) {
    const record = this.challenges.get(challenge);

    if (!record) {
      return { valid: false, error: 'INVALID_CHALLENGE', message: 'Authorization challenge not found or already consumed.' };
    }

    // Immediately remove/burn to prevent race conditions or replay attacks
    this.challenges.delete(challenge);

    if (record.used) {
      return { valid: false, error: 'CHALLENGE_REUSED', message: 'Replay attack detected: Challenge was already consumed.' };
    }

    if (Date.now() > record.expiresAt) {
      return { valid: false, error: 'CHALLENGE_EXPIRED', message: 'Biometric authorization timed out. Please try again.' };
    }

    if (record.action !== expectedAction) {
      return { valid: false, error: 'ACTION_MISMATCH', message: `Challenge generated for ${record.action}, not ${expectedAction}.` };
    }

    if (record.branchId !== branchId) {
      return { valid: false, error: 'BRANCH_MISMATCH', message: 'Challenge was generated for a different branch terminal.' };
    }

    if (record.registerId !== registerId) {
      return { valid: false, error: 'REGISTER_MISMATCH', message: 'Challenge was generated for a different register terminal.' };
    }

    if (txId && record.txId && record.txId !== txId) {
      return { valid: false, error: 'TRANSACTION_MISMATCH', message: 'Challenge was issued for a different transaction.' };
    }

    record.used = true;
    return { valid: true };
  }

  /**
   * Checks supervisor account lockout status.
   */
  isUserLockedOut(user) {
    if (!user || !user.lockedUntil) return false;
    const lockedUntil = new Date(user.lockedUntil).getTime();
    if (Date.now() < lockedUntil) {
      return true;
    }
    // Lockout expired, reset counter
    user.lockedUntil = null;
    user.failedBiometricCount = 0;
    db.saveUser(user);
    return false;
  }

  /**
   * Handles failed biometric attempt count and triggers account lockout if exceeded.
   */
  recordFailedAttempt(user, branchId, registerId, reason) {
    if (!user) return;
    user.failedBiometricCount = (user.failedBiometricCount || 0) + 1;

    AuditLogger.log({
      eventType: 'FAILED_VERIFICATION_ATTEMPT',
      userId: user.id,
      userName: user.name,
      userRole: user.role,
      branchId,
      registerId,
      action: 'BIOMETRIC_VERIFY',
      status: 'FAILED',
      reason: `Failed attempt ${user.failedBiometricCount}/${config.security.maxFailedAttempts}: ${reason}`
    });

    if (user.failedBiometricCount >= config.security.maxFailedAttempts) {
      const lockDuration = config.security.lockoutDurationMs;
      user.lockedUntil = new Date(Date.now() + lockDuration).toISOString();
      db.saveUser(user);

      AuditLogger.log({
        eventType: 'ACCOUNT_LOCKOUT',
        userId: user.id,
        userName: user.name,
        userRole: user.role,
        branchId,
        registerId,
        action: 'SECURITY_LOCKOUT',
        status: 'BLOCKED',
        reason: `Supervisor biometric locked for 5 minutes due to ${user.failedBiometricCount} consecutive failed attempts.`
      });

      return { locked: true, lockedUntil: user.lockedUntil };
    }

    db.saveUser(user);
    return { locked: false, attemptsRemaining: config.security.maxFailedAttempts - user.failedBiometricCount };
  }

  /**
   * Resets failed attempt counter upon successful biometric verification.
   */
  recordSuccessfulAttempt(user) {
    if (!user) return;
    if (user.failedBiometricCount > 0 || user.lockedUntil) {
      user.failedBiometricCount = 0;
      user.lockedUntil = null;
      db.saveUser(user);
    }
  }
}

// Singleton
module.exports = new SessionManager();
