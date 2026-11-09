const crypto = require('crypto');

/**
 * Cryptographic utility functions for Biometric Challenge-Response authentication.
 * Complies with FIDO2 / WebAuthn / WBF cryptographic assertion standards.
 * Zero raw biometric images or templates stored.
 */
class CryptoUtils {
  /**
   * Generates a cryptographically random single-use challenge.
   * @param {number} bytes Length in bytes
   * @returns {string} Hex encoded challenge
   */
  static generateNonce(bytes = 32) {
    return crypto.randomBytes(bytes).toString('hex');
  }

  /**
   * Generates a new ECDSA P-256 (prime256v1) keypair for hardware-token/device-managed credential simulation.
   * In a physical hardware reader with secure enclave/TPM, private keys never leave the hardware.
   * For software verification, the backend only ever stores the public key.
   */
  static generateBiometricKeyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      publicKeyEncoding: {
        type: 'spki',
        format: 'pem'
      },
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem'
      }
    });
    return { publicKey, privateKey };
  }

  /**
   * Signs a biometric payload (challenge + deviceId + action) with the credential private key.
   * Simulated device-managed or WBF/TPM signing.
   * @param {string} payload String to sign
   * @param {string} privateKeyPem PKCS8 PEM private key
   * @returns {string} Base64 encoded signature
   */
  static signPayload(payload, privateKeyPem) {
    const sign = crypto.createSign('SHA256');
    sign.update(payload);
    sign.end();
    return sign.sign(privateKeyPem, 'base64');
  }

  /**
   * Verifies an ECDSA signature using the registered supervisor's public key.
   * @param {string} payload Original payload signed
   * @param {string} signatureBase64 Base64 signature
   * @param {string} publicKeyPem SPKI PEM public key
   * @returns {boolean} True if signature is valid
   */
  static verifySignature(payload, signatureBase64, publicKeyPem) {
    try {
      const verify = crypto.createVerify('SHA256');
      verify.update(payload);
      verify.end();
      return verify.verify(publicKeyPem, signatureBase64, 'base64');
    } catch (err) {
      return false;
    }
  }

  /**
   * Generates a SHA-256 hash
   */
  static sha256(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Generates a unique ID (UUID v4)
   */
  static generateUuid() {
    return crypto.randomUUID();
  }

  /**
   * Verifies emergency administrator passcode hash (PBKDF2)
   */
  static verifyEmergencyPassword(password, storedHash, salt) {
    const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
    return hash === storedHash;
  }

  /**
   * Creates an emergency administrator passcode hash (PBKDF2)
   */
  static hashEmergencyPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
    return { hash, salt };
  }
}

module.exports = CryptoUtils;

