const assert = require('assert');
const CryptoUtils = require('../src/security/crypto-utils');

function runCryptoTests() {
  console.log('--- Running Cryptographic Security Tests ---');

  // 1. Nonce uniqueness
  const nonce1 = CryptoUtils.generateNonce(32);
  const nonce2 = CryptoUtils.generateNonce(32);
  assert.strictEqual(nonce1.length, 64);
  assert.notStrictEqual(nonce1, nonce2, 'Random nonces must never collide');
  console.log('[PASS] Nonce generation: length 64 hex characters, random & distinct');

  // 2. Keypair generation & ECDSA verification
  const { publicKey, privateKey } = CryptoUtils.generateBiometricKeyPair();
  assert.ok(publicKey.includes('BEGIN PUBLIC KEY'));
  assert.ok(privateKey.includes('BEGIN PRIVATE KEY'));

  const payload = `CHALLENGE|${nonce1}|DEV-01`;
  const signature = CryptoUtils.signPayload(payload, privateKey);
  assert.ok(signature, 'Signature must be generated');

  const isValid = CryptoUtils.verifySignature(payload, signature, publicKey);
  assert.strictEqual(isValid, true, 'Valid signature must verify with public key');

  // 3. Tampering detection
  const tamperedPayload = `CHALLENGE|${nonce2}|DEV-01`;
  const isTamperedValid = CryptoUtils.verifySignature(tamperedPayload, signature, publicKey);
  assert.strictEqual(isTamperedValid, false, 'Tampered payload must fail cryptographic verification');

  // 4. Emergency Passcode Hashing (PBKDF2)
  const password = 'Test@AdminPasscode2026!';
  const { hash, salt } = CryptoUtils.hashEmergencyPassword(password);
  assert.ok(hash && salt);
  assert.strictEqual(CryptoUtils.verifyEmergencyPassword(password, hash, salt), true);
  assert.strictEqual(CryptoUtils.verifyEmergencyPassword('WrongPass', hash, salt), false);
  console.log('[PASS] PBKDF2 Master Passcode hashing & verification passed');

  console.log('✅ All Cryptographic Security Tests Passed!\n');
}

if (require.main === module) {
  runCryptoTests();
}

module.exports = { runCryptoTests };

