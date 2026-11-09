/**
 * Abstract Base Driver for Biometric Hardware Readers.
 * All manufacturer-specific adapters implement this interface.
 */
class BaseBiometricDriver {
  constructor(driverName, options = {}) {
    this.driverName = driverName;
    this.options = options;
    this.connected = false;
    this.activeDevice = null;
  }

  async initialize() {
    throw new Error('initialize() must be implemented by driver');
  }

  async getStatus() {
    return {
      driver: this.driverName,
      connected: this.connected,
      device: this.activeDevice,
      timestamp: new Date().toISOString()
    };
  }

  async captureAssertion(challenge, context = {}) {
    throw new Error('captureAssertion() must be implemented by driver');
  }

  async enrollBiometric(userId, options = {}) {
    throw new Error('enrollBiometric() must be implemented by driver');
  }

  async cancelCapture() {
    return true;
  }
}

module.exports = BaseBiometricDriver;

