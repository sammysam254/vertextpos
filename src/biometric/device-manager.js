const db = require('../db/database');
const AuditLogger = require('../security/audit-logger');

/**
 * Biometric Device Connection & Health Monitoring Service.
 * Tracks hardware device presence across POS terminals and registers.
 */
class DeviceManager {
  constructor() {
    this.primaryDeviceId = 'DEV-FP-01';
    this.connectionState = 'CONNECTED'; // CONNECTED, DISCONNECTED, ERROR
    this.lastHealthCheck = Date.now();
  }

  getPrimaryDevice() {
    const dev = db.getDeviceById(this.primaryDeviceId);
    if (dev) {
      return {
        ...dev,
        status: this.connectionState,
        lastHealthCheck: new Date(this.lastHealthCheck).toISOString()
      };
    }
    return null;
  }

  isDeviceConnected() {
    return this.connectionState === 'CONNECTED';
  }

  getHardwareStatusMessage() {
    if (this.connectionState === 'CONNECTED') {
      const dev = this.getPrimaryDevice();
      return {
        connected: true,
        device: dev,
        message: `Biometric Reader Active: ${dev ? dev.name : 'Fingerprint Sensor'} (${dev ? dev.serialNumber : 'OK'})`
      };
    } else if (this.connectionState === 'DISCONNECTED') {
      return {
        connected: false,
        device: null,
        message: 'No supported fingerprint reader is connected. Please connect a compatible USB reader or enable Windows Biometric Framework.'
      };
    } else {
      return {
        connected: false,
        device: null,
        message: 'Hardware Error: Fingerprint sensor hardware fault or driver failure. Emergency override required.'
      };
    }
  }

  setDeviceConnectionState(state, reason = 'Hardware state changed') {
    const oldState = this.connectionState;
    this.connectionState = state;
    this.lastHealthCheck = Date.now();

    const dev = db.getDeviceById(this.primaryDeviceId);
    if (dev) {
      dev.status = state;
      dev.lastHealthCheck = new Date().toISOString();
      db.saveDevice(dev);
    }

    if (oldState !== state) {
      AuditLogger.log({
        eventType: state === 'CONNECTED' ? 'DEVICE_CONNECTED' : 'DEVICE_DISCONNECTED',
        userId: 'HARDWARE_MONITOR',
        userName: 'Biometric Device Monitor',
        userRole: 'system',
        branchId: dev ? dev.branchId : 'BR-001',
        registerId: dev ? dev.registerId : 'REG-01',
        action: 'DEVICE_HEALTH_STATUS_CHANGE',
        status: state === 'CONNECTED' ? 'SUCCESS' : 'FAILED',
        deviceId: this.primaryDeviceId,
        reason: `${reason}: status changed from ${oldState} to ${state}`
      });
    }

    return this.getHardwareStatusMessage();
  }

  getAllRegisteredDevices() {
    return db.getAllDevices();
  }
}

module.exports = new DeviceManager();

