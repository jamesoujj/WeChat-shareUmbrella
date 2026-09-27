'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const TABLES = ['users', 'umbrellas', 'loans', 'reminders', 'scoreEvents', 'lockEvents', 'maintenance', 'damageReports', 'deviceEvents'];

function openStore(file, seed) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new DatabaseSync(file);
  sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  sqlite.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  for (const table of TABLES) sqlite.exec(`CREATE TABLE IF NOT EXISTS "${table}" (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
  sqlite.exec('CREATE INDEX IF NOT EXISTS loans_user ON loans (json_extract(data, \'$.userId\'))');
  sqlite.exec('CREATE INDEX IF NOT EXISTS loans_umbrella ON loans (json_extract(data, \'$.umbrellaId\'))');
  const getMeta = sqlite.prepare('SELECT value FROM meta WHERE key = ?');
  const putMeta = sqlite.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)');
  const readers = Object.fromEntries(TABLES.map(table => [table, sqlite.prepare(`SELECT data FROM "${table}" ORDER BY rowid`)]));
  const clearers = Object.fromEntries(TABLES.map(table => [table, sqlite.prepare(`DELETE FROM "${table}"`)]));
  const writers = Object.fromEntries(TABLES.map(table => [table, sqlite.prepare(`INSERT INTO "${table}"(id,data) VALUES(?,?)`)]));
  function write(state) {
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      putMeta.run('version', String(state.version));
      putMeta.run('offsetMs', String(state.offsetMs));
      for (const table of TABLES) {
        clearers[table].run();
        for (const item of state[table]) writers[table].run(String(item.id), JSON.stringify(item));
      }
      sqlite.exec('COMMIT');
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  }
  if (!getMeta.get('version')) write(seed());
  const version = Number(getMeta.get('version').value);
  if (version !== 2) { sqlite.close(); throw new Error(`不支持的数据版本 ${version}，请备份数据库后迁移。`); }
  function read() {
    const state = { version, offsetMs: Number(getMeta.get('offsetMs').value) };
    for (const table of TABLES) state[table] = readers[table].all().map(row => JSON.parse(row.data));
    return state;
  }
  return { read, write, close: () => sqlite.close() };
}

module.exports = { openStore };
