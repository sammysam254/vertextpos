const db = require('./sqlite-store');
const supabase = require('./supabase-client');

/**
 * Offline-First Cloud Synchronization Engine for Vertext POS.
 * Enables zero-downtime local execution with automatic real-time sync to Supabase.
 * If internet connection drops, transactions queue locally and sync automatically once online.
 */
class SyncService {
  constructor() {
    this.isSyncing = false;
    this.lastSyncedAt = null;
    this.initBackgroundWorker();
  }

  /**
   * Enqueues an entity change into the local offline queue.
   */
  enqueueSync(tenantId, entityType, entityId, operation, payload) {
    const queueId = `SYNC-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    try {
      db.run(
        `INSERT INTO offline_sync_queue (id, tenant_id, entity_type, entity_id, operation, payload_json, status, retry_count)
         VALUES (?, ?, ?, ?, ?, ?, 'PENDING', 0)`,
        [queueId, tenantId, entityType, entityId, operation, JSON.stringify(payload)]
      );
      // Attempt immediate sync asynchronously
      this.flushQueue().catch(() => {});
    } catch (err) {
      console.warn('[SYNC QUEUE] Warning enqueuing sync record:', err.message);
    }
  }

  /**
   * Flushes pending items in offline_sync_queue to Supabase.
   */
  async flushQueue() {
    if (this.isSyncing) return;
    this.isSyncing = true;

    try {
      const hasSupabase = !!(process.env.SUPABASE_URL && (process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY));
      if (!hasSupabase) {
        this.isSyncing = false;
        return { synced: 0, reason: 'SUPABASE_KEYS_NOT_CONFIGURED_YET' };
      }

      const pending = db.queryAll(
        "SELECT * FROM offline_sync_queue WHERE status = 'PENDING' ORDER BY created_at ASC LIMIT 25"
      );

      if (pending.length === 0) {
        this.isSyncing = false;
        return { synced: 0 };
      }

      let syncedCount = 0;
      for (const item of pending) {
        try {
          const payload = JSON.parse(item.payload_json);
          const table = item.entity_type; // e.g. 'sales', 'sale_items', 'inventory', 'tenants'

          if (item.operation === 'INSERT') {
            await supabase.from(table).insert(payload);
          } else if (item.operation === 'UPDATE') {
            await supabase.from(table).update(payload).eq('id', item.entity_id);
          }

          db.run(
            "UPDATE offline_sync_queue SET status = 'SYNCED', synced_at = datetime('now') WHERE id = ?",
            [item.id]
          );
          syncedCount++;
        } catch (itemErr) {
          db.run(
            "UPDATE offline_sync_queue SET retry_count = retry_count + 1 WHERE id = ?",
            [item.id]
          );
        }
      }

      this.lastSyncedAt = new Date().toISOString();
      this.isSyncing = false;
      return { synced: syncedCount };
    } catch (err) {
      this.isSyncing = false;
      return { synced: 0, error: err.message };
    }
  }

  /**
   * Returns current sync status for UI status badge.
   */
  getSyncStatus() {
    const hasSupabase = !!(process.env.SUPABASE_URL && (process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY));
    const pending = db.queryOne("SELECT COUNT(id) as count FROM offline_sync_queue WHERE status = 'PENDING'");
    const total = db.queryOne("SELECT COUNT(id) as count FROM offline_sync_queue");

    return {
      isOnline: true,
      hasCloudCredentials: hasSupabase,
      supabaseUrl: process.env.SUPABASE_URL || 'Configured via .env on Netlify/Cloud',
      pendingQueueCount: pending ? pending.count : 0,
      totalQueueCount: total ? total.count : 0,
      lastSyncedAt: this.lastSyncedAt,
      status: hasSupabase ? ((pending && pending.count === 0) ? 'SYNCED' : 'SYNCING') : 'LOCAL_OFFLINE_READY'
    };
  }

  initBackgroundWorker() {
    const timer = setInterval(() => {
      this.flushQueue().catch(() => {});
    }, 15000);
    if (timer && timer.unref) timer.unref();
  }
}

module.exports = new SyncService();

