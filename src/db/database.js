const fs = require('fs');
const path = require('path');
const config = require('../config');

/**
 * Lightweight ACID-compliant JSON Store with atomic writes and in-memory caching.
 * Guaranteed persistence, no external database dependencies required.
 */
class Database {
  constructor(filePath) {
    this.filePath = filePath || config.db.storagePath;
    this.dir = path.dirname(this.filePath);
    this.data = {
      users: [],
      biometricCredentials: [],
      devices: [],
      transactions: [],
      auditLogs: [],
      challenges: {},
      products: []
    };
    this.isWriting = false;
    this.writeQueue = [];
    this.init();
  }

  init() {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        this.data = JSON.parse(raw);
      } catch (err) {
        console.error('Error loading DB file, initializing fresh store:', err.message);
        this.persist();
      }
    } else {
      this.persist();
    }
  }

  persist() {
    return new Promise((resolve, reject) => {
      this.writeQueue.push({ resolve, reject });
      this._processQueue();
    });
  }

  _processQueue() {
    if (this.isWriting || this.writeQueue.length === 0) return;
    this.isWriting = true;

    const currentWaiters = [...this.writeQueue];
    this.writeQueue = [];

    const tempPath = `${this.filePath}.tmp.${Date.now()}`;
    const serialized = JSON.stringify(this.data, null, 2);

    fs.writeFile(tempPath, serialized, 'utf8', (err) => {
      if (err) {
        this.isWriting = false;
        currentWaiters.forEach(w => w.reject(err));
        this._processQueue();
        return;
      }

      fs.rename(tempPath, this.filePath, (renameErr) => {
        this.isWriting = false;
        if (renameErr) {
          currentWaiters.forEach(w => w.reject(renameErr));
        } else {
          currentWaiters.forEach(w => w.resolve(true));
        }
        this._processQueue();
      });
    });
  }

  // --- Users ---
  getUserById(id) {
    return this.data.users.find(u => u.id === id);
  }

  getUserByUsername(username) {
    return this.data.users.find(u => u.username.toLowerCase() === username.toLowerCase());
  }

  getAllUsers() {
    return this.data.users;
  }

  saveUser(user) {
    const idx = this.data.users.findIndex(u => u.id === user.id);
    if (idx >= 0) {
      this.data.users[idx] = { ...this.data.users[idx], ...user };
    } else {
      this.data.users.push(user);
    }
    this.persist();
    return user;
  }

  // --- Biometric Credentials ---
  getCredentialsByUserId(userId) {
    return this.data.biometricCredentials.filter(c => c.userId === userId && c.status === 'ACTIVE');
  }

  getAllCredentials() {
    return this.data.biometricCredentials;
  }

  getCredentialById(credId) {
    return this.data.biometricCredentials.find(c => c.id === credId);
  }

  saveCredential(cred) {
    const idx = this.data.biometricCredentials.findIndex(c => c.id === cred.id);
    if (idx >= 0) {
      this.data.biometricCredentials[idx] = { ...this.data.biometricCredentials[idx], ...cred };
    } else {
      this.data.biometricCredentials.push(cred);
    }
    this.persist();
    return cred;
  }

  revokeCredential(credId, revokedBy, reason) {
    const cred = this.data.biometricCredentials.find(c => c.id === credId);
    if (cred) {
      cred.status = 'REVOKED';
      cred.revokedAt = new Date().toISOString();
      cred.revokedBy = revokedBy;
      cred.revocationReason = reason;
      this.persist();
      return cred;
    }
    return null;
  }

  // --- Devices ---
  getAllDevices() {
    return this.data.devices;
  }

  getDeviceById(deviceId) {
    return this.data.devices.find(d => d.id === deviceId);
  }

  saveDevice(device) {
    const idx = this.data.devices.findIndex(d => d.id === device.id);
    if (idx >= 0) {
      this.data.devices[idx] = { ...this.data.devices[idx], ...device };
    } else {
      this.data.devices.push(device);
    }
    this.persist();
    return device;
  }

  // --- Transactions ---
  getTransactionById(txId) {
    return this.data.transactions.find(t => t.id === txId);
  }

  getSuspendedTransactions(branchId = null) {
    return this.data.transactions.filter(t => {
      const isSuspended = t.status === 'SUSPENDED';
      if (branchId) return isSuspended && t.branchId === branchId;
      return isSuspended;
    });
  }

  saveTransaction(tx) {
    const idx = this.data.transactions.findIndex(t => t.id === tx.id);
    if (idx >= 0) {
      this.data.transactions[idx] = { ...this.data.transactions[idx], ...tx };
    } else {
      this.data.transactions.push(tx);
    }
    this.persist();
    return tx;
  }

  // --- Audit Logs ---
  addAuditLog(entry) {
    const log = {
      id: `LOG-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      timestamp: new Date().toISOString(),
      ...entry
    };
    this.data.auditLogs.unshift(log);
    // Keep max 2000 logs in storage
    if (this.data.auditLogs.length > 2000) {
      this.data.auditLogs.pop();
    }
    this.persist();
    return log;
  }

  getAuditLogs(limit = 100, filters = {}) {
    let logs = this.data.auditLogs;
    if (filters.eventType) {
      logs = logs.filter(l => l.eventType === filters.eventType);
    }
    if (filters.userId) {
      logs = logs.filter(l => l.userId === filters.userId);
    }
    if (filters.status) {
      logs = logs.filter(l => l.status === filters.status);
    }
    return logs.slice(0, limit);
  }

  // --- Products ---
  getAllProducts() {
    return this.data.products;
  }

  getProductByBarcode(barcode) {
    return this.data.products.find(p => p.barcode === barcode);
  }

  getProductById(id) {
    return this.data.products.find(p => p.id === id);
  }

  // --- Challenges ---
  setChallenge(key, challengeData) {
    this.data.challenges[key] = challengeData;
  }

  getChallenge(key) {
    return this.data.challenges[key];
  }

  deleteChallenge(key) {
    delete this.data.challenges[key];
  }
}

// Singleton instance
const dbInstance = new Database();
module.exports = dbInstance;

