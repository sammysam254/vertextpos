/**
 * DEPRECATED - SQLite Datastore has been decommissioned.
 * All datastore operations must use Supabase Cloud PostgreSQL via `src/db/supabase-db.js`.
 */

class DecommissionedSqliteStore {
  constructor() {
    console.warn('[SQLITE DEPRECATED] SQLite has been deleted. System is configured to strictly use Supabase Cloud.');
  }

  queryOne() { return null; }
  queryAll() { return []; }
  run() { return { changes: 0 }; }
  prepare() { return { run: () => {}, all: () => [], get: () => null }; }
  exec() {}
  transaction(fn) { return fn ? fn() : null; }
}

module.exports = new DecommissionedSqliteStore();
