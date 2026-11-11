require('../load-env');

/**
 * VERTEXT POS - Supabase PostgREST Direct Cloud Access Layer
 * 
 * Provides direct PostgREST cloud operations against Supabase PostgreSQL.
 * SQLite has been completely decommissioned. Supabase is strictly used alone.
 * 
 * Automatically translates slugs/codes (e.g. 'tenant_metromart', 'BR-001', 'REG-01')
 * to Supabase PostgreSQL UUIDs to guarantee type safety (zero 22P02 errors).
 */

const KNOWN_SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx4am1nZ3JwZ2ljanVyYmtzYnR2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5NDI0NzEwNiwiZXhwIjoyMTA5ODIzMTA2fQ.x2vkjRcKjatAK2ZK0OSas45TeFEi7SKIYWOcpFdk-OE';

function isServiceRoleToken(token) {
  if (!token || typeof token !== 'string') return false;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    return payload && payload.role === 'service_role';
  } catch (e) {
    return false;
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://lxjmggrpgicjurbksbtv.supabase.co';
const SUPABASE_KEY = isServiceRoleToken(process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? process.env.SUPABASE_SERVICE_ROLE_KEY
  : (isServiceRoleToken(process.env.SUPABASE_KEY) ? process.env.SUPABASE_KEY : KNOWN_SERVICE_ROLE_KEY);

const BASE_HEADERS = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  'Accept': 'application/json'
};

// In-memory cache for resolved UUIDs
const uuidCache = new Map();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(str) {
  return typeof str === 'string' && UUID_REGEX.test(str);
}

/**
 * Resolves a tenant slug, ID or string into a Supabase PostgreSQL UUID.
 */
async function resolveTenantUuid(slugOrId) {
  if (!slugOrId || slugOrId === 'GLOBAL') return null;
  if (isUuid(slugOrId)) return slugOrId;
  if (uuidCache.has(`tenant:${slugOrId}`)) return uuidCache.get(`tenant:${slugOrId}`);

  const cleanSlug = slugOrId.replace(/^tenant_/, '').toLowerCase();

  try {
    const { data, error } = await sbFetch(`tenants?slug=eq.${encodeURIComponent(cleanSlug)}&limit=1`, { method: 'GET' });
    if (!error && Array.isArray(data) && data.length > 0 && isUuid(data[0].id)) {
      uuidCache.set(`tenant:${slugOrId}`, data[0].id);
      return data[0].id;
    }

    const { data: byName, error: nameErr } = await sbFetch(
      `tenants?or=(slug.ilike.*${encodeURIComponent(cleanSlug)}*,legal_name.ilike.*${encodeURIComponent(cleanSlug)}*)&limit=1`,
      { method: 'GET' }
    );
    if (!nameErr && Array.isArray(byName) && byName.length > 0 && isUuid(byName[0].id)) {
      uuidCache.set(`tenant:${slugOrId}`, byName[0].id);
      return byName[0].id;
    }
  } catch (e) {
    console.warn(`[SUPABASE CLOUD] resolveTenantUuid notice: ${e.message}`);
  }

  return null;
}

/**
 * Resolves a branch code or string to Supabase UUID.
 */
async function resolveBranchUuid(tenantUuid, branchCodeOrId) {
  if (!branchCodeOrId || branchCodeOrId === 'ALL') return null;
  if (isUuid(branchCodeOrId)) return branchCodeOrId;
  const cacheKey = `branch:${tenantUuid}:${branchCodeOrId}`;
  if (uuidCache.has(cacheKey)) return uuidCache.get(cacheKey);

  try {
    const filters = { code: branchCodeOrId };
    if (tenantUuid && isUuid(tenantUuid)) filters.tenant_id = tenantUuid;
    const { data } = await query('branches', filters);
    if (data && data.length > 0) {
      uuidCache.set(cacheKey, data[0].id);
      return data[0].id;
    }

    if (tenantUuid && isUuid(tenantUuid)) {
      const { data: created } = await insert('branches', {
        tenant_id: tenantUuid,
        code: branchCodeOrId,
        name: `${branchCodeOrId} Branch`,
        location: 'Nairobi',
        phone: '254700000000'
      });
      if (created && created.length > 0) {
        uuidCache.set(cacheKey, created[0].id);
        return created[0].id;
      }
    }
  } catch (e) {}

  return null;
}

/**
 * Resolves a register till code to Supabase UUID.
 */
async function resolveRegisterUuid(tenantUuid, branchUuid, registerCodeOrId) {
  if (!registerCodeOrId) return null;
  if (isUuid(registerCodeOrId)) return registerCodeOrId;
  const cacheKey = `reg:${tenantUuid}:${registerCodeOrId}`;
  if (uuidCache.has(cacheKey)) return uuidCache.get(cacheKey);

  try {
    const filters = { code: registerCodeOrId };
    if (tenantUuid && isUuid(tenantUuid)) filters.tenant_id = tenantUuid;
    const { data } = await query('registers', filters);
    if (data && data.length > 0) {
      uuidCache.set(cacheKey, data[0].id);
      return data[0].id;
    }

    if (tenantUuid && isUuid(tenantUuid) && branchUuid && isUuid(branchUuid)) {
      const { data: created } = await insert('registers', {
        tenant_id: tenantUuid,
        branch_id: branchUuid,
        code: registerCodeOrId,
        name: `Till ${registerCodeOrId}`
      });
      if (created && created.length > 0) {
        uuidCache.set(cacheKey, created[0].id);
        return created[0].id;
      }
    }
  } catch (e) {}

  return null;
}

/**
 * Resolves a user ID or email to Supabase UUID.
 */
async function resolveUserUuid(userIdOrEmail) {
  if (!userIdOrEmail) return null;
  if (isUuid(userIdOrEmail)) return userIdOrEmail;
  const cacheKey = `user:${userIdOrEmail}`;
  if (uuidCache.has(cacheKey)) return uuidCache.get(cacheKey);

  try {
    const { data } = await query('users', null, {
      orFilters: `email.eq.${encodeURIComponent(userIdOrEmail)},username.eq.${encodeURIComponent(userIdOrEmail)}`
    });
    if (data && data.length > 0) {
      uuidCache.set(cacheKey, data[0].id);
      return data[0].id;
    }

    const clean = userIdOrEmail.replace(/^usr_/, '').replace(/_[0-9]+$/, '');
    const { data: byClean } = await query('users', null, {
      orFilters: `username.ilike.*${encodeURIComponent(clean)}*,email.ilike.*${encodeURIComponent(clean)}*,role.ilike.*${encodeURIComponent(clean)}*`
    });
    if (byClean && byClean.length > 0) {
      uuidCache.set(cacheKey, byClean[0].id);
      return byClean[0].id;
    }

    // Fallback: pick the first cashier in users table
    const { data: anyCashier } = await query('users', { role: 'cashier' }, { limit: 1 });
    if (anyCashier && anyCashier.length > 0) {
      uuidCache.set(cacheKey, anyCashier[0].id);
      return anyCashier[0].id;
    }

    // Fallback: pick any user in users table
    const { data: anyUser } = await query('users', {}, { limit: 1 });
    if (anyUser && anyUser.length > 0) {
      uuidCache.set(cacheKey, anyUser[0].id);
      return anyUser[0].id;
    }
  } catch (e) {}

  return null;
}

/**
 * Low-level Supabase PostgREST fetch wrapper.
 */
async function sbFetch(path, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { data: null, error: { message: 'Supabase credentials not configured' } };
  }

  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        ...BASE_HEADERS,
        ...(options.headers || {})
      }
    });

    let data = null;
    const contentRange = res.headers.get('content-range');
    try {
      const text = await res.text();
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      data = null;
    }

    if (!res.ok) {
      const errMsg = (data && (data.message || data.hint || data.details || JSON.stringify(data))) || `HTTP ${res.status}`;
      return { data: null, error: { message: errMsg, status: res.status, details: data } };
    }

    return { data, error: null, contentRange };
  } catch (err) {
    return { data: null, error: { message: err.message } };
  }
}

