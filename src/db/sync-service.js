require('../load-env');
const sdb = require('./supabase-db');

/**
 * Cloud Synchronization & Status Engine for Vertext POS SaaS.
 * SQLite has been decommissioned; operations execute directly against Supabase Cloud PostgreSQL.
 */
class SyncService {
  constructor() {
    this.isSyncing = false;
    this.lastSyncedAt = new Date().toISOString();
  }

  enqueueSync(tenantId, entityType, entityId, operation, payload) {
    // In pure Supabase mode, all mutations execute directly on Supabase Cloud
    if (operation === 'INSERT') {
      sdb.insert(entityType, payload).catch(err => console.warn(`[SUPABASE CLOUD] Direct insert warning: ${err.message}`));
    } else if (operation === 'UPDATE') {
      sdb.update(entityType, { id: entityId }, payload).catch(err => console.warn(`[SUPABASE CLOUD] Direct update warning: ${err.message}`));
    }
  }

  async flushQueue() {
    this.lastSyncedAt = new Date().toISOString();
    return { synced: 0, status: 'DIRECT_SUPABASE_ONLINE' };
  }

  getSyncStatus() {
    return {
      isOnline: true,
      pendingOffline: 0,
      totalQueued: 0,
      lastSyncedAt: this.lastSyncedAt,
      supabaseConnected: sdb.isConfigured(),
      databaseEngine: 'Supabase Cloud PostgreSQL (Strictly Cloud Alone)'
    };
  }
}

module.exports = new SyncService();
