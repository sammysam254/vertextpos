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
  static async registerUser({ email, password, fullName, phone, businessName, location }) {
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
        return await this.login(normalizedEmail, password);
      } else {
        const userId = 'usr_super_sammy';
        db.run(
          `INSERT INTO users (id, tenant_id, username, email, password_hash, password_salt, full_name, phone, role, branch_id, permissions_json, pin_code, active)
           VALUES (?, 'GLOBAL', 'sammyseth', ?, ?, ?, ?, ?, 'super_admin', 'ALL', ?, '9999', 1)`,
          [userId, normalizedEmail, hash, salt, fullName || 'Sammy Seth (Super Admin)', phone || '254700000000', JSON.stringify(['ALL_SAAS_CONTROL', 'MANAGE_TENANTS', 'CONFIGURE_DARAJA'])]
        );
        return await this.login(normalizedEmail, password);
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
   * Supports:
   * 1. Supabase Cloud Auth (auth.users) via REST token grant
   * 2. Supabase PostgREST database (public.users)
   * 3. Local engine accounts
   * 4. Super Admin auto-elevation & credential sync for sammyseth260@gmail.com
   */
  static async login(emailOrUsername, password) {
    if (!emailOrUsername || !password) {
      return { success: false, error: 'MISSING_FIELDS', message: 'Email and password are required.' };
    }

    const cleanInput = emailOrUsername.trim().toLowerCase();
    const isSuperAdminEmail = cleanInput === 'sammyseth260@gmail.com';

    let user = null;
    let authenticatedViaSupabase = false;

    // A. Check Supabase Cloud Auth if configured
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    const isRemote = !!(supabaseUrl && supabaseKey && !supabaseUrl.includes('mock'));

    if (isRemote) {
      try {
        const authRes = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
          method: 'POST',
          headers: {
            'apikey': supabaseKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            email: cleanInput,
            password
          })
        });

        if (authRes.ok) {
          const authData = await authRes.json();
          authenticatedViaSupabase = true;

          // Lookup or provision user in public.users
          const dbUserRes = await fetch(`${supabaseUrl}/rest/v1/users?email=eq.${encodeURIComponent(cleanInput)}&select=*`, {
            headers: {
              'apikey': supabaseKey,
              'Authorization': `Bearer ${supabaseKey}`,
              'Accept': 'application/json'
            }
          });

          if (dbUserRes.ok) {
            const dbUsers = await dbUserRes.json();
            if (dbUsers && dbUsers.length > 0) {
              user = dbUsers[0];
            }
          }

          if (!user) {
            user = {
              id: authData.user ? authData.user.id : `usr_${Date.now()}`,
              tenant_id: isSuperAdminEmail ? 'GLOBAL' : 'tenant_metromart',
              username: cleanInput.split('@')[0],
              email: cleanInput,
              full_name: (authData.user && authData.user.user_metadata && authData.user.user_metadata.full_name) || (isSuperAdminEmail ? 'Sammy Seth (Super Admin)' : cleanInput.split('@')[0]),
              role: isSuperAdminEmail ? 'super_admin' : 'owner',
              branch_id: 'ALL',
              permissions_json: isSuperAdminEmail ? JSON.stringify(['ALL_SAAS_CONTROL', 'MANAGE_TENANTS', 'CONFIGURE_DARAJA']) : JSON.stringify(['ALL_BUSINESS_CONTROL']),
              active: 1
            };
          }
        }
      } catch (cloudAuthErr) {
        console.warn('[SUPABASE AUTH] Cloud auth check:', cloudAuthErr.message);
      }
    }

    // B. If not authenticated via Supabase Auth, check local database
    if (!user) {
      user = db.queryOne(
        'SELECT * FROM users WHERE LOWER(email) = ? OR LOWER(username) = ?',
        [cleanInput, cleanInput]
      );
    }

    // C. Special Handling for Super Admin: sammyseth260@gmail.com
    // Automatically updates password to whatever the Super Admin enters so they are NEVER locked out!
    if (isSuperAdminEmail) {
      const { hash, salt } = CryptoUtils.hashEmergencyPassword(password);
      try {
        if (user) {
          db.run(
            `UPDATE users SET password_hash = ?, password_salt = ?, role = 'super_admin', active = 1 WHERE LOWER(email) = ?`,
            [hash, salt, cleanInput]
          );
          user = db.queryOne('SELECT * FROM users WHERE LOWER(email) = ?', [cleanInput]);
        } else {
          db.run(
            `INSERT INTO users (id, tenant_id, username, email, password_hash, password_salt, full_name, phone, role, branch_id, permissions_json, pin_code, active)
             VALUES ('usr_super_sammy', 'GLOBAL', 'sammyseth', 'sammyseth260@gmail.com', ?, ?, 'Sammy Seth (Super Admin)', '254700000000', 'super_admin', 'ALL', ?, '9999', 1)`,
            [hash, salt, JSON.stringify(['ALL_SAAS_CONTROL', 'MANAGE_TENANTS', 'CONFIGURE_DARAJA'])]
          );
          user = db.queryOne('SELECT * FROM users WHERE LOWER(email) = ?', [cleanInput]);
        }
      } catch (e) {
        console.warn('[AUTH] Super Admin DB sync notice:', e.message);
      }

      // Guaranteed Super Admin object fallback
      if (!user) {
        user = {
          id: 'usr_super_sammy',
          tenant_id: 'GLOBAL',
          username: 'sammyseth',
          email: 'sammyseth260@gmail.com',
          full_name: 'Sammy Seth (Super Admin)',
          role: 'super_admin',
          branch_id: 'ALL',
          permissions_json: JSON.stringify(['ALL_SAAS_CONTROL', 'MANAGE_TENANTS', 'CONFIGURE_DARAJA']),
          active: 1
        };
      }
    }

    if (!user) {
      return { success: false, error: 'INVALID_CREDENTIALS', message: 'Invalid credentials. If this is a new staff member, please have your manager provision your account.' };
    }

    if (user.active === 0 || user.is_active === false) {
      return { success: false, error: 'ACCOUNT_INACTIVE', message: 'This account has been deactivated.' };
    }

    // D. Password Verification (unless already verified by Supabase Auth or freshly updated for Super Admin)
    if (!authenticatedViaSupabase && !isSuperAdminEmail) {
      const isValid = CryptoUtils.verifyEmergencyPassword(password, user.password_hash, user.password_salt);
      if (!isValid) {
        return { success: false, error: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' };
      }
    }

    // Lookup tenant
    const tenantId = user.tenant_id || 'GLOBAL';
    const tenant = db.queryOne('SELECT * FROM tenants WHERE id = ?', [tenantId]) || {
      id: tenantId,
      name: isSuperAdminEmail ? 'Vertext POS Platform' : 'Supermarket Store',
      currency: 'KES',
      plan_id: 'enterprise'
    };

    const token = this.signToken({
      userId: user.id,
      tenantId: tenant.id,
      email: user.email,
      username: user.username,
      name: user.full_name,
      role: user.role,
      branchId: user.branch_id || 'BR-001'
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
        branchId: user.branch_id || 'BR-001',
        permissions: typeof user.permissions_json === 'string' ? JSON.parse(user.permissions_json) : (user.permissions || [])
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
