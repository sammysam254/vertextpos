require('../load-env');

/**
 * Supabase Client Integration Adapter for Vertext POS SaaS.
 * Pure Supabase Cloud PostgREST query builder API.
 * SQLite decommissioned - strictly connects to Supabase Cloud PostgreSQL.
 */

class SupabaseQueryBuilder {
  constructor(table, client) {
    this.table = table;
    this.client = client;
    this.selectColumns = '*';
    this.filterParams = {};
    this.orderByClause = null;
    this.limitCount = null;
    this.offsetCount = null;
  }

  select(columns = '*') {
    this.selectColumns = columns;
    return this;
  }

  eq(column, value) {
    this.filterParams[column] = `eq.${value}`;
    return this;
  }

  neq(column, value) {
    this.filterParams[column] = `neq.${value}`;
    return this;
  }

  gt(column, value) {
    this.filterParams[column] = `gt.${value}`;
    return this;
  }

  lt(column, value) {
    this.filterParams[column] = `lt.${value}`;
    return this;
  }

  gte(column, value) {
    this.filterParams[column] = `gte.${value}`;
    return this;
  }

  lte(column, value) {
    this.filterParams[column] = `lte.${value}`;
    return this;
  }

  ilike(column, pattern) {
    this.filterParams[column] = `ilike.${pattern}`;
    return this;
  }

  order(column, { ascending = true } = {}) {
    this.orderByClause = `${column}.${ascending ? 'asc' : 'desc'}`;
    return this;
  }

  limit(count) {
    this.limitCount = count;
    return this;
  }

  range(from, to) {
    this.offsetCount = from;
    this.limitCount = to - from + 1;
    return this;
  }

  async single() {
    this.limit(1);
    const res = await this._executeSelect();
    if (res.data && res.data.length > 0) {
      return { data: res.data[0], error: null };
    }
    return { data: null, error: res.error || { message: 'Row not found' } };
  }

  async then(resolve, reject) {
    const res = await this._executeSelect();
    resolve(res);
  }

  async _executeSelect() {
    try {
      const queryParams = new URLSearchParams({ select: this.selectColumns });
      Object.entries(this.filterParams).forEach(([k, v]) => queryParams.append(k, v));
      if (this.orderByClause) queryParams.append('order', this.orderByClause);
      if (this.limitCount) queryParams.append('limit', this.limitCount);
      if (this.offsetCount) queryParams.append('offset', this.offsetCount);

      const url = `${this.client.url}/rest/v1/${this.table}?${queryParams.toString()}`;
      const res = await fetch(url, {
        method: 'GET',
        headers: this.client.headers
      });

      const data = await res.json();
      if (!res.ok) {
        return { data: null, error: data };
      }
      return { data, error: null };
    } catch (err) {
      return { data: null, error: { message: err.message } };
    }
  }

  async insert(recordOrRecords) {
    try {
      const url = `${this.client.url}/rest/v1/${this.table}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          ...this.client.headers,
          'Prefer': 'return=representation'
        },
        body: JSON.stringify(recordOrRecords)
      });
      const data = await res.json();
      if (!res.ok) {
        return { data: null, error: data };
      }
      return { data: Array.isArray(data) ? data : [data], error: null };
    } catch (err) {
      return { data: null, error: { message: err.message } };
    }
  }

  async update(values) {
    try {
      const queryParams = new URLSearchParams();
      Object.entries(this.filterParams).forEach(([k, v]) => queryParams.append(k, v));
      const url = `${this.client.url}/rest/v1/${this.table}?${queryParams.toString()}`;
      const res = await fetch(url, {
        method: 'PATCH',
        headers: {
          ...this.client.headers,
          'Prefer': 'return=representation'
        },
        body: JSON.stringify(values)
      });
      const data = await res.json();
      if (!res.ok) {
        return { data: null, error: data };
      }
      return { data: Array.isArray(data) ? data : [data], error: null };
    } catch (err) {
      return { data: null, error: { message: err.message } };
    }
  }

  async delete() {
    try {
      const queryParams = new URLSearchParams();
      Object.entries(this.filterParams).forEach(([k, v]) => queryParams.append(k, v));
      const url = `${this.client.url}/rest/v1/${this.table}?${queryParams.toString()}`;
      const res = await fetch(url, {
        method: 'DELETE',
        headers: {
          ...this.client.headers,
          'Prefer': 'return=representation'
        }
      });
      const data = await res.json();
      if (!res.ok) {
        return { data: null, error: data };
      }
      return { data, error: null };
    } catch (err) {
      return { data: null, error: { message: err.message } };
    }
  }
}

class SupabaseClient {
  constructor() {
    this.url = process.env.SUPABASE_URL || '';
    this.key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || '';
    this.headers = {
      'apikey': this.key,
      'Authorization': `Bearer ${this.key}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
    console.log(`[SUPABASE] Pure Cloud PostgREST Client initialized (${this.url})`);
  }

  from(table) {
    return new SupabaseQueryBuilder(table, this);
  }

  get auth() {
    return {
      getUser: async (token) => {
        const JwtAuth = require('../security/jwt-auth');
        const user = JwtAuth.verifyToken(token);
        if (user) return { data: { user }, error: null };
        return { data: { user: null }, error: { message: 'Invalid session' } };
      }
    };
  }
}

module.exports = new SupabaseClient();
