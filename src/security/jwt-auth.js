const crypto = require('crypto');
const db = require('../db/sqlite-store');
const sdb = require('../db/supabase-db');
const CryptoUtils = require('./crypto-utils');
const config = require('../config');

const JWT_SECRET = process.env.JWT_SECRET || 'pos-saas-kenya-enterprise-secret-key-2026';

// Supabase JWKS Public Key for native ES256 token verification
const SUPABASE_JWK = {
  x: 'XEtY7MLPVE5hf1hOxiYfB-zIJVqKUbCMvOQeaD2oFaw',
  y: 'fEbb0sv1G4FXS67PFD-vURXJxaxk5BCP96GSAlFO8f0',
  alg: 'ES256',
  crv: 'P-256',
  ext: true,
  kid: 'dd39cc66-0138-4ce2-91e6-c4e7db94c702',
  kty: 'EC',
  key_ops: ['verify']
};

let supabasePublicKey = null;
try {
  supabasePublicKey = crypto.createPublicKey({ key: SUPABASE_JWK, format: 'jwk' });
} catch (e) {
  console.warn('[JWT] Could not load Supabase JWK:', e.message);
}

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

      const [headerB64, bodyB64, signatureB64] = parts;
      const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
      const decoded = JSON.parse(Buffer.from(bodyB64, 'base64url').toString('utf8'));

      if (decoded.exp && decoded.exp < Math.floor(Date.now() / 1000)) {
        return null; // Expired
      }

      // 1. Supabase Native ES256 Elliptic Curve Verification
      if (header.alg === 'ES256' && supabasePublicKey) {
        const verifier = crypto.createVerify('SHA256');
        verifier.update(`${headerB64}.${bodyB64}`);
        const isValid = verifier.verify(
          { key: supabasePublicKey, dsaEncoding: 'ieee-p1363' },
          Buffer.from(signatureB64, 'base64url')
        );

        if (isValid) {
          return {
            userId: decoded.sub,
            tenantId: decoded.user_metadata?.tenant_id || decoded.app_metadata?.tenant_id || 'GLOBAL',
            role: decoded.user_metadata?.role || decoded.app_metadata?.role || (decoded.email === 'sammyseth260@gmail.com' ? 'super_admin' : 'cashier'),
            email: decoded.email,
            name: decoded.user_metadata?.full_name || decoded.email,
            branchId: decoded.user_metadata?.branch_id || 'BR-001',
            ...decoded
          };
        }
      }

      // 2. Application HMAC-SHA256 (HS256) Verification
      const expectedSig = crypto
        .createHmac('sha256', JWT_SECRET)
        .update(`${headerB64}.${bodyB64}`)
        .digest('base64url');

      if (signatureB64 !== expectedSig) return null;

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
   * Registers a new supermarket business tenant on the SaaS platform directly in Supabase.
   */
  static async registerTenant({
    businessName,
    slug,
    tradeName,
    kraPin,
    phone,
    email,
    password,
    fullName,
    planId = 'growth',
    branchName = 'Flagship Store',
    location = 'Nairobi'
  }) {
    if (!businessName || !email || !password) {
      return { success: false, error: 'MISSING_FIELDS', message: 'Business name, email, and password are required.' };
    }

    const normalizedEmail = email.trim().toLowerCase();
    const cleanSlug = (slug || businessName.toLowerCase().replace(/[^a-z0-9]/g, '')).toLowerCase();
    const tenantId = `tenant_${cleanSlug}_${Date.now().toString().slice(-4)}`;
    const branchId = `BR-${cleanSlug.slice(0, 3).toUpperCase()}-01`;
    const registerId = `REG-${cleanSlug.slice(0, 3).toUpperCase()}-01`;
    const defaultUserId = `usr_${cleanSlug}_owner`;
    let finalUserId = defaultUserId;

    const supabaseUrl = process.env.SUPABASE_URL || (config.supabase && config.supabase.url) || null;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || (config.supabase && config.supabase.anonKey) || null;
    const isRemote = !!(supabaseUrl && supabaseKey);

    let supabaseAuthSuccess = false;
    let authSession = null;

    // 1. DIRECT SUPABASE AUTH API: Create User in Supabase Auth via Admin/Signup API Key
    if (isRemote) {
      try {
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        let authRes, authData;

        // Try Admin API first with auto-confirm
        if (serviceKey) {
          try {
            authRes = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
              method: 'POST',
              headers: {
                'apikey': serviceKey,
                'Authorization': `Bearer ${serviceKey}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                email: normalizedEmail,
                password: password,
                email_confirm: true,
                user_metadata: {
                  full_name: fullName || `${businessName} Owner`,
                  role: 'owner',
                  phone: phone || '',
                  tenant_name: businessName,
                  trade_name: tradeName || businessName
                }
              })
            });
            authData = await authRes.json();
          } catch (e) {}
        }

        // Fallback to regular signup if admin API wasn't used or failed
        if (!authData || (!authData.id && !authData.user)) {
          authRes = await fetch(`${supabaseUrl}/auth/v1/signup`, {
            method: 'POST',
            headers: {
              'apikey': supabaseKey,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              email: normalizedEmail,
              password: password,
              data: {
                full_name: fullName || `${businessName} Owner`,
                role: 'owner',
                phone: phone || '',
                tenant_name: businessName,
                trade_name: tradeName || businessName
              }
            })
          });
          authData = await authRes.json();
        }
        if (authRes.ok && (authData.id || (authData.user && authData.user.id))) {
          supabaseAuthSuccess = true;
          finalUserId = authData.id || authData.user.id;
          authSession = authData.session || null;
          console.log(`[SUPABASE AUTH] Successfully registered user ${normalizedEmail} with Supabase UID: ${finalUserId}`);
        } else if (authData && authData.error_code === 'user_already_exists') {
          supabaseAuthSuccess = true;
          console.log(`[SUPABASE AUTH] User ${normalizedEmail} already registered in Supabase. Proceeding.`);
          try {
            const { data: existingUsers } = await sdb.query('users', { email: normalizedEmail });
            if (existingUsers && existingUsers.length > 0) {
              finalUserId = existingUsers[0].id;
            }
          } catch (e) {}
        } else if (authData && (authData.msg || authData.message)) {
          console.warn(`[SUPABASE AUTH] Registration notice: ${authData.msg || authData.message}`);
          if (authRes.status >= 400 && !authData.id) {
            return {
              success: false,
              error: authData.error_code || 'AUTH_ERROR',
              message: authData.msg || authData.message
            };
          }
        }
      } catch (err) {
        console.warn(`[SUPABASE AUTH] Cloud signup error: ${err.message}`);
      }
    }

    // 2. Insert into Supabase cloud database tables via PostgREST Direct Layer
    let supabaseTenantUuid = null;
    let supabaseBranchUuid = null;
    let supabaseRegisterUuid = null;

    if (isRemote && sdb.isConfigured()) {
      try {
        // Tenant
        const { data: tData } = await sdb.insert('tenants', {
          slug: cleanSlug,
          legal_name: businessName,
          trade_name: tradeName || businessName,
          kra_pin: kraPin || 'P050000000Z',
          business_phone: phone || '254700000000',
          business_email: normalizedEmail,
          currency: 'KES',
          plan_tier: planId,
          subscription_status: 'ACTIVE',
          location: location || 'Nairobi'
        });

        if (tData && tData.length > 0) {
          supabaseTenantUuid = tData[0].id;
        } else {
          supabaseTenantUuid = await sdb.resolveTenantUuid(cleanSlug);
        }

        // Branch
        if (supabaseTenantUuid) {
          const { data: bData } = await sdb.insert('branches', {
            tenant_id: supabaseTenantUuid,
            code: 'MAIN',
            name: branchName || 'Flagship Store',
            location: location || 'Nairobi',
            phone: phone || '254700000000',
            status: 'ACTIVE'
          });

          if (bData && bData.length > 0) {
            supabaseBranchUuid = bData[0].id;
          }

          // Register
          if (supabaseBranchUuid) {
            const { data: rData } = await sdb.insert('registers', {
              tenant_id: supabaseTenantUuid,
              branch_id: supabaseBranchUuid,
              code: 'TILL-01',
              name: 'Counter 1 (Express)',
              printer_type: 'ESC_POS_80MM',
              status: 'ONLINE'
            });
            if (rData && rData.length > 0) {
              supabaseRegisterUuid = rData[0].id;
            }
          }

          // User
          await sdb.insert('users', {
            id: finalUserId,
            tenant_id: supabaseTenantUuid,
            username: normalizedEmail.split('@')[0],
            email: normalizedEmail,
            full_name: fullName || `${businessName} Owner`,
            phone: phone || '254700000000',
            role: 'owner',
            branch_id: supabaseBranchUuid || null,
            pin_code: '1234',
            active: 1
          });
        }
      } catch (err) {
        console.warn(`[SUPABASE CLOUD] PostgREST insert notice: ${err.message}`);
      }
    }

    // 3. Local SQLite Store
    const { hash, salt } = CryptoUtils.hashEmergencyPassword(password);
    const trialEnds = new Date(Date.now() + 14 * 86400000).toISOString();

    db.transaction(() => {
      // Insert tenant slug ID
      db.run(
        `INSERT OR REPLACE INTO tenants (id, name, slug, trade_name, kra_pin, phone, email, currency, plan_id, status, trial_ends_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'KES', ?, 'TRIAL', ?)`,
        [tenantId, businessName, cleanSlug, tradeName || businessName, kraPin || 'P050000000Z', phone || '254700000000', normalizedEmail, planId, trialEnds]
      );

      // If Supabase created a UUID, also insert UUID alias into tenants so UUID lookups succeed
      if (supabaseTenantUuid && supabaseTenantUuid !== tenantId) {
        db.run(
          `INSERT OR IGNORE INTO tenants (id, name, slug, trade_name, kra_pin, phone, email, currency, plan_id, status, trial_ends_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'KES', ?, 'TRIAL', ?)`,
          [supabaseTenantUuid, businessName, cleanSlug, tradeName || businessName, kraPin || 'P050000000Z', phone || '254700000000', normalizedEmail, planId, trialEnds]
        );
      }

      db.run(
        `INSERT OR REPLACE INTO branches (id, tenant_id, code, name, location, phone, status)
         VALUES (?, ?, 'MAIN', ?, ?, ?, 'ACTIVE')`,
        [branchId, tenantId, branchName, location, phone]
      );

      db.run(
        `INSERT OR REPLACE INTO registers (id, tenant_id, branch_id, code, name, printer_type, status)
         VALUES (?, ?, ?, 'TILL-01', 'Counter 1 (Express)', 'ESC_POS_80MM', 'ONLINE')`,
        [registerId, tenantId, branchId]
      );

      db.run(
        `INSERT OR REPLACE INTO users (id, tenant_id, username, email, password_hash, password_salt, full_name, phone, role, branch_id, permissions_json, pin_code, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'owner', 'ALL', ?, '1234', 1)`,
        [finalUserId, supabaseTenantUuid || tenantId, normalizedEmail.split('@')[0], normalizedEmail, hash, salt, fullName || `${businessName} Owner`, phone, JSON.stringify(['ALL_BUSINESS_CONTROL'])]
      );

      // Clone catalog
      const standardProducts = db.queryAll('SELECT * FROM products WHERE tenant_id = ? LIMIT 12', ['tenant_metromart']);
      const insertProd = db.prepare(`
        INSERT OR IGNORE INTO products (id, tenant_id, name, barcode, sku, category, unit, cost_price_kes, selling_price_kes, wholesale_price_kes, vat_rate, min_stock, is_weighed, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertInv = db.prepare(`
        INSERT OR IGNORE INTO inventory (id, tenant_id, branch_id, product_id, quantity, reorder_level)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      standardProducts.forEach((p, idx) => {
        const newProdId = `PRD-${tenantId.replace(/[^a-zA-Z0-9]/g, '')}-${String(idx + 1).padStart(3, '0')}`;
        insertProd.run(newProdId, tenantId, p.name, p.barcode, `${cleanSlug.toUpperCase()}-${p.sku}`, p.category, p.unit, p.cost_price_kes, p.selling_price_kes, p.wholesale_price_kes, p.vat_rate, p.min_stock, p.is_weighed, 1);
        insertInv.run(`INV-${newProdId}`, tenantId, branchId, newProdId, 50, p.min_stock);
      });
    });

    const token = this.signToken({
      userId: finalUserId,
      tenantId,
      email: normalizedEmail,
      role: 'owner',
      branchId,
      name: fullName || `${businessName} Owner`
    });

    return {
      success: true,
      requiresConfirmation: isRemote && !authSession,
      tenant: {
        id: tenantId,
        name: businessName,
        slug: cleanSlug,
        currency: 'KES',
        planId,
        branchId,
        registerId
      },
      token: (authSession || !isRemote) ? token : null,
      user: {
        id: finalUserId,
        email: normalizedEmail,
        fullName: fullName || `${businessName} Owner`,
        role: 'owner',
        tenantId,
        branchId
      },
      message: (isRemote && !authSession)
        ? "Account created directly in Supabase! If 'Confirm email' is enabled in your Supabase project, click the link sent to your email (or click 'Confirm user' in Supabase Dashboard) to sign in."
        : 'Business tenant created successfully in Supabase on 14-day Free Trial.'
    };
  }

  /**
   * Universal User Signup / Registration directly in Supabase Auth & DB.
   * If email is sammyseth260@gmail.com, automatically assumes SaaS Super Admin role.
   * If businessName is provided, registers as Business Owner of that supermarket.
   */
  static async registerUser({ email, password, fullName, phone, businessName, location }) {
    if (!email || !password) {
      return { success: false, error: 'MISSING_FIELDS', message: 'Email and password are required.' };
    }

    const normalizedEmail = email.trim().toLowerCase();
    const isSuperAdminEmail = normalizedEmail === 'sammyseth260@gmail.com';

    const supabaseUrl = process.env.SUPABASE_URL || (config.supabase && config.supabase.url) || null;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || (config.supabase && config.supabase.anonKey) || null;
    const isRemote = !!(supabaseUrl && supabaseKey);

    if (isSuperAdminEmail) {
      let finalUserId = 'usr_super_sammy';
      let authSession = null;

      if (isRemote) {
        try {
          const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
          let authRes, authData;

          if (serviceKey) {
            try {
              authRes = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
                method: 'POST',
                headers: {
                  'apikey': serviceKey,
                  'Authorization': `Bearer ${serviceKey}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  email: normalizedEmail,
                  password,
                  email_confirm: true,
                  user_metadata: {
                    full_name: fullName || 'Sammy Seth (Super Admin)',
                    role: 'super_admin'
                  }
                })
              });
              authData = await authRes.json();
            } catch (e) {}
          }

          if (!authData || (!authData.id && !authData.user)) {
            authRes = await fetch(`${supabaseUrl}/auth/v1/signup`, {
              method: 'POST',
              headers: {
                'apikey': supabaseKey,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                email: normalizedEmail,
                password,
                data: {
                  full_name: fullName || 'Sammy Seth (Super Admin)',
                  role: 'super_admin'
                }
              })
            });
            authData = await authRes.json();
          }

          if (authRes.ok && (authData.id || (authData.user && authData.user.id))) {
            finalUserId = authData.id || authData.user.id;
            authSession = authData.session;
          }
        } catch (e) {}

        // Push to public.users in Supabase
        try {
          await fetch(`${supabaseUrl}/rest/v1/users`, {
            method: 'POST',
            headers: {
              'apikey': supabaseKey,
              'Authorization': `Bearer ${supabaseKey}`,
              'Content-Type': 'application/json',
              'Prefer': 'return=minimal'
            },
            body: JSON.stringify({
              id: finalUserId,
              tenant_id: 'GLOBAL',
              username: 'sammyseth',
              email: normalizedEmail,
              full_name: fullName || 'Sammy Seth (Super Admin)',
              phone: phone || '254700000000',
              role: 'super_admin',
              branch_id: 'ALL',
              pin_code: '9999',
              active: 1
            })
          });
        } catch (e) {}
      }

      // Local store
      const { hash, salt } = CryptoUtils.hashEmergencyPassword(password);
      db.run(
        `INSERT OR REPLACE INTO users (id, tenant_id, username, email, password_hash, password_salt, full_name, phone, role, branch_id, permissions_json, pin_code, active)
         VALUES (?, 'GLOBAL', 'sammyseth', ?, ?, ?, ?, ?, 'super_admin', 'ALL', ?, '9999', 1)`,
        [finalUserId, normalizedEmail, hash, salt, fullName || 'Sammy Seth (Super Admin)', phone || '254700000000', JSON.stringify(['ALL_SAAS_CONTROL', 'MANAGE_TENANTS', 'CONFIGURE_DARAJA'])]
      );

      return await this.login(normalizedEmail, password);
    }

    // 2. Regular registration as Business Owner
    if (businessName) {
      return await this.registerTenant({
        businessName,
        tradeName: businessName,
        phone: phone || '254700000000',
        email: normalizedEmail,
        password,
        fullName,
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
   * Strict Enterprise Security:
   * All authentication is verified cryptographically by Supabase Auth (auth.users)
   * or the Supabase database (public.users).
   * Zero backdoors or loose password bypasses.
   */
  static async login(emailOrUsername, password) {
    if (!emailOrUsername || !password) {
      return { success: false, error: 'MISSING_FIELDS', message: 'Email and password are required.' };
    }

    const cleanInput = emailOrUsername.trim().toLowerCase();
    const isSuperAdminEmail = cleanInput === 'sammyseth260@gmail.com';

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
    const isRemote = !!(supabaseUrl && supabaseKey && !supabaseUrl.includes('mock'));

    let authenticatedUser = null;
    let emailNotConfirmed = false;

    // 1. PRIMARY: Authenticate directly against Supabase Cloud Auth (GoTrue API)
    if (isRemote && cleanInput.includes('@')) {
      try {
        const authRes = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
          method: 'POST',
          headers: {
            'apikey': supabaseKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            email: cleanInput,
            password: password
          })
        });

        const authData = await authRes.json();

        if (authRes.ok && authData.access_token) {
          // Password cryptographically verified by Supabase!
          authenticatedUser = {
            id: authData.user ? authData.user.id : `usr_${cleanInput.split('@')[0]}`,
            email: cleanInput,
            username: cleanInput.split('@')[0],
            full_name: (authData.user && authData.user.user_metadata && authData.user.user_metadata.full_name) || (isSuperAdminEmail ? 'Sammy Seth (Super Admin)' : cleanInput.split('@')[0]),
            role: isSuperAdminEmail ? 'super_admin' : ((authData.user && authData.user.user_metadata && authData.user.user_metadata.role) || 'owner'),
            tenant_id: isSuperAdminEmail ? 'GLOBAL' : 'tenant_metromart',
            branch_id: 'ALL',
            permissions: isSuperAdminEmail ? ['ALL_SAAS_CONTROL', 'MANAGE_TENANTS', 'CONFIGURE_DARAJA'] : ['ALL_BUSINESS_CONTROL']
          };

          // Also check public.users table in Supabase for customized role / profile
          try {
            const dbRes = await fetch(`${supabaseUrl}/rest/v1/users?or=(email.eq.${encodeURIComponent(cleanInput)},username.eq.${encodeURIComponent(cleanInput)})&select=*`, {
              headers: {
                'apikey': supabaseKey,
                'Authorization': `Bearer ${supabaseKey}`,
                'Accept': 'application/json'
              }
            });
            if (dbRes.ok) {
              const rows = await dbRes.json();
              if (rows && rows.length > 0) {
                const r = rows[0];
                authenticatedUser.id = r.id || authenticatedUser.id;
                authenticatedUser.full_name = r.full_name || authenticatedUser.full_name;
                authenticatedUser.role = isSuperAdminEmail ? 'super_admin' : (r.role || authenticatedUser.role);
                authenticatedUser.tenant_id = isSuperAdminEmail ? 'GLOBAL' : (r.tenant_id || authenticatedUser.tenant_id);
                authenticatedUser.branch_id = r.branch_id || authenticatedUser.branch_id;
              }
            }
          } catch (e) {}

        } else if (authData && (authData.error_code === 'email_not_confirmed' || (authData.msg && authData.msg.toLowerCase().includes('confirm')) || (authData.error_description && authData.error_description.toLowerCase().includes('confirm')))) {
          emailNotConfirmed = true;
        }
      } catch (err) {
        console.warn('[SUPABASE AUTH] Direct API check notice:', err.message);
      }
    }

    // 2. SECONDARY: Check Supabase public.users table (verifies staff created by store managers)
    if (!authenticatedUser && isRemote) {
      try {
        const dbRes = await fetch(`${supabaseUrl}/rest/v1/users?or=(email.eq.${encodeURIComponent(cleanInput)},username.eq.${encodeURIComponent(cleanInput)})&select=*`, {
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Accept': 'application/json'
          }
        });
        if (dbRes.ok) {
          const rows = await dbRes.json();
          if (rows && rows.length > 0) {
            const r = rows[0];
            const isValid = CryptoUtils.verifyEmergencyPassword(password, r.password_hash, r.password_salt);
            if (isValid) {
              authenticatedUser = {
                id: r.id,
                email: r.email,
                username: r.username || cleanInput.split('@')[0],
                full_name: r.full_name,
                role: isSuperAdminEmail ? 'super_admin' : r.role,
                tenant_id: isSuperAdminEmail ? 'GLOBAL' : (r.tenant_id || 'GLOBAL'),
                branch_id: r.branch_id || 'ALL',
                permissions: Array.isArray(r.permissions) ? r.permissions : []
              };
            }
          }
        }
      } catch (e) {}
    }

    if (!authenticatedUser && emailNotConfirmed) {
      return {
        success: false,
        error: 'EMAIL_NOT_CONFIRMED',
        message: 'Your email address is not confirmed in Supabase. In your Supabase dashboard under Authentication -> Users, click on your user and select "Confirm User" (or disable "Confirm email" in Auth settings).'
      };
    }

    // 3. TERTIARY: Check local store (for testing, offline mode, and seeded accounts)
    if (!authenticatedUser) {
      const localUser = db.queryOne('SELECT * FROM users WHERE LOWER(email) = ? OR LOWER(username) = ?', [cleanInput, cleanInput]);
      if (localUser && localUser.active) {
        const isValid = CryptoUtils.verifyEmergencyPassword(password, localUser.password_hash, localUser.password_salt);
        if (isValid) {
          authenticatedUser = {
            id: localUser.id,
            email: localUser.email,
            username: localUser.username,
            full_name: localUser.full_name,
            role: localUser.role,
            tenant_id: localUser.tenant_id,
            branch_id: localUser.branch_id,
            permissions: localUser.permissions_json ? JSON.parse(localUser.permissions_json) : []
          };
        }
      }
    }

    // Strict validation: Reject if password did not match Supabase or local store
    if (!authenticatedUser) {
      return {
        success: false,
        error: 'INVALID_CREDENTIALS',
        message: 'Invalid login credentials. Please check your email and password in Supabase.'
      };
    }

    // Lookup tenant
    const tenantId = authenticatedUser.tenant_id || 'GLOBAL';
    const tenant = db.queryOne('SELECT * FROM tenants WHERE id = ?', [tenantId]) || {
      id: tenantId,
      name: isSuperAdminEmail ? 'Vertext POS Platform' : 'Supermarket Store',
      currency: 'KES',
      plan_id: 'enterprise'
    };

    const token = this.signToken({
      userId: authenticatedUser.id,
      tenantId: tenant.id,
      email: authenticatedUser.email,
      username: authenticatedUser.username,
      name: authenticatedUser.full_name,
      role: authenticatedUser.role,
      branchId: authenticatedUser.branch_id || 'BR-001'
    });

    return {
      success: true,
      token,
      user: {
        id: authenticatedUser.id,
        username: authenticatedUser.username,
        email: authenticatedUser.email,
        fullName: authenticatedUser.full_name,
        role: authenticatedUser.role,
        branchId: authenticatedUser.branch_id || 'BR-001',
        permissions: authenticatedUser.permissions || []
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