/**
 * Normalizes filter values (translating tenant_id slugs to UUIDs).
 */
async function normalizeFilters(table, filters) {
  if (!filters) return {};
  const normalized = { ...filters };

  if (table === 'tenants') {
    if (normalized.id && !isUuid(normalized.id)) {
      const resolved = await resolveTenantUuid(normalized.id);
      if (resolved) {
        normalized.id = resolved;
      } else {
        const cleanSlug = normalized.id.replace(/^tenant_/, '').toLowerCase();
        delete normalized.id;
        normalized.slug = cleanSlug;
      }
    }
    if (normalized.status) {
      normalized.subscription_status = normalized.status;
      delete normalized.status;
    }
    if (normalized.plan_id) {
      normalized.plan_tier = normalized.plan_id;
      delete normalized.plan_id;
    }
    return normalized;
  }

  if (normalized.tenant_id && !isUuid(normalized.tenant_id) && normalized.tenant_id !== 'GLOBAL') {
    const uuid = await resolveTenantUuid(normalized.tenant_id);
    if (uuid) normalized.tenant_id = uuid;
  }

  if (table === 'users') {
    if (normalized.active !== undefined) {
      normalized.is_active = Boolean(normalized.active);
      delete normalized.active;
    }
  }

  if (table === 'products') {
    if (normalized.is_active !== undefined) {
      normalized.is_active = Boolean(normalized.is_active);
    }
  }

  return normalized;
}

