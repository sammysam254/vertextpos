const db = require('./database');
const CryptoUtils = require('../security/crypto-utils');

// Generate pre-paired ECDSA P-256 biometric keypairs for seeded supervisors
const aliceKeys = CryptoUtils.generateBiometricKeyPair();
const bobKeys = CryptoUtils.generateBiometricKeyPair();
const carolKeys = CryptoUtils.generateBiometricKeyPair();
const cashierDaveKeys = CryptoUtils.generateBiometricKeyPair();

// Emergency Admin Passcode: "Admin@Emergency2026!"
const adminSecret = CryptoUtils.hashEmergencyPassword('Admin@Emergency2026!');

function seedDatabase() {
  console.log('[SEED] Initializing Supermarket POS database with biometric seeds...');

  // 1. Users
  const users = [
    {
      id: 'user_s01',
      username: 'alice.vance',
      name: 'Alice Vance',
      role: 'supervisor',
      title: 'Senior Floor Supervisor',
      branchId: 'BR-001',
      allowedRegisters: ['ALL'],
      permissions: ['SUSPEND_TRANSACTION', 'RESUME_TRANSACTION', 'BIOMETRIC_ENROLL', 'PRICE_OVERRIDE'],
      pin: '1234',
      active: true,
      failedBiometricCount: 0,
      lockedUntil: null
    },
    {
      id: 'user_s02',
      username: 'bob.chen',
      name: 'Bob Chen',
      role: 'supervisor',
      title: 'Shift Supervisor',
      branchId: 'BR-001',
      allowedRegisters: ['ALL'],
      permissions: ['SUSPEND_TRANSACTION', 'RESUME_TRANSACTION'],
      pin: '2345',
      active: true,
      failedBiometricCount: 0,
      lockedUntil: null
    },
    {
      id: 'user_s03',
      username: 'carol.diaz',
      name: 'Carol Diaz',
      role: 'supervisor',
      title: 'Uptown Branch Supervisor',
      branchId: 'BR-002', // Different branch!
      allowedRegisters: ['ALL'],
      permissions: ['SUSPEND_TRANSACTION', 'RESUME_TRANSACTION'],
      pin: '3456',
      active: true,
      failedBiometricCount: 0,
      lockedUntil: null
    },
    {
      id: 'user_c01',
      username: 'dave.miller',
      name: 'Dave Miller',
      role: 'cashier',
      title: 'POS Cashier 1',
      branchId: 'BR-001',
      allowedRegisters: ['REG-01'],
      permissions: ['POS_CHECKOUT', 'ITEM_SCAN'],
      pin: '0000',
      active: true,
      failedBiometricCount: 0,
      lockedUntil: null
    },
    {
      id: 'user_c02',
      username: 'sarah.jenkins',
      name: 'Sarah Jenkins',
      role: 'cashier',
      title: 'POS Cashier 2',
      branchId: 'BR-001',
      allowedRegisters: ['REG-02'],
      permissions: ['POS_CHECKOUT', 'ITEM_SCAN'],
      pin: '1111',
      active: true,
      failedBiometricCount: 0,
      lockedUntil: null
    },
    {
      id: 'user_admin',
      username: 'eleanor.wright',
      name: 'Eleanor Wright',
      role: 'administrator',
      title: 'General Store Director',
      branchId: 'BR-001',
      allowedRegisters: ['ALL'],
      permissions: ['EMERGENCY_OVERRIDE', 'SYSTEM_CONFIG', 'AUDIT_REVIEW'],
      emergencyPasswordHash: adminSecret.hash,
      emergencyPasswordSalt: adminSecret.salt,
      active: true
    }
  ];

  // 2. Biometric Credentials (Zero raw templates: only public key & credential metadata stored)
  const biometricCredentials = [
    {
      id: 'cred_alice_wbf_01',
      userId: 'user_s01',
      userName: 'Alice Vance',
      algorithm: 'ES256',
      publicKey: aliceKeys.publicKey,
      signCount: 1,
      deviceType: 'WBF_FINGERPRINT',
      deviceSerial: 'DP-UAREU4500-SN8492',
      enrolledAt: new Date(Date.now() - 30 * 86400000).toISOString(),
      revokedAt: null,
      status: 'ACTIVE',
      branchPermissions: ['BR-001'],
      enrolledBy: 'user_s01'
    },
    {
      id: 'cred_bob_wbf_01',
      userId: 'user_s02',
      userName: 'Bob Chen',
      algorithm: 'ES256',
      publicKey: bobKeys.publicKey,
      signCount: 1,
      deviceType: 'WBF_FINGERPRINT',
      deviceSerial: 'DP-UAREU4500-SN8492',
      enrolledAt: new Date(Date.now() - 15 * 86400000).toISOString(),
      revokedAt: null,
      status: 'ACTIVE',
      branchPermissions: ['BR-001'],
      enrolledBy: 'user_s02'
    },
    {
      id: 'cred_carol_wbf_01',
      userId: 'user_s03',
      userName: 'Carol Diaz',
      algorithm: 'ES256',
      publicKey: carolKeys.publicKey,
      signCount: 1,
      deviceType: 'WBF_FINGERPRINT',
      deviceSerial: 'DP-UAREU4500-SN9999',
      enrolledAt: new Date(Date.now() - 5 * 86400000).toISOString(),
      revokedAt: null,
      status: 'ACTIVE',
      branchPermissions: ['BR-002'], // Assigned only to BR-002
      enrolledBy: 'user_s03'
    },
    {
      id: 'cred_cashier_dave_01',
      userId: 'user_c01',
      userName: 'Dave Miller (Cashier)',
      algorithm: 'ES256',
      publicKey: cashierDaveKeys.publicKey,
      signCount: 1,
      deviceType: 'WBF_FINGERPRINT',
      deviceSerial: 'DP-UAREU4500-SN8492',
      enrolledAt: new Date(Date.now() - 2 * 86400000).toISOString(),
      revokedAt: null,
      status: 'ACTIVE',
      branchPermissions: ['BR-001'],
      enrolledBy: 'user_c01'
    }
  ];

  // 3. Biometric Devices
  const devices = [
    {
      id: 'DEV-FP-01',
      name: 'DigitalPersona U.are.U 4500 USB Reader',
      driver: 'WBF_DRIVER',
      manufacturer: 'DigitalPersona / HID Global',
      model: 'U.are.U 4500',
      serialNumber: 'DP-UAREU4500-SN8492',
      status: 'CONNECTED',
      branchId: 'BR-001',
      registerId: 'REG-01',
      firmwareVersion: 'v3.1.2024',
      supportedModes: ['WBF_WINBIO', 'DEVICE_CHALLENGE_RESPONSE'],
      lastHealthCheck: new Date().toISOString()
    },
    {
      id: 'DEV-FP-02',
      name: 'SecuGen Hamster Pro 20 USB Reader',
      driver: 'USB_SDK_DRIVER',
      manufacturer: 'SecuGen Corporation',
      model: 'Hamster Pro 20 (HU20)',
      serialNumber: 'SG-HAMSTER20-SN4105',
      status: 'STANDBY',
      branchId: 'BR-001',
      registerId: 'REG-02',
      firmwareVersion: 'v2.8.2023',
      supportedModes: ['SECUGEN_SDK', 'DEVICE_CHALLENGE_RESPONSE'],
      lastHealthCheck: new Date().toISOString()
    },
    {
      id: 'DEV-FP-03',
      name: 'Windows Hello Platform Authenticator',
      driver: 'WEBAUTHN_DRIVER',
      manufacturer: 'Microsoft / Platform TPM 2.0',
      model: 'Windows Hello Biometric Provider',
      serialNumber: 'WH-HELLO-PLATFORM-01',
      status: 'CONNECTED',
      branchId: 'BR-001',
      registerId: 'REG-01',
      firmwareVersion: 'WBF 10.0',
      supportedModes: ['WEBAUTHN_FIDO2', 'PLATFORM_ENCLAVE'],
      lastHealthCheck: new Date().toISOString()
    }
  ];

  // 4. Products Catalog
  const products = [
    { id: 'PRD-001', barcode: '011110000018', name: 'Organic Whole Milk 1 Gallon', price: 4.89, category: 'Dairy', stock: 45 },
    { id: 'PRD-002', barcode: '011110000025', name: 'Artisan Sourdough Loaf 500g', price: 3.99, category: 'Bakery', stock: 30 },
    { id: 'PRD-003', barcode: '011110000032', name: 'Crisp Honeycrisp Apples 1kg', price: 5.49, category: 'Produce', stock: 120 },
    { id: 'PRD-004', barcode: '011110000049', name: 'Fair Trade Organic Dark Roast 250g', price: 8.99, category: 'Beverage', stock: 60 },
    { id: 'PRD-005', barcode: '011110000056', name: 'Free-Range Brown Eggs Grade A (12pk)', price: 4.59, category: 'Dairy', stock: 80 },
    { id: 'PRD-006', barcode: '011110000063', name: 'Cold Pressed Extra Virgin Olive Oil 500ml', price: 11.29, category: 'Pantry', stock: 25 },
    { id: 'PRD-007', barcode: '011110000070', name: 'Belgian Dark Chocolate 85% Cacao 100g', price: 3.49, category: 'Snacks', stock: 95 },
    { id: 'PRD-008', barcode: '011110000087', name: 'Fresh Organic Orange Juice 1L', price: 4.29, category: 'Beverage', stock: 40 },
    { id: 'PRD-009', barcode: '011110000094', name: 'Grass-Fed Angus Beef Patties 4pk', price: 12.99, category: 'Meat', stock: 35 },
    { id: 'PRD-010', barcode: '011110000100', name: 'Organic Baby Spinach 300g', price: 2.99, category: 'Produce', stock: 50 }
  ];

  // Store in DB
  db.data.users = users;
  db.data.biometricCredentials = biometricCredentials;
  db.data.devices = devices;
  db.data.products = products;
  db.data.transactions = [];
  db.data.auditLogs = [];

  // Log initial system enrollment audit
  db.addAuditLog({
    eventType: 'SYSTEM_INITIALIZATION',
    userId: 'user_admin',
    userName: 'Eleanor Wright',
    userRole: 'administrator',
    branchId: 'BR-001',
    registerId: 'REG-01',
    action: 'SYSTEM_BOOT',
    status: 'SUCCESS',
    deviceId: 'DEV-FP-01',
    reason: 'Initial supermarket POS biometric configuration and seed load'
  });

  db.persist();
  console.log('[SEED] Supermarket POS database successfully seeded.');

  return {
    aliceKeys,
    bobKeys,
    carolKeys,
    cashierDaveKeys
  };
}

// Export seed function and keys for automated acceptance testing
module.exports = {
  seedDatabase,
  aliceKeys,
  bobKeys,
  carolKeys,
  cashierDaveKeys
};

if (require.main === module) {
  seedDatabase();
}

