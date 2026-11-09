const db = require('../db/sqlite-store');
const CryptoUtils = require('./crypto-utils');

/**
 * Strict Hierarchical Role Creation & Management Engine.
 * 
 * Hierarchy Rules:
 * 1. Super Admin creates Business Owner (with business name, location, and monthly subscription due on the 1st of every month).
 * 2. Business Owner creates Business Admin.
 * 3. Business Admin creates Branch Manager.
 * 4. Branch Manager creates and manages all other roles (Supervisor, Cashier, Stock Manager, Procurement, Accountant, Auditor).
 */
class HierarchyService {
  /**
   * Super Admin creates a new Supermarket Business Owner.
   */
  static createBusinessOwner({
    creatorRole,
    businessName,
    tradeName,
    location,
    kraPin,
    businessPhone,
    ownerFullName,
    ownerEmail,
    password,
    monthlySubscriptionKes = 6500.00,
    planTier = 'growth'
  }) {
    if (creatorRole !== 'super_admin') {
      return {
        success: false,
        error: 'FORBIDDEN',
        message: 'Only a SaaS Super Admin can register a new Supermarket and Business Owner.'
      };
    }

    if (!businessName || !ownerEmail || !password || !ownerFullName) {
      return {
        success: false,
        error: 'MISSING_FIELDS',
        message: 'Business name, owner name, email, and password are required.'
      };
    }

    const cleanSlug = businessName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const existing = db.queryOne('SELECT id FROM tenants WHERE slug = ? OR email = ?', [cleanSlug, ownerEmail]);
    if (existing) {
      return { success: false, error: 'EXISTS', message: 'A business with this slug or owner email already exists.' };
    }

    const tenantId = `tenant_${cleanSlug}_${Date.now().toString().slice(-4)}`;
    const branchId = `BR-${cleanSlug.slice(0, 3).toUpperCase()}-01`;
    const registerId = `REG-${cleanSlug.slice(0, 3).toUpperCase()}-01`;
    const userId = `usr_${cleanSlug}_owner`;

    const { hash, salt } = CryptoUtils.hashEmergencyPassword(password);
    const fee = Number(monthlySubscriptionKes) || 6500.00;

    db.transaction(() => {
      // 1. Insert Tenant with 1st-of-month subscription schedule
      db.run(
        `INSERT INTO tenants (id, name, slug, trade_name, kra_pin, phone, email, currency, plan_id, status, trial_ends_at, subscription_expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'KES', ?, 'ACTIVE', NULL, datetime('now', '+30 days'))`,
        [tenantId, businessName, cleanSlug, tradeName || businessName, kraPin || 'P051234567Z', businessPhone || '254700000000', ownerEmail, planTier]
      );

      // 2. Insert Default Branch
      db.run(
        `INSERT INTO branches (id, tenant_id, code, name, location, phone, status)
         VALUES (?, ?, 'MAIN', ?, ?, ?, 'ACTIVE')`,
        [branchId, tenantId, `${businessName} Main Branch`, location || 'Nairobi', businessPhone]
      );

      // 3. Insert Default Register (Till 1)
      db.run(
        `INSERT INTO registers (id, tenant_id, branch_id, code, name, printer_type, status)
         VALUES (?, ?, ?, 'TILL-01', 'Express Lane 1', 'ESC_POS_80MM', 'ONLINE')`,
        [registerId, tenantId, branchId]
      );

      // 4. Insert Business Owner Account
      db.run(
        `INSERT INTO users (id, tenant_id, username, email, password_hash, password_salt, full_name, phone, role, branch_id, permissions_json, pin_code, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'owner', 'ALL', ?, '1111', 1)`,
        [userId, tenantId, ownerEmail.split('@')[0], ownerEmail, hash, salt, ownerFullName, businessPhone, JSON.stringify(['ALL_BUSINESS_CONTROL', 'FINANCIAL_REPORTS', 'MANAGE_BRANCHES', 'MANAGE_ADMINS'])]
      );

      // 5. Seed Starter FMCG Catalog
      const sampleProds = db.queryAll('SELECT * FROM products WHERE tenant_id = ? LIMIT 10', ['tenant_metromart']);
      sampleProds.forEach(p => {
        const newPid = `PRD-${cleanSlug.slice(0, 3).toUpperCase()}-${p.barcode.slice(-4)}`;
        db.run(
          `INSERT INTO products (id, tenant_id, name, barcode, sku, category, unit, cost_price_kes, selling_price_kes, wholesale_price_kes, vat_rate, min_stock, is_weighed, is_active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [newPid, tenantId, p.name, p.barcode, `${cleanSlug.toUpperCase()}-${p.sku}`, p.category, p.unit, p.cost_price_kes, p.selling_price_kes, p.wholesale_price_kes, p.vat_rate, p.min_stock, p.is_weighed]
        );
        db.run(
          `INSERT INTO inventory (id, tenant_id, branch_id, product_id, quantity, reorder_level)
           VALUES (?, ?, ?, ?, 100, ?)`,
          [`INV-${newPid}`, tenantId, branchId, newPid, p.min_stock]
        );
      });
    });

    return {
      success: true,
      message: `Business Owner ${ownerFullName} successfully created for ${businessName}. Monthly subscription set to KES ${fee.toLocaleString()} due on the 1st of every month.`,
      business: {
        tenantId,
        businessName,
        location,
        ownerEmail,
        ownerFullName,
        monthlySubscriptionKes: fee,
        billingSchedule: '1st of every month',
        defaultBranchId: branchId
      }
    };
  }

  /**
   * Business Owner creates a Business Admin.
   */
  static createBusinessAdmin({
    creatorRole,
    creatorTenantId,
    fullName,
    email,
    username,
    password,
    phone
  }) {
    if (creatorRole !== 'owner') {
      return {
        success: false,
        error: 'FORBIDDEN',
        message: 'Only the Business Owner can appoint Business Admins.'
      };
    }

    if (!fullName || !email || !password) {
      return { success: false, error: 'MISSING_FIELDS', message: 'Full name, email, and password are required.' };
    }

    const existing = db.queryOne('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) {
      return { success: false, error: 'EXISTS', message: 'A user with this email already exists.' };
    }

    const { hash, salt } = CryptoUtils.hashEmergencyPassword(password);
    const userId = `usr_adm_${Date.now().toString().slice(-4)}`;

    db.run(
      `INSERT INTO users (id, tenant_id, username, email, password_hash, password_salt, full_name, phone, role, branch_id, permissions_json, pin_code, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'admin', 'ALL', ?, '2222', 1)`,
      [userId, creatorTenantId, username || email.split('@')[0], email, hash, salt, fullName, phone || '', JSON.stringify(['MANAGE_USERS', 'MANAGE_PRODUCTS', 'MANAGE_INVENTORY', 'MANAGE_BRANCH_MANAGERS'])]
    );

    return {
      success: true,
      message: `Business Admin ${fullName} successfully created.`,
      user: { id: userId, fullName, email, role: 'admin' }
    };
  }

  /**
   * Business Admin (or Owner) creates a Branch Manager.
   */
  static createBranchManager({
    creatorRole,
    creatorTenantId,
    fullName,
    email,
    username,
    password,
    phone,
    branchId
  }) {
    if (creatorRole !== 'admin' && creatorRole !== 'owner') {
      return {
        success: false,
        error: 'FORBIDDEN',
        message: 'Only a Business Admin or Owner can appoint Branch Managers.'
      };
    }

    if (!fullName || !email || !password || !branchId) {
      return { success: false, error: 'MISSING_FIELDS', message: 'Full name, email, password, and assigned branch are required.' };
    }

    const existing = db.queryOne('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) {
      return { success: false, error: 'EXISTS', message: 'A user with this email already exists.' };
    }

    const branch = db.queryOne('SELECT * FROM branches WHERE id = ? AND tenant_id = ?', [branchId, creatorTenantId]);
    if (!branch) {
      return { success: false, error: 'INVALID_BRANCH', message: 'Branch not found in this supermarket.' };
    }

    const { hash, salt } = CryptoUtils.hashEmergencyPassword(password);
    const userId = `usr_mgr_${Date.now().toString().slice(-4)}`;

    db.run(
      `INSERT INTO users (id, tenant_id, username, email, password_hash, password_salt, full_name, phone, role, branch_id, permissions_json, pin_code, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'branch_manager', ?, ?, '3333', 1)`,
      [userId, creatorTenantId, username || email.split('@')[0], email, hash, salt, fullName, phone || '', branchId, JSON.stringify(['BRANCH_OPERATIONS', 'APPROVE_RETURNS', 'MONITOR_SHIFTS', 'MANAGE_STAFF'])]
    );

    return {
      success: true,
      message: `Branch Manager ${fullName} appointed for ${branch.name}.`,
      user: { id: userId, fullName, email, role: 'branch_manager', branchId }
    };
  }

  /**
   * Branch Manager creates operational staff for their assigned branch.
   */
  static createStaff({
    creatorRole,
    creatorTenantId,
    creatorBranchId,
    role, // supervisor, cashier, inventory_manager, procurement_officer, accountant, auditor
    fullName,
    email,
    username,
    password,
    phone,
    pinCode = '0000'
  }) {
    if (creatorRole !== 'branch_manager' && creatorRole !== 'admin' && creatorRole !== 'owner') {
      return {
        success: false,
        error: 'FORBIDDEN',
        message: 'Only a Branch Manager, Admin, or Owner can create branch staff.'
      };
    }

    const allowedRoles = ['supervisor', 'cashier', 'inventory_manager', 'procurement_officer', 'accountant', 'auditor'];
    if (!allowedRoles.includes(role)) {
      return {
        success: false,
        error: 'INVALID_ROLE',
        message: `Role must be one of: ${allowedRoles.join(', ')}`
      };
    }

    if (!fullName || !email || !password) {
      return { success: false, error: 'MISSING_FIELDS', message: 'Full name, email, and password are required.' };
    }

    const existing = db.queryOne('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) {
      return { success: false, error: 'EXISTS', message: 'A user with this email already exists.' };
    }

    const { hash, salt } = CryptoUtils.hashEmergencyPassword(password);
    const userId = `usr_${role.slice(0, 3)}_${Date.now().toString().slice(-4)}`;

    let defaultPermissions = [];
    if (role === 'supervisor') defaultPermissions = ['SUSPEND_TRANSACTION', 'RESUME_TRANSACTION', 'APPROVE_DISCOUNTS', 'BIOMETRIC_AUTH'];
    if (role === 'cashier') defaultPermissions = ['POS_CHECKOUT', 'ITEM_SCAN', 'MPESA_PAYMENT', 'CASH_SALE', 'REQUEST_SUSPEND'];
    if (role === 'inventory_manager') defaultPermissions = ['STOCK_ADJUSTMENT', 'STOCK_TRANSFER', 'RECEIVE_DELIVERY'];
    if (role === 'procurement_officer') defaultPermissions = ['PURCHASE_ORDERS', 'MANAGE_SUPPLIERS'];
    if (role === 'accountant') defaultPermissions = ['FINANCIAL_STATEMENTS', 'TAX_RECONCILIATION', 'EXPENSES'];
    if (role === 'auditor') defaultPermissions = ['READ_ONLY_AUDIT', 'AUDIT_LOG_INSPECTION'];

    db.run(
      `INSERT INTO users (id, tenant_id, username, email, password_hash, password_salt, full_name, phone, role, branch_id, permissions_json, pin_code, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [userId, creatorTenantId, username || email.split('@')[0], email, hash, salt, fullName, phone || '', role, creatorBranchId || 'BR-001', JSON.stringify(defaultPermissions), pinCode]
    );

    return {
      success: true,
      message: `${role.replace(/_/g, ' ').toUpperCase()} ${fullName} successfully appointed.`,
      user: { id: userId, fullName, email, role, branchId: creatorBranchId }
    };
  }
}

module.exports = HierarchyService;