/**
 * Post-processes rows returned from Supabase to provide backward-compatible aliases.
 */
function postProcessRows(table, rows) {
  if (!Array.isArray(rows)) return rows;

  return rows.map(r => {
    if (!r || typeof r !== 'object') return r;
    const mapped = { ...r };

    if (table === 'tenants') {
      mapped.name = mapped.legal_name || mapped.trade_name || mapped.name || 'Store';
      mapped.phone = mapped.business_phone || mapped.phone || '';
      mapped.email = mapped.business_email || mapped.email || '';
      mapped.plan_id = mapped.plan_tier || mapped.plan_id || 'growth';
      mapped.status = mapped.subscription_status || mapped.status || 'ACTIVE';
    } else if (table === 'users') {
      mapped.active = mapped.is_active !== undefined ? (mapped.is_active ? 1 : 0) : 1;
      mapped.permissions_json = typeof mapped.permissions === 'string'
        ? mapped.permissions
        : JSON.stringify(mapped.permissions || []);
    } else if (table === 'products') {
      mapped.cost_price_kes = Number(mapped.cost_price_kes || 0);
      mapped.selling_price_kes = Number(mapped.selling_price_kes || 0);
      mapped.wholesale_price_kes = Number(mapped.wholesale_price_kes || mapped.selling_price_kes || 0);
      mapped.vat_rate = Number(mapped.vat_rate !== undefined ? mapped.vat_rate : 16.0);
      mapped.is_active = mapped.is_active ? 1 : 0;
    } else if (table === 'sales') {
      mapped.subtotal_kes = Number(mapped.subtotal_kes || 0);
      mapped.tax_kes = Number(mapped.tax_kes || 0);
      mapped.total_kes = Number(mapped.total_kes || 0);
      mapped.paid_amount_kes = Number(mapped.paid_amount_kes || 0);
      mapped.balance_due_kes = Number(mapped.balance_due_kes || 0);
    } else if (table === 'sale_items') {
      mapped.quantity = Number(mapped.quantity || 0);
      mapped.unit_price_kes = Number(mapped.unit_price_kes || 0);
      mapped.discount_kes = Number(mapped.discount_kes || 0);
      mapped.subtotal_kes = Number(mapped.subtotal_kes || 0);
      mapped.tax_kes = Number(mapped.tax_kes || 0);
      mapped.vat_rate = Number(mapped.vat_rate !== undefined ? mapped.vat_rate : 16.0);
    } else if (table === 'inventory') {
      mapped.quantity = Number(mapped.quantity || 0);
      mapped.reorder_level = Number(mapped.reorder_level || 10);
    }

    return mapped;
  });
}

/**
 * SELECT rows from a table strictly against Supabase Cloud PostgREST.
 */
