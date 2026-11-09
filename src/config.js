// Biometric Supervisor Authorization POS Configuration
const path = require('path');

module.exports = {
  server: {
    port: process.env.PORT || 3000,
    host: '127.0.0.1'
  },
  db: {
    storagePath: path.join(__dirname, '..', 'data', 'pos_store.json')
  },
  security: {
    // Single-use authorization challenge validity in milliseconds (60 seconds)
    challengeTimeoutMs: 60 * 1000,
    // Maximum failed biometric attempts before supervisor biometric lockout
    maxFailedAttempts: 3,
    // Lockout duration in milliseconds (5 minutes)
    lockoutDurationMs: 5 * 60 * 1000,
    // Enforce cryptographic signature verification on all biometric assertions
    enforceCryptoSignature: true,
    // WebAuthn / FIDO2 Relying Party details
    rpId: 'localhost',
    rpName: 'Supermarket POS Biometric Hub'
  },
  terminal: {
    defaultBranchId: 'BR-001',
    defaultBranchName: 'Metropolis Central Supermarket',
    defaultRegisterId: 'REG-01',
    defaultCurrency: '$'
  }
};

