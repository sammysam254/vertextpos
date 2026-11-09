const crypto = require('crypto');
const db = require('../db/sqlite-store');
const CryptoUtils = require('./crypto-utils');

const JWT_SECRET = process.env.JWT_SECRET || 'pos-saas-kenya-enterprise-secret-key-2026';

class JwtAuth {
  /**
   * Generates a signed HMAC-SHA256 JWT token.
   */
  static signToken(payload, expiresInSeconds = 86400 * 7) {
    const header = { alg: 'HS256', typ: 'JWT' };
    const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const body = { ...payload, exp };

    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
    const encodedBody = Buffer.from(JSON.stringify(body)).toString('base64url');
    const signature = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(`${encodedHeader}.${encodedBody}`)
      .digest('base64url');

    return `${encodedHeader}.${encodedBody}.${signature}`;
  }

  /**
   * Verifies and decodes a JWT token.
   */
  static verifyToken(token) {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;

      const [header, body, signature] = parts;
      const expectedSig = crypto
        .createHmac('sha256', JWT_SECRET)
        .update(`${header}.${body}`)
        .digest('base64url');

      if (signature !== expectedSig) return null;

      const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (decoded.exp && decoded.exp < Math.floor(Date.now() / 1000)) {
        return null; // Expired
      }
      return decoded;
    } catch (e) {
      return null;
    }
  }

  /**
   * Resolves authentication and tenant isolation context from HTTP request.
   */
  static resolveContext(req) {
    let authHeader = req.headers['authorization'] || '';
    let token = null;

    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    } else if (req.headers['x-auth-token']) {
      token = req.headers['x-auth-token'];
    }

    let user = null;
    if (token) {
      user = this.verifyToken(token);
    }

    // Default tenant fallback or header override
    const tenantId = (user && user.tenantId) || req.headers['x-tenant-id'] || 'tenant_metromart';
    const branchId = (user && user.branchId) || req.headers['x-branch-id'] || 'BR-001';
    const registerId = req.headers['x-register-id'] || 'REG-01';

    return {
      user,
      tenantId,
      branchId,
      registerId,
      isAuthenticated: !!user
    };
  }

  /**
   * Registers a new supermarket business tenant on the SaaS platform.
   */
  static registerTenant({
    businessName,
    slug,
    tradeName,
    kraPin,
    phone,
    email,
    password,
    planId = 'growth',
    branchName = 'Flagship Store',
    location = 'Nairobi'
  }) {
    if (!businessName || !email || !password) {
      return { success: false, error: 'MISSING_FIELDS', message: 'Business name, email, and password are required.' };
    }

    const cleanSlug = (slug || businessName.toLowerCase().replace(/[^a-z0-9]/g, '')).toLowerCase();

    // Check if slug or email exists
    const existingTenant = db.queryOne('SELECT id FROM tenants WHERE slug = ? OR email = ?', [cleanSlug, email]);
    if (existingTenant) {
      return { success: false, error: 'TENANT_EXISTS', message: 'A supermarket with this slug or email already exists.' };
    }

    const tenantId = `tenant_${cleanSlug}_${Date.now().toString().slice(-4)}`;
    const branchId = `BR-${cleanSlug.slice(0, 3).toUpperCase()}-01`;
    const registerId = `REG-${cleanSlug.slice(0, 3).toUpperCase()}-01`;
    const userId = `usr_${cleanSlug}_owner`;

    const { hash, salt } = CryptoUtils.hashEmergencyPassword(password);
    const trialEnds = new Date(Date.now() + 14 * 86400000).toISOString();

    db.transaction(() => {
      // 1. Insert Tenant
      db.run(
        `INSERT INTO tenants (id, name, slug, trade_name, kra_pin, phone, email, currency, plan_id, status, trial_ends_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'KES', ?, 'TRIAL', ?)`,
        [tenantId, businessName, cleanSlug, tradeName || businessName, kraPin || 'P050000000Z', phone || '254700000000', email, planId, trialEnds]
      );

      // 2. Insert Default Branch
      db.run(
        `INSERT INTO branches (id, tenant_id, code, name, location, phone, status)
         VALUES (?, ?, 'MAIN', ?, ?, ?, 'ACTIVE')`,
        [branchId, tenantId, branchName, location, phone]
      );

      // 3. Insert Register (Till 1)
      db.run(
        `INSERT INTO registers (id, tenant_id, branch_id, code, name, printer_type, status)
         VALUES (?, ?, ?, 'TILL-01', 'Counter 1 (Express)', 'ESC_POS_80MM', 'ONLINE')`,
        [registerId, tenantId, branchId]
      );

      // 4. Insert Owner User
      db.run(
        `INSERT INTO users (id, tenant_id, username, email, password_hash, password_salt, full_name, phone, role, branch_id, permissions_json, pin_code, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'owner', 'ALL', ?, '1234', 1)`,
        [userId, tenantId, email.split('@')[0], email, hash, salt, `${businessName} Owner`, phone, JSON.stringify(['ALL_BUSINESS_CONTROL'])]
      );

      // 5. Clone initial FMCG catalog to give new tenant an immediate working catalog
      const standardProducts = db.queryAll('SELECT * FROM products WHERE tenant_id = ? LIMIT 12', ['tenant_metromart']);
      const insertProd = db.prepare(`
        INSERT INTO products (id, tenant_id, name, barcode, sku, category, unit, cost_price_kes, selling_price_kes, wholesale_price_kes, vat_rate, min_stock, is_weighed, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertInv = db.prepare(`
        INSERT INTO inventory (id, tenant_id, branch_id, product_id, quantity, reorder_level)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      standardProducts.forEach(p => {
        const newProdId = `PRD-${cleanSlug.slice(0, 3).toUpperCase()}-${p.barcode.slice(-4)}`;
        insertProd.run(newProdId, tenantId, p.name, p.barcode, `${cleanSlug.toUpperCase()}-${p.sku}`, p.category, p.unit, p.cost_price_kes, p.selling_price_kes, p.wholesale_price_kes, p.vat_rate, p.min_stock, p.is_weighed, 1);
        insertInv.run(`INV-${newProdId}`, tenantId, branchId, newProdId, 50, p.min_stock);
      });
    });

    const token = this.signToken({
      userId,
      tenantId,
      email,
      role: 'owner',
      branchId,
      name: `${businessName} Owner`
    });

    return {
      success: true,
      tenant: {
        id: tenantId,
        name: businessName,
        slug: cleanSlug,
        currency: 'KES',
        planId,
        branchId,
        registerId
      },
      token,
      message: 'Business tenant created successfully on 14-day Free Trial.'
    };
  }

  /**
   * Universal User Signup / Registration.
   * If email is sammyseth260@gmail.com, automatically assumes SaaS Super Admin role.
   * If businessName is provided, registers as Business Owner of that supermarket.
   */
  static registerUser({ email, password, fullName, phone, businessName, location }) {
    if (!email || !password) {
      return { success: false, error: 'MISSING_FIELDS', message: 'Email and password are required.' };
    }

    const normalizedEmail = email.trim().toLowerCase();
    const isSuperAdminEmail = normalizedEmail === 'sammyseth260@gmail.com';

    // 1. Check if user already exists
    const existingUser = db.queryOne('SELECT * FROM users WHERE LOWER(email) = ?', [normalizedEmail]);

    if (isSuperAdminEmail) {
      const { hash, salt } = CryptoUtils.hashEmergencyPassword(password);
      if (existingUser) {
        db.run(
          `UPDATE users SET password_hash = ?, password_salt = ?, role = 'super_admin', active = 1 WHERE id = ?`,
          [hash, salt, existingUser.id]
        );
        return this.login(normalizedEmail, password);
      } else {
        const userId = 'usr_super_sammy';
        db.run(
          `INSERT INTO users (id, tenant_id, username, email, password_hash, password_salt, full_name, phone, role, branch_id, permissions_json, pin_code, active)
           VALUES (?, 'GLOBAL', 'sammyseth', ?, ?, ?, ?, ?, 'super_admin', 'ALL', ?, '9999', 1)`,
          [userId, normalizedEmail, hash, salt, fullName || 'Sammy Seth (Super Admin)', phone || '254700000000', JSON.stringify(['ALL_SAAS_CONTROL', 'MANAGE_TENANTS', 'CONFIGURE_DARAJA'])]
        );
        return this.login(normalizedEmail, password);
      }
    }

    if (existingUser) {
      return { success: false, error: 'USER_EXISTS', message: 'An account with this email already exists. Please sign in.' };
    }

    // 2. Regular registration as Business Owner
    if (businessName) {
      return this.registerTenant({
        businessName,
        tradeName: businessName,
        phone: phone || '254700000000',
        email: normalizedEmail,
        password,
        location: location || 'Nairobi',
        planId: 'growth'
      });
    }

    return {
      success: false,
      error: 'BUSINESS_REQUIRED',
      message: 'Please provide your supermarket business name to create an account, or contact your store manager.'
    };
  }

  /**
   * Authenticates user with email/username and password.
   */
  static login(emailOrUsername, password) {
    if (!emailOrUsername || !password) {
      return { success: false, error: 'MISSING_FIELDS', message: 'Email and password are required.' };
    }

    const cleanInput = emailOrUsername.trim().toLowerCase();
    let user = db.queryOne(
      'SELECT * FROM users WHERE LOWER(email) = ? OR LOWER(username) = ?',
      [cleanInput, cleanInput]
    );

    // Auto-provision Super Admin if sammyseth260@gmail.com logs in for the first time
    if (!user && cleanInput === 'sammyseth260@gmail.com') {
      const { hash, salt } = CryptoUtils.hashEmergencyPassword(password);
      db.run(
        `INSERT INTO users (id, tenant_id, username, email, password_hash, password_salt, full_name, phone, role, branch_id, permissions_json, pin_code, active)
         VALUES ('usr_super_sammy', 'GLOBAL', 'sammyseth', 'sammyseth260@gmail.com', ?, ?, 'Sammy Seth (Super Admin)', '254700000000', 'super_admin', 'ALL', ?, '9999', 1)`,
        [hash, salt, JSON.stringify(['ALL_SAAS_CONTROL', 'MANAGE_TENANTS', 'CONFIGURE_DARAJA'])]
      );
      user = db.queryOne('SELECT * FROM users WHERE LOWER(email) = ?', ['sammyseth260@gmail.com']);
    }

    if (!user) {
      return { success: false, error: 'INVALID_CREDENTIALS', message: 'Invalid credentials.' };
    }

    if (!user.active) {
      return { success: false, error: 'ACCOUNT_INACTIVE', message: 'This account has been deactivated.' };
    }

    const isValid = CryptoUtils.verifyEmergencyPassword(password, user.password_hash, user.password_salt);
    if (!isValid) {
      return { success: false, error: 'INVALID_CREDENTIALS', message: 'Invalid credentials.' };
    }

    // Lookup tenant
    const tenant = db.queryOne('SELECT * FROM tenants WHERE id = ?', [user.tenant_id]) || {
      id: user.tenant_id,
      name: 'Global Platform',
      currency: 'KES',
      plan_id: 'enterprise'
    };

    const token = this.signToken({
      userId: user.id,
      tenantId: user.tenant_id,
      email: user.email,
      username: user.username,
      name: user.full_name,
      role: user.role,
      branchId: user.branch_id
    });

    return {
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        fullName: user.full_name,
        role: user.role,
        branchId: user.branch_id,
        permissions: user.permissions_json ? JSON.parse(user.permissions_json) : []
      },
      tenant: {
        id: tenant.id,
        name: tenant.name,
        currency: tenant.currency || 'KES',
        planId: tenant.plan_id
      }
    };
  }
}

module.exports = JwtAuth;