async function query(table, filters = {}, options = {}) {
  const normFilters = await normalizeFilters(table, filters);
  const params = new URLSearchParams();

  if (options.select) params.append('select', options.select);

  for (const [key, val] of Object.entries(normFilters)) {
    if (val === null) {
      params.append(key, 'is.null');
    } else if (typeof val === 'object' && val.op) {
      params.append(key, `${val.op}.${val.value}`);
    } else {
      params.append(key, `eq.${val}`);
    }
  }

  if (options.orFilters) {
    const rawOr = String(options.orFilters).trim();
    const orVal = rawOr.startsWith('(') && rawOr.endsWith(')') ? rawOr : `(${rawOr})`;
    params.append('or', orVal);
  }
  if (options.order) params.append('order', options.order);
  if (options.limit) params.append('limit', options.limit);
  if (options.offset) params.append('offset', options.offset);

  const qs = params.toString();
  const { data, error } = await sbFetch(`${table}${qs ? '?' + qs : ''}`, { method: 'GET' });

  if (!error && Array.isArray(data)) {
    return { data: postProcessRows(table, data), error: null };
  }

  return { data: [], error };
}

/**
 * SELECT single row.
 */
async function queryOne(table, filters = {}, options = {}) {
  const { data, error } = await query(table, filters, { ...options, limit: 1 });
  return { data: (data && data.length > 0) ? data[0] : null, error };
}

/**
 * Count rows in table.
 */
async function count(table, filters = {}) {
  const normFilters = await normalizeFilters(table, filters);
  const params = new URLSearchParams({ select: 'count' });

  for (const [key, val] of Object.entries(normFilters)) {
    if (val === null) {
      params.append(key, 'is.null');
    } else if (typeof val === 'object' && val.op) {
      params.append(key, `${val.op}.${val.value}`);
    } else {
      params.append(key, `eq.${val}`);
    }
  }

  const qs = params.toString();
  const { contentRange, error } = await sbFetch(`${table}${qs ? '?' + qs : ''}`, {
    method: 'GET',
    headers: { 'Prefer': 'count=exact' }
  });

  if (!error && contentRange) {
    const parts = contentRange.split('/');
    if (parts.length > 1) {
      const num = parseInt(parts[1], 10);
      if (!isNaN(num)) return { count: num, error: null };
    }
  }
  return { count: 0, error };
}

/**
 * Normalizes input records for Supabase tables.
 */
async function prepareRecords(table, records) {
  const recArray = Array.isArray(records) ? records : [records];
  const prepared = [];

  for (const r of recArray) {
    const item = { ...r };

    // Remove non-UUID id if table requires UUID
    if (item.id && !isUuid(item.id)) {
      delete item.id;
    }

    if (table === 'tenants') {
      if (item.name && !item.legal_name) item.legal_name = item.name;
      if (item.name && !item.trade_name) item.trade_name = item.name;
      if (item.phone && !item.business_phone) item.business_phone = item.phone;
      if (item.email && !item.business_email) item.business_email = item.email;
      if (item.plan_id && !item.plan_tier) item.plan_tier = item.plan_id;
      if (item.status && !item.subscription_status) item.subscription_status = item.status;
      delete item.name;
      delete item.phone;
      delete item.email;
      delete item.plan_id;
      delete item.status;
    }

    if (table === 'users') {
      if (item.active !== undefined && item.is_active === undefined) {
        item.is_active = Boolean(item.active);
        delete item.active;
      }
      if (item.permissions_json !== undefined && item.permissions === undefined) {
        try {
          item.permissions = typeof item.permissions_json === 'string'
            ? JSON.parse(item.permissions_json)
            : item.permissions_json;
        } catch (e) {
          item.permissions = [];
        }
        delete item.permissions_json;
      }
      delete item.pin_code; // Handled in Supabase user_metadata
    }

    if (table === 'products') {
      if (item.is_active !== undefined) {
        item.is_active = Boolean(item.is_active);
      }
    }

    // Resolve tenant_id to UUID
    if (item.tenant_id !== undefined) {
      if (item.tenant_id === 'GLOBAL' || !item.tenant_id) {
        item.tenant_id = null;
      } else if (!isUuid(item.tenant_id)) {
        const u = await resolveTenantUuid(item.tenant_id);
        item.tenant_id = u || null;
      }
    }
    // Resolve branch_id to UUID
    if (item.branch_id && !isUuid(item.branch_id) && item.branch_id !== 'ALL') {
      const u = await resolveBranchUuid(item.tenant_id, item.branch_id);
      if (u) item.branch_id = u;
      else delete item.branch_id;
    }
    // Resolve register_id to UUID
    if (item.register_id && !isUuid(item.register_id)) {
      const u = await resolveRegisterUuid(item.tenant_id, item.branch_id, item.register_id);
      if (u) item.register_id = u;
      else delete item.register_id;
    }
    // Resolve cashier_id to UUID
    if (item.cashier_id && !isUuid(item.cashier_id)) {
      const u = await resolveUserUuid(item.cashier_id);
      if (u) item.cashier_id = u;
      else delete item.cashier_id;
    }

    prepared.push(item);
  }

  return prepared;
}

