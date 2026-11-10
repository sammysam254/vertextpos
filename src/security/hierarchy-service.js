require('../load-env');
const sdb = require('../db/supabase-db');
const CryptoUtils = require('./crypto-utils');
const config = require('../config');

/**
 * Strict Hierarchical Role Creation & Management Engine.
 * Operating 100% strictly against Supabase Cloud PostgreSQL.
 * SQLite has been completely decommissioned.
 * 
 * Hierarchy Rules:
 * 1. Super Admin creates Business Owner (with business name, location, and monthly subscription due on the 1st of every month).
 * 2. Business Owner creates Business Admin.
 * 3. Business Admin creates Branch Manager.
 * 4. Branch Manager creates and manages all other roles (Supervisor, Cashier, Stock Manager, Procurement, Accountant, Auditor).
 */
class HierarchyService {
  /**
   * Universal Tenant Existence Guard.
   * Resolves tenant slug or ID to Supabase UUID.
   */
  static async ensureTenantExists(tenantIdOrSlug) {
    if (!tenantIdOrSlug || tenantIdOrSlug === 'GLOBAL') return null;
    const resolved = await sdb.resolveTenantUuid(tenantIdOrSlug);
    return resolved || tenantIdOrSlug;
  }

  /**
   * Resolves or ensures a tenant UUID in Supabase database.
   */
  static async getSupabaseTenantUuid(tenantSlugOrId, tenantData = {}) {
    if (!tenantSlugOrId) return null;
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (UUID_REGEX.test(tenantSlugOrId)) return tenantSlugOrId;
    if (tenantData && tenantData.id && UUID_REGEX.test(tenantData.id)) return tenantData.id;

    try {
      const u = await sdb.resolveTenantUuid(tenantSlugOrId);
      if (u) return u;
    } catch (e) {}

    const supabaseUrl = process.env.SUPABASE_URL || '';
    const apiKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';

    if (!supabaseUrl || !apiKey) return null;

    try {
      const slug = (tenantData.slug || tenantSlugOrId || '').replace(/^tenant_/, '').toLowerCase();
      const res = await fetch(`${supabaseUrl}/rest/v1/tenants?slug=eq.${encodeURIComponent(slug)}&select=id`, {
        headers: {
          'apikey': apiKey,
          'Authorization': `Bearer ${apiKey}`
        }
      });
      const rows = await res.json();
      if (Array.isArray(rows) && rows.length > 0 && rows[0].id) {
        return rows[0].id;
      }

      // Create tenant in Supabase if not found
      const createRes = await fetch(`${supabaseUrl}/rest/v1/tenants`, {
        method: 'POST',
        headers: {
          'apikey': apiKey,
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({
          slug: slug,
          legal_name: tenantData.legalName || 'Supermarket Store',
          trade_name: tenantData.tradeName || tenantData.legalName || 'Supermarket Store',
          kra_pin: tenantData.kraPin || 'P051234567Z',
          business_phone: tenantData.businessPhone || '254700000000',
          business_email: tenantData.businessEmail || `${slug}@pos.ke`,
          currency: 'KES',
          plan_tier: tenantData.planTier || 'growth',
          monthly_subscription_kes: 6500.00,
          billing_day_of_month: 1,
          subscription_status: 'ACTIVE',
          location: tenantData.location || 'Nairobi, Kenya'
        })
      });
      const createdRows = await createRes.json();
      if (Array.isArray(createdRows) && createdRows.length > 0) {
        return createdRows[0].id;
      }
    } catch (err) {
      console.warn('[SUPABASE HIERARCHY] getSupabaseTenantUuid notice:', err.message);
    }

    return null;
  }

  /**
   * Registers a user in Supabase GoTrue Auth AND Supabase public.users table.
   */
  static async syncUserToSupabase({
    userId,
    tenantId,
    branchId,
    email,
    username,
    password,
    fullName,
    phone,
    role,
    pinCode = '1234',
    permissions = []
  }) {
    const supabaseUrl = process.env.SUPABASE_URL || '';
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || null;
    const anonKey = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || null;
    const apiKey = serviceKey || anonKey;

    if (!supabaseUrl || !apiKey) return userId;

    const normalizedEmail = email.trim().toLowerCase();
    const cleanUsername = username || normalizedEmail.split('@')[0];
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let finalUserId = userId;

    let branchUuid = null;
    if (branchId) {
      if (UUID_REGEX.test(branchId)) {
        branchUuid = branchId;
      } else {
        try {
          branchUuid = await sdb.resolveBranchUuid(tenantId, branchId);
        } catch (e) {}
      }
    }

    // 1. Direct GoTrue Auth Registration & Password Sync
    try {
      if (serviceKey) {
        const adminRes = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
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
              full_name: fullName,
              role: role,
              phone: phone || '',
              tenant_id: tenantId,
              branch_id: branchUuid || branchId,
              pin_code: pinCode
            }
          })
        });
        const adminData = await adminRes.json();
        if (adminData && adminData.id) {
          finalUserId = adminData.id;
        } else if (adminRes.status === 422 || (adminData && (adminData.error_code === 'email_exists' || adminData.code === 422 || (adminData.msg && adminData.msg.toLowerCase().includes('already'))))) {
          try {
            const listRes = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
              headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` }
            });
            const list = await listRes.json();
            const existingUser = (list.users || []).find(u => u.email === normalizedEmail);
            if (existingUser) {
              finalUserId = existingUser.id;
              await fetch(`${supabaseUrl}/auth/v1/admin/users/${existingUser.id}`, {
                method: 'PUT',
                headers: {
                  'apikey': serviceKey,
                  'Authorization': `Bearer ${serviceKey}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  password: password,
                  email_confirm: true,
                  user_metadata: {
                    full_name: fullName,
                    role: role,
                    phone: phone || '',
                    tenant_id: tenantId,
                    branch_id: branchUuid || branchId,
                    pin_code: pinCode
                  }
                })
              });
            }
          } catch (e) {}
        }

        if (!finalUserId || finalUserId === userId) {
          try {
            const authRes = await fetch(`${supabaseUrl}/auth/v1/signup`, {
              method: 'POST',
              headers: {
                'apikey': anonKey || apiKey,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                email: normalizedEmail,
                password: password,
                data: {
                  full_name: fullName,
                  role: role,
                  phone: phone || '',
                  tenant_id: tenantId,
                  branch_id: branchUuid || branchId,
                  pin_code: pinCode
                }
              })
            });
            const authData = await authRes.json();
            if (authData && (authData.id || (authData.user && authData.user.id))) {
              finalUserId = authData.id || authData.user.id;
            }
          } catch (e) {}
        }
      }
    } catch (e) {
      console.warn('[SUPABASE HIERARCHY] GoTrue auth sync notice:', e.message);
    }

    // 2. Direct Supabase Database public.users Table Upsert
    try {
      const { hash, salt } = CryptoUtils.hashEmergencyPassword(password);
      await sdb.upsert('users', {
        id: finalUserId && UUID_REGEX.test(finalUserId) ? finalUserId : undefined,
        tenant_id: tenantId && UUID_REGEX.test(tenantId) ? tenantId : undefined,
        username: cleanUsername,
        email: normalizedEmail,
        password_hash: hash,
        password_salt: salt,
        full_name: fullName,
        phone: phone || '254700000000',
        role: role,
        branch_id: branchUuid,
        permissions: permissions,
        is_active: true
      }, 'email');
    } catch (err) {
      console.warn('[SUPABASE HIERARCHY] public.users insert notice:', err.message);
    }

    return finalUserId;
  }

  /**
   * Super Admin creates a Business Owner.
   */
  static async createBusinessOwner({
    creatorRole,
    businessName,
    tradeName,
    kraPin,
    businessPhone,
    ownerFullName,
    ownerEmail,
    password,
    location,
    planTier = 'growth',
    monthlySubscriptionKes = 6500.00
  }) {
    if (creatorRole !== 'super_admin') {
      return {
        success: false,
        error: 'FORBIDDEN',
        message: 'Only SaaS Super Admin can onboard new Supermarket Businesses & Owners.'
      };
    }

    if (!businessName || !ownerFullName || !ownerEmail || !password) {
      return {
        success: false,
        error: 'MISSING_FIELDS',
        message: 'Business name, owner name, email, and password are required.'
      };
    }

    const cleanSlug = businessName.toLowerCase().replace(/[^a-z0-9]/g, '');

    // Check existing tenant in Supabase (idempotent reuse for acceptance tests)
    const { data: existing } = await sdb.query('tenants', { slug: cleanSlug });
    let tenantUuid;
    let branchUuid;
    let registerUuid;

    if (existing && existing.length > 0) {
      tenantUuid = existing[0].id;
      const { data: bList } = await sdb.query('branches', { tenant_id: tenantUuid, code: 'MAIN' });
      if (bList && bList.length > 0) {
        branchUuid = bList[0].id;
      } else {
        const { data: newB } = await sdb.insert('branches', {
          tenant_id: tenantUuid,
          code: 'MAIN',
          name: `${businessName} Main Branch`,
          location: location || 'Nairobi',
          phone: businessPhone || '254700000000',
          status: 'ACTIVE'
        });
        if (newB && newB.length > 0) branchUuid = newB[0].id;
      }
      const { data: rList } = await sdb.query('registers', { tenant_id: tenantUuid });
      if (rList && rList.length > 0) {
        registerUuid = rList[0].id;
      } else if (branchUuid) {
        const { data: newR } = await sdb.insert('registers', {
          tenant_id: tenantUuid,
          branch_id: branchUuid,
          code: 'TILL-01',
          name: 'Express Lane 1',
          printer_type: 'ESC_POS_80MM',
          status: 'ONLINE'
        });
        if (newR && newR.length > 0) registerUuid = newR[0].id;
      }
    } else {
      // 1. Insert Tenant directly into Supabase
      const { data: tData, error: tErr } = await sdb.insert('tenants', {
        slug: cleanSlug,
        legal_name: businessName,
        trade_name: tradeName || businessName,
        kra_pin: kraPin || 'P051234567Z',
        business_phone: businessPhone || '254700000000',
        business_email: ownerEmail,
        currency: 'KES',
        plan_tier: planTier,
        monthly_subscription_kes: Number(monthlySubscriptionKes) || 6500.00,
        billing_day_of_month: 1,
        subscription_status: 'ACTIVE',
        location: location || 'Nairobi'
      });

      if (tErr || !tData || tData.length === 0) {
        return { success: false, error: 'DB_ERROR', message: (tErr && tErr.message) || 'Failed to create tenant in Supabase' };
      }

      tenantUuid = tData[0].id;

      // 2. Insert Default Branch in Supabase
      const { data: bData } = await sdb.insert('branches', {
        tenant_id: tenantUuid,
        code: 'MAIN',
        name: `${businessName} Main Branch`,
        location: location || 'Nairobi',
        phone: businessPhone || '254700000000',
        status: 'ACTIVE'
      });

      branchUuid = bData && bData.length > 0 ? bData[0].id : null;

      // 3. Insert Default Register in Supabase
      if (branchUuid) {
        const { data: rData } = await sdb.insert('registers', {
          tenant_id: tenantUuid,
          branch_id: branchUuid,
          code: 'TILL-01',
          name: 'Express Lane 1',
          printer_type: 'ESC_POS_80MM',
          status: 'ONLINE'
        });
        if (rData && rData.length > 0) registerUuid = rData[0].id;
      }
    }

    // 4. Create Owner Account in Supabase GoTrue Auth & DB
    const syncedUserId = await HierarchyService.syncUserToSupabase({
      userId: `usr_${cleanSlug}_owner`,
      tenantId: tenantUuid,
      branchId: branchUuid,
      email: ownerEmail,
      username: ownerEmail.split('@')[0],
      password,
      fullName: ownerFullName,
      phone: businessPhone,
      role: 'owner',
      pinCode: '1111',
      permissions: ['ALL_BUSINESS_CONTROL', 'FINANCIAL_REPORTS', 'MANAGE_BRANCHES', 'MANAGE_ADMINS']
    });

    // 5. Seed Starter FMCG Catalog in Supabase for this tenant
    try {
      const { data: sampleProds } = await sdb.query('products', {}, { limit: 10 });
      if (sampleProds && sampleProds.length > 0) {
        for (const p of sampleProds) {
          const { data: createdP } = await sdb.insert('products', {
            tenant_id: tenantUuid,
            name: p.name,
            barcode: p.barcode,
            sku: `${cleanSlug.toUpperCase()}-${p.sku}`,
            category: p.category,
            unit: p.unit,
            cost_price_kes: p.cost_price_kes,
            selling_price_kes: p.selling_price_kes,
            wholesale_price_kes: p.wholesale_price_kes,
            vat_rate: p.vat_rate,
            min_stock: p.min_stock,
            is_active: true
          });
          if (createdP && createdP.length > 0 && branchUuid) {
            await sdb.insert('inventory', {
              tenant_id: tenantUuid,
              branch_id: branchUuid,
              product_id: createdP[0].id,
              quantity: 100,
              reorder_level: p.min_stock || 10
            });
          }
        }
      }
    } catch (e) {
      console.warn('[SUPABASE] Sample product seeding notice:', e.message);
    }

    const businessObj = {
      tenantId: tenantUuid,
      id: tenantUuid,
      name: businessName,
      slug: cleanSlug,
      ownerEmail,
      ownerFullName,
      branchId: branchUuid,
      defaultBranchId: branchUuid,
      registerId: registerUuid,
      monthlySubscriptionKes: Number(monthlySubscriptionKes) || 6500.00,
      billingSchedule: '1st of every month',
      billingCycle: 'Monthly (1st of Month)'
    };

    return {
      success: true,
      message: `Supermarket "${businessName}" onboarded into Supabase. Owner: ${ownerFullName}. Monthly subscription: KES ${monthlySubscriptionKes} due on the 1st of every month.`,
      business: businessObj,
      tenant: businessObj
    };
  }

  /**
   * Business Owner creates a new Supermarket Branch.
   */
  static async createBranch({
    creatorRole,
    creatorTenantId,
    name,
    code,
    location,
    phone
  }) {
    if (creatorRole !== 'owner') {
      return {
        success: false,
        error: 'FORBIDDEN',
        message: 'Only the Supermarket Business Owner can create branches.'
      };
    }

    if (!name || !location) {
      return {
        success: false,
        error: 'MISSING_FIELDS',
        message: 'Branch name and location are required.'
      };
    }

    const tenantUuid = await sdb.resolveTenantUuid(creatorTenantId);
    if (!tenantUuid) {
      return { success: false, error: 'TENANT_NOT_FOUND', message: 'Tenant not found in Supabase.' };
    }

    const cleanCode = (code || `BR-${name.slice(0, 3).toUpperCase()}-${Date.now().toString().slice(-3)}`).trim().toUpperCase();

    // Check existing branch in Supabase
    const { data: existing } = await sdb.query('branches', { tenant_id: tenantUuid, code: cleanCode });
    let cloudBranchId = null;
    let cloudRegisterId = null;

    if (existing && existing.length > 0) {
      cloudBranchId = existing[0].id;
      const { data: rList } = await sdb.query('registers', { branch_id: cloudBranchId });
      cloudRegisterId = rList && rList.length > 0 ? rList[0].id : null;
    } else {
      // Insert directly into Supabase
      const { data: bData, error: bErr } = await sdb.insert('branches', {
        tenant_id: tenantUuid,
        code: cleanCode,
        name,
        location,
        phone: phone || '',
        status: 'ACTIVE'
      });

      if (bErr || !bData || bData.length === 0) {
        return { success: false, error: 'DB_ERROR', message: (bErr && bErr.message) || 'Failed to create branch in Supabase' };
      }

      cloudBranchId = bData[0].id;

      // Create default register for this branch
      const { data: rData } = await sdb.insert('registers', {
        tenant_id: tenantUuid,
        branch_id: cloudBranchId,
        code: 'TILL-01',
        name: `${name} Till 1`,
        printer_type: 'ESC_POS_80MM',
        status: 'ONLINE'
      });
      if (rData && rData.length > 0) cloudRegisterId = rData[0].id;
    }

    return {
      success: true,
      message: `Branch "${name}" (${cleanCode}) successfully created at ${location}.`,
      branch: {
        id: cloudBranchId,
        code: cleanCode,
        name,
        location,
        phone: phone || '',
        status: 'ACTIVE',
        registerId: cloudRegisterId
      }
    };
  }

  /**
   * Retrieves all branches for a specific supermarket tenant directly from Supabase.
   */
  static async getBranches({ tenantId }) {
    const tenantUuid = await sdb.resolveTenantUuid(tenantId);
    if (!tenantUuid) return [];

    const { data: branches } = await sdb.query('branches', { tenant_id: tenantUuid }, { order: 'created_at.asc' });
    const { data: registers } = await sdb.query('registers', { tenant_id: tenantUuid });

    return (branches || []).map(b => ({
      ...b,
      register_count: (registers || []).filter(r => r.branch_id === b.id).length,
      sales_count: 0,
      total_revenue_kes: 0
    }));
  }

  /**
   * Business Owner creates a Business Admin.
   */
  static async createBusinessAdmin({
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

    const tenantUuid = await sdb.resolveTenantUuid(creatorTenantId);
    const permissions = ['MANAGE_USERS', 'MANAGE_PRODUCTS', 'MANAGE_INVENTORY', 'MANAGE_BRANCH_MANAGERS'];

    const syncedUserId = await HierarchyService.syncUserToSupabase({
      userId: `usr_adm_${Date.now().toString().slice(-4)}`,
      tenantId: tenantUuid,
      branchId: null,
      email,
      username: username || email.split('@')[0],
      password,
      fullName,
      phone,
      role: 'admin',
      pinCode: '2222',
      permissions
    });

    return {
      success: true,
      message: `Business Admin ${fullName} successfully created.`,
      user: { id: syncedUserId, fullName, email, role: 'admin' }
    };
  }

  /**
   * Business Admin (or Owner) creates a Branch Manager.
   */
  static async createBranchManager({
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

    const tenantUuid = await sdb.resolveTenantUuid(creatorTenantId);
    const branchUuid = await sdb.resolveBranchUuid(tenantUuid, branchId);

    const permissions = ['BRANCH_OPERATIONS', 'APPROVE_RETURNS', 'MONITOR_SHIFTS', 'MANAGE_STAFF'];

    const syncedUserId = await HierarchyService.syncUserToSupabase({
      userId: `usr_mgr_${Date.now().toString().slice(-4)}`,
      tenantId: tenantUuid,
      branchId: branchUuid,
      email,
      username: username || email.split('@')[0],
      password,
      fullName,
      phone,
      role: 'branch_manager',
      pinCode: '3333',
      permissions
    });

    return {
      success: true,
      message: `Branch Manager ${fullName} appointed for branch.`,
      user: { id: syncedUserId, fullName, email, role: 'branch_manager', branchId: branchUuid }
    };
  }

  /**
   * Branch Manager creates operational staff for their assigned branch.
   */
  static async createStaff({
    creatorRole,
    creatorTenantId,
    creatorBranchId,
    role,
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

    const tenantUuid = await sdb.resolveTenantUuid(creatorTenantId);
    const branchUuid = creatorBranchId ? await sdb.resolveBranchUuid(tenantUuid, creatorBranchId) : null;

    let defaultPermissions = [];
    if (role === 'supervisor') defaultPermissions = ['SUSPEND_TRANSACTION', 'RESUME_TRANSACTION', 'APPROVE_DISCOUNTS', 'BIOMETRIC_AUTH'];
    if (role === 'cashier') defaultPermissions = ['POS_CHECKOUT', 'ITEM_SCAN', 'MPESA_PAYMENT', 'CASH_SALE', 'REQUEST_SUSPEND'];
    if (role === 'inventory_manager') defaultPermissions = ['STOCK_ADJUSTMENT', 'STOCK_TRANSFER', 'RECEIVE_DELIVERY'];
    if (role === 'procurement_officer') defaultPermissions = ['PURCHASE_ORDERS', 'MANAGE_SUPPLIERS'];
    if (role === 'accountant') defaultPermissions = ['FINANCIAL_STATEMENTS', 'TAX_RECONCILIATION', 'EXPENSES'];
    if (role === 'auditor') defaultPermissions = ['READ_ONLY_AUDIT', 'AUDIT_LOG_INSPECTION'];

    const syncedUserId = await HierarchyService.syncUserToSupabase({
      userId: `usr_${role.slice(0, 3)}_${Date.now().toString().slice(-4)}`,
      tenantId: tenantUuid,
      branchId: branchUuid,
      email,
      username: username || email.split('@')[0],
      password,
      fullName,
      phone,
      role,
      pinCode,
      permissions: defaultPermissions
    });

    return {
      success: true,
      message: `${role.replace(/_/g, ' ').toUpperCase()} ${fullName} successfully appointed.`,
      user: { id: syncedUserId, fullName, email, role, branchId: branchUuid }
    };
  }
}

module.exports = HierarchyService;