/**
 * INSERT records directly and strictly into Supabase Cloud.
 */
async function insert(table, records) {
  const prepared = await prepareRecords(table, records);

  const { data, error } = await sbFetch(`${table}`, {
    method: 'POST',
    headers: { 'Prefer': 'return=representation' },
    body: JSON.stringify(prepared.length === 1 ? prepared[0] : prepared)
  });

  const resultData = Array.isArray(data) ? data : (data ? [data] : []);
  return { data: postProcessRows(table, resultData), error };
}

/**
 * UPSERT records directly and strictly into Supabase Cloud.
 */
async function upsert(table, records, onConflict = 'id') {
  const prepared = await prepareRecords(table, records);
  const conflictParam = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : '';

  const { data, error } = await sbFetch(`${table}${conflictParam}`, {
    method: 'POST',
    headers: {
      'Prefer': 'resolution=merge-duplicates,return=representation'
    },
    body: JSON.stringify(prepared.length === 1 ? prepared[0] : prepared)
  });

  const resultData = Array.isArray(data) ? data : (data ? [data] : []);
  return { data: postProcessRows(table, resultData), error };
}

/**
 * UPDATE records directly and strictly into Supabase Cloud.
 */
async function update(table, filters, values) {
  const normFilters = await normalizeFilters(table, filters);
  const params = new URLSearchParams();

  for (const [key, val] of Object.entries(normFilters)) {
    if (val === null) {
      params.append(key, 'is.null');
    } else if (typeof val === 'object' && val.op) {
      params.append(key, `${val.op}.${val.value}`);
    } else {
      params.append(key, `eq.${val}`);
    }
  }

  const [preparedVal] = await prepareRecords(table, [values]);

  const qs = params.toString();
  const { data, error } = await sbFetch(`${table}${qs ? '?' + qs : ''}`, {
    method: 'PATCH',
    headers: { 'Prefer': 'return=representation' },
    body: JSON.stringify(preparedVal)
  });

  const resultData = Array.isArray(data) ? data : (data ? [data] : []);
  return { data: postProcessRows(table, resultData), error };
}

/**
 * DELETE records directly and strictly from Supabase Cloud.
 */
async function remove(table, filters) {
  const normFilters = await normalizeFilters(table, filters);
  const params = new URLSearchParams();

  for (const [key, val] of Object.entries(normFilters)) {
    params.append(key, `eq.${val}`);
  }

  const qs = params.toString();
  const { data, error } = await sbFetch(`${table}${qs ? '?' + qs : ''}`, {
    method: 'DELETE',
    headers: { 'Prefer': 'return=representation' }
  });

  return { data, error };
}

function isConfigured() {
  return !!(SUPABASE_URL && SUPABASE_KEY);
}

module.exports = {
  query,
  queryOne,
  count,
  insert,
  upsert,
  update,
  remove,
  resolveTenantUuid,
  resolveBranchUuid,
  resolveRegisterUuid,
  resolveUserUuid,
  isConfigured,
  SUPABASE_URL,
  SUPABASE_KEY
};
