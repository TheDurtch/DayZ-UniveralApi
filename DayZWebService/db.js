'use strict';

const log = require('./log');

// ─── Nested-path helpers ──────────────────────────────────────────────────────

// Guard against prototype pollution via malicious key names
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function getNestedValue(obj, dotPath) {
    const parts = dotPath.split('.');
    let cur = obj;
    for (const p of parts) {
        if (UNSAFE_KEYS.has(p)) return undefined;
        if (cur == null || typeof cur !== 'object') return undefined;
        cur = cur[p];
    }
    return cur;
}

function setNestedValue(obj, dotPath, value) {
    const parts = dotPath.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (UNSAFE_KEYS.has(p)) return;
        if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {};
        cur = cur[p];
    }
    const last = parts[parts.length - 1];
    if (!UNSAFE_KEYS.has(last)) cur[last] = value;
}

function deleteNestedValue(obj, dotPath) {
    const parts = dotPath.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        if (UNSAFE_KEYS.has(parts[i])) return;
        if (cur == null) return;
        cur = cur[parts[i]];
    }
    const last = parts[parts.length - 1];
    if (cur != null && !UNSAFE_KEYS.has(last)) delete cur[last];
}

// ─── MongoDB update-operator emulation ───────────────────────────────────────

function applyUpdate(doc, update) {
    for (const [op, fields] of Object.entries(update)) {
        switch (op) {
            case '$set':
                for (const [path, val] of Object.entries(fields))
                    setNestedValue(doc, path, val);
                break;
            case '$inc':
                for (const [path, delta] of Object.entries(fields)) {
                    const cur = getNestedValue(doc, path) || 0;
                    setNestedValue(doc, path, cur + delta);
                }
                break;
            case '$unset':
                for (const path of Object.keys(fields))
                    deleteNestedValue(doc, path);
                break;
            case '$mul':
                for (const [path, factor] of Object.entries(fields)) {
                    const cur = getNestedValue(doc, path) || 0;
                    setNestedValue(doc, path, cur * factor);
                }
                break;
            case '$push':
                for (const [path, val] of Object.entries(fields)) {
                    let arr = getNestedValue(doc, path);
                    if (!Array.isArray(arr)) arr = [];
                    arr.push(val);
                    setNestedValue(doc, path, arr);
                }
                break;
            case '$pull':
                for (const [path, condition] of Object.entries(fields)) {
                    let arr = getNestedValue(doc, path);
                    if (Array.isArray(arr)) {
                        if (typeof condition === 'object' && condition !== null) {
                            arr = arr.filter(item => !matchesDoc({ _: item }, { _: condition }));
                        } else {
                            arr = arr.filter(item => item !== condition);
                        }
                        setNestedValue(doc, path, arr);
                    }
                }
                break;
            case '$pullAll':
                for (const [path, values] of Object.entries(fields)) {
                    let arr = getNestedValue(doc, path);
                    if (Array.isArray(arr) && Array.isArray(values)) {
                        arr = arr.filter(item => !values.includes(item));
                        setNestedValue(doc, path, arr);
                    }
                }
                break;
            case '$rename':
                for (const [oldPath, newPath] of Object.entries(fields)) {
                    const val = getNestedValue(doc, oldPath);
                    deleteNestedValue(doc, oldPath);
                    setNestedValue(doc, newPath, val);
                }
                break;
        }
    }
    return doc;
}

// ─── MongoDB query emulation ─────────────────────────────────────────────────

function matchesCondition(docVal, cond) {
    if (cond === null || typeof cond !== 'object') return docVal === cond;
    for (const [op, opVal] of Object.entries(cond)) {
        switch (op) {
            case '$exists': if (opVal ? docVal === undefined : docVal !== undefined) return false; break;
            case '$eq':     if (docVal !== opVal) return false; break;
            case '$ne':     if (docVal === opVal) return false; break;
            case '$gt':     if (!(docVal > opVal)) return false; break;
            case '$gte':    if (!(docVal >= opVal)) return false; break;
            case '$lt':     if (!(docVal < opVal)) return false; break;
            case '$lte':    if (!(docVal <= opVal)) return false; break;
            case '$in':     if (!Array.isArray(opVal) || !opVal.includes(docVal)) return false; break;
            case '$nin':    if (!Array.isArray(opVal) || opVal.includes(docVal)) return false; break;
            case '$regex': {
                const flags = cond.$options || '';
                const rx = opVal instanceof RegExp ? opVal : new RegExp(opVal, flags);
                if (typeof docVal !== 'string' || !rx.test(docVal)) return false;
                break;
            }
            case '$options': break; // consumed by $regex
            default:
                // Plain nested-object equality (e.g. { field: { sub: val } })
                if (!matchesDoc(docVal, cond)) return false;
                return true;
        }
    }
    return true;
}

function matchesDoc(doc, query) {
    if (!query || typeof query !== 'object') return true;
    for (const [key, cond] of Object.entries(query)) {
        if (key === '$and') {
            if (!Array.isArray(cond) || !cond.every(sub => matchesDoc(doc, sub))) return false;
        } else if (key === '$or') {
            if (!Array.isArray(cond) || !cond.some(sub => matchesDoc(doc, sub))) return false;
        } else if (key === '$nor') {
            if (!Array.isArray(cond) || cond.some(sub => matchesDoc(doc, sub))) return false;
        } else if (key === '$not') {
            if (matchesDoc(doc, cond)) return false;
        } else {
            const docVal = getNestedValue(doc, key);
            if (!matchesCondition(docVal, cond)) return false;
        }
    }
    return true;
}

function sortDocs(docs, sortSpec) {
    if (!sortSpec || typeof sortSpec !== 'object' || !Object.keys(sortSpec).length) return docs;
    const fields = Object.entries(sortSpec);
    return [...docs].sort((a, b) => {
        for (const [field, dir] of fields) {
            const av = getNestedValue(a, field);
            const bv = getNestedValue(b, field);
            if (av < bv) return dir < 0 ? 1 : -1;
            if (av > bv) return dir < 0 ? -1 : 1;
        }
        return 0;
    });
}

// ─── Collection name → SQL table name ────────────────────────────────────────

const KNOWN_TABLES = new Set(['players', 'objects', 'globals']);

function tableForCollection(coll) {
    const map = { Players: 'players', Objects: 'objects', Globals: 'globals' };
    return map[coll] || coll.toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

// ─── SQLite adapter ───────────────────────────────────────────────────────────

class SQLiteCollection {
    constructor(db, tableName) {
        this._db = db;
        this._table = tableName;
    }

    // Build a SQL WHERE clause for indexed columns present in `query`.
    // Returns { where, values, unindexedQuery }.
    _sqlForQuery(query) {
        const t = this._table;
        const indexed = {
            players: ['GUID', 'AUTH'],
            objects: ['ObjectId', 'Mod'],
            globals: ['Mod'],
        }[t] || [];

        const conditions = [];
        const values = [];
        const unindexed = {};

        const colMap = { GUID: 'guid', AUTH: 'auth', ObjectId: 'object_id', Mod: 'mod' };

        for (const [k, v] of Object.entries(query)) {
            if (indexed.includes(k)) {
                conditions.push(`${colMap[k]} = ?`);
                values.push(v);
            } else {
                unindexed[k] = v;
            }
        }
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        return { where, values, unindexedQuery: unindexed };
    }

    _getRows(query) {
        const { where, values, unindexedQuery } = this._sqlForQuery(query);
        let rows = this._db.prepare(`SELECT * FROM ${this._table} ${where}`).all(...values);
        if (Object.keys(unindexedQuery).length > 0) {
            rows = rows.filter(row => matchesDoc(JSON.parse(row.doc), unindexedQuery));
        }
        return rows;
    }

    _rowToDoc(row) {
        if (!row) return null;
        return JSON.parse(row.doc);
    }

    _saveRow(doc) {
        const docStr = JSON.stringify(doc);
        const t = this._table;
        if (t === 'players') {
            this._db.prepare(
                'INSERT OR REPLACE INTO players (guid, auth, doc) VALUES (?, ?, ?)'
            ).run(doc.GUID || null, doc.AUTH || null, docStr);
        } else if (t === 'objects') {
            this._db.prepare(
                'INSERT OR REPLACE INTO objects (object_id, mod, doc) VALUES (?, ?, ?)'
            ).run(doc.ObjectId || null, doc.Mod || null, docStr);
        } else if (t === 'globals') {
            this._db.prepare(
                'INSERT OR REPLACE INTO globals (mod, doc) VALUES (?, ?)'
            ).run(doc.Mod || null, docStr);
        }
    }

    find(query) {
        return new SQLiteCursor(this, query);
    }

    async countDocuments(query) {
        return this._getRows(query).length;
    }

    async insertOne(doc) {
        this._saveRow(doc);
        return { ops: [doc], insertedId: doc.GUID || doc.ObjectId || doc.Mod };
    }

    async insertMany(docs) {
        let insertedCount = 0;
        for (const doc of docs) {
            this._saveRow(doc);
            insertedCount++;
        }
        return { insertedCount, insertedIds: [] };
    }

    async updateOne(query, update, options = {}) {
        const rows = this._getRows(query);
        if (rows.length === 0) {
            if (options.upsert) {
                let newDoc = {};
                // Seed indexed key fields from the query
                if (query.GUID) newDoc.GUID = query.GUID;
                if (query.ObjectId) newDoc.ObjectId = query.ObjectId;
                if (query.Mod) newDoc.Mod = query.Mod;
                newDoc = applyUpdate(newDoc, update);
                this._saveRow(newDoc);
                return { matchedCount: 0, upsertedCount: 1, modifiedCount: 0 };
            }
            return { matchedCount: 0, upsertedCount: 0, modifiedCount: 0 };
        }
        const doc = this._rowToDoc(rows[0]);
        const updated = applyUpdate(doc, update);
        this._saveRow(updated);
        return { matchedCount: 1, upsertedCount: 0, modifiedCount: 1 };
    }

    async distinct(field, query) {
        const rows = this._getRows(query);
        const seen = new Set();
        for (const row of rows) {
            const v = getNestedValue(JSON.parse(row.doc), field);
            if (v !== undefined && v !== null) seen.add(v);
        }
        return [...seen];
    }

    async createIndex() {
        // Tables and indexes are created at adapter initialization
        return 'ok';
    }
}

class SQLiteCursor {
    constructor(collection, query) {
        this._coll = collection;
        this._query = query;
        this._sortSpec = null;
        this._limitN = 0;
    }

    sort(spec) { this._sortSpec = spec; return this; }
    limit(n) { this._limitN = n; return this; }

    async toArray() {
        const rows = this._coll._getRows(this._query);
        let docs = rows.map(row => JSON.parse(row.doc));
        if (this._sortSpec) docs = sortDocs(docs, this._sortSpec);
        if (this._limitN > 0) docs = docs.slice(0, this._limitN);
        return docs;
    }
}

// Generic SQLite collection for arbitrary collection names (e.g. Logs, QnAMaker).
// Rows are stored with an auto-increment id and a JSON doc column.
class SQLiteGenericCollection {
    constructor(db, tableName) {
        this._db = db;
        this._table = tableName;
        // Ensure the table exists (safe to call repeatedly)
        this._db.exec(`
            CREATE TABLE IF NOT EXISTS "${this._table}" (
                id  INTEGER PRIMARY KEY AUTOINCREMENT,
                doc TEXT NOT NULL DEFAULT '{}'
            );
        `);
    }

    find(query) {
        return new SQLiteGenericCursor(this, query);
    }

    _getRows(query) {
        const rows = this._db.prepare(`SELECT * FROM "${this._table}"`).all();
        if (!query || !Object.keys(query).length) return rows;
        return rows.filter(row => matchesDoc(JSON.parse(row.doc), query));
    }

    async countDocuments(query) {
        return this._getRows(query).length;
    }

    async insertOne(doc) {
        const docStr = JSON.stringify(doc);
        const result = this._db.prepare(`INSERT INTO "${this._table}" (doc) VALUES (?)`).run(docStr);
        return { ops: [doc], insertedId: result.lastInsertRowid };
    }

    async insertMany(docs) {
        let insertedCount = 0;
        const stmt = this._db.prepare(`INSERT INTO "${this._table}" (doc) VALUES (?)`);
        for (const doc of docs) {
            stmt.run(JSON.stringify(doc));
            insertedCount++;
        }
        return { insertedCount, insertedIds: [] };
    }

    async updateOne(query, update, options = {}) {
        const rows = this._getRows(query);
        if (rows.length === 0) {
            if (options.upsert) {
                const newDoc = applyUpdate({}, update);
                const docStr = JSON.stringify(newDoc);
                this._db.prepare(`INSERT INTO "${this._table}" (doc) VALUES (?)`).run(docStr);
                return { matchedCount: 0, upsertedCount: 1, modifiedCount: 0 };
            }
            return { matchedCount: 0, upsertedCount: 0, modifiedCount: 0 };
        }
        const doc = JSON.parse(rows[0].doc);
        const updated = applyUpdate(doc, update);
        this._db.prepare(`UPDATE "${this._table}" SET doc = ? WHERE id = ?`)
            .run(JSON.stringify(updated), rows[0].id);
        return { matchedCount: 1, upsertedCount: 0, modifiedCount: 1 };
    }

    async distinct(field, query) {
        const rows = this._getRows(query);
        const seen = new Set();
        for (const row of rows) {
            const v = getNestedValue(JSON.parse(row.doc), field);
            if (v !== undefined && v !== null) seen.add(v);
        }
        return [...seen];
    }

    async createIndex() { return 'ok'; }
}

class SQLiteGenericCursor {
    constructor(collection, query) {
        this._coll = collection;
        this._query = query;
        this._sortSpec = null;
        this._limitN = 0;
    }
    sort(spec) { this._sortSpec = spec; return this; }
    limit(n) { this._limitN = n; return this; }
    async toArray() {
        const rows = this._coll._getRows(this._query);
        let docs = rows.map(row => JSON.parse(row.doc));
        if (this._sortSpec) docs = sortDocs(docs, this._sortSpec);
        if (this._limitN > 0) docs = docs.slice(0, this._limitN);
        return docs;
    }
}

class SQLiteAdapter {
    constructor() {
        this._db = null;
    }

    _initialize() {
        if (this._db) return;
        const BetterSQLite = require('better-sqlite3');
        const dbPath = global.config.DBServer || './dayz.db';
        this._db = new BetterSQLite(dbPath);
        // WAL mode for concurrent access under Node.js cluster
        this._db.pragma('journal_mode = WAL');
        this._db.exec(`
            CREATE TABLE IF NOT EXISTS players (
                guid     TEXT PRIMARY KEY,
                auth     TEXT,
                doc      TEXT NOT NULL DEFAULT '{}'
            );
            CREATE INDEX IF NOT EXISTS players_auth ON players (guid, auth);
            CREATE TABLE IF NOT EXISTS objects (
                object_id TEXT NOT NULL,
                mod       TEXT NOT NULL,
                doc       TEXT NOT NULL DEFAULT '{}',
                PRIMARY KEY (object_id, mod)
            );
            CREATE TABLE IF NOT EXISTS globals (
                mod  TEXT PRIMARY KEY,
                doc  TEXT NOT NULL DEFAULT '{}'
            );
        `);
    }

    createClient() {
        const self = this;
        return {
            connect: async () => { self._initialize(); },
            db: (_name) => ({
                collection: (coll) => {
                    const tableName = tableForCollection(coll);
                    if (KNOWN_TABLES.has(tableName)) {
                        return new SQLiteCollection(self._db, tableName);
                    }
                    return new SQLiteGenericCollection(self._db, tableName);
                },
            }),
            close: async () => { /* shared connection – do not close per-request */ },
        };
    }
}

// ─── PostgreSQL adapter ───────────────────────────────────────────────────────

class PostgreSQLCollection {
    constructor(pool, tableName) {
        this._pool = pool;
        this._table = tableName;
    }

    async _query(sql, values) {
        const client = await this._pool.connect();
        try {
            return await client.query(sql, values);
        } finally {
            client.release();
        }
    }

    // Build a parameterized WHERE clause for indexed columns in `query`.
    _sqlForQuery(query) {
        const t = this._table;
        const indexed = {
            players: ['GUID', 'AUTH'],
            objects: ['ObjectId', 'Mod'],
            globals: ['Mod'],
        }[t] || [];

        const colMap = { GUID: 'guid', AUTH: 'auth', ObjectId: 'object_id', Mod: 'mod' };
        const conditions = [];
        const values = [];
        const unindexed = {};
        let idx = 1;

        for (const [k, v] of Object.entries(query)) {
            if (indexed.includes(k)) {
                conditions.push(`${colMap[k]} = $${idx++}`);
                values.push(v);
            } else {
                unindexed[k] = v;
            }
        }
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        return { where, values, unindexedQuery: unindexed };
    }

    async _getRows(query) {
        const { where, values, unindexedQuery } = this._sqlForQuery(query);
        const result = await this._query(`SELECT * FROM ${this._table} ${where}`, values);
        let rows = result.rows;
        if (Object.keys(unindexedQuery).length > 0) {
            rows = rows.filter(row => {
                const doc = typeof row.doc === 'string' ? JSON.parse(row.doc) : row.doc;
                return matchesDoc(doc, unindexedQuery);
            });
        }
        return rows;
    }

    _rowToDoc(row) {
        if (!row) return null;
        return typeof row.doc === 'string' ? JSON.parse(row.doc) : row.doc;
    }

    _buildUpsertSQL(doc) {
        const docStr = JSON.stringify(doc);
        const t = this._table;
        if (t === 'players') {
            return {
                sql: `INSERT INTO players (guid, auth, doc) VALUES ($1, $2, $3)
                      ON CONFLICT (guid) DO UPDATE SET auth = EXCLUDED.auth, doc = EXCLUDED.doc`,
                values: [doc.GUID || null, doc.AUTH || null, docStr],
            };
        }
        if (t === 'objects') {
            return {
                sql: `INSERT INTO objects (object_id, mod, doc) VALUES ($1, $2, $3)
                      ON CONFLICT (object_id, mod) DO UPDATE SET doc = EXCLUDED.doc`,
                values: [doc.ObjectId || null, doc.Mod || null, docStr],
            };
        }
        if (t === 'globals') {
            return {
                sql: `INSERT INTO globals (mod, doc) VALUES ($1, $2)
                      ON CONFLICT (mod) DO UPDATE SET doc = EXCLUDED.doc`,
                values: [doc.Mod || null, docStr],
            };
        }
        throw new Error(`Unknown table: ${t}`);
    }

    find(query) {
        return new PostgreSQLCursor(this, query);
    }

    async countDocuments(query) {
        return (await this._getRows(query)).length;
    }

    async insertOne(doc) {
        const { sql, values } = this._buildUpsertSQL(doc);
        await this._query(sql, values);
        return { ops: [doc], insertedId: doc.GUID || doc.ObjectId || doc.Mod };
    }

    async insertMany(docs) {
        if (docs.length === 0) return { insertedCount: 0, insertedIds: [] };
        const pgClient = await this._pool.connect();
        let insertedCount = 0;
        try {
            await pgClient.query('BEGIN');
            for (const doc of docs) {
                const { sql, values } = this._buildUpsertSQL(doc);
                await pgClient.query(sql, values);
                insertedCount++;
            }
            await pgClient.query('COMMIT');
        } catch (e) {
            await pgClient.query('ROLLBACK');
            throw e;
        } finally {
            pgClient.release();
        }
        return { insertedCount, insertedIds: [] };
    }

    async updateOne(query, update, options = {}) {
        const rows = await this._getRows(query);
        if (rows.length === 0) {
            if (options.upsert) {
                let newDoc = {};
                if (query.GUID) newDoc.GUID = query.GUID;
                if (query.ObjectId) newDoc.ObjectId = query.ObjectId;
                if (query.Mod) newDoc.Mod = query.Mod;
                newDoc = applyUpdate(newDoc, update);
                const { sql, values } = this._buildUpsertSQL(newDoc);
                await this._query(sql, values);
                return { matchedCount: 0, upsertedCount: 1, modifiedCount: 0 };
            }
            return { matchedCount: 0, upsertedCount: 0, modifiedCount: 0 };
        }
        const doc = this._rowToDoc(rows[0]);
        const updated = applyUpdate(doc, update);
        const { sql, values } = this._buildUpsertSQL(updated);
        await this._query(sql, values);
        return { matchedCount: 1, upsertedCount: 0, modifiedCount: 1 };
    }

    async distinct(field, query) {
        const rows = await this._getRows(query);
        const seen = new Set();
        for (const row of rows) {
            const v = getNestedValue(this._rowToDoc(row), field);
            if (v !== undefined && v !== null) seen.add(v);
        }
        return [...seen];
    }

    async createIndex() {
        return 'ok';
    }
}

class PostgreSQLCursor {
    constructor(collection, query) {
        this._coll = collection;
        this._query = query;
        this._sortSpec = null;
        this._limitN = 0;
    }

    sort(spec) { this._sortSpec = spec; return this; }
    limit(n) { this._limitN = n; return this; }

    async toArray() {
        const rows = await this._coll._getRows(this._query);
        let docs = rows.map(row => this._coll._rowToDoc(row));
        if (this._sortSpec) docs = sortDocs(docs, this._sortSpec);
        if (this._limitN > 0) docs = docs.slice(0, this._limitN);
        return docs;
    }
}

class PostgreSQLAdapter {
    constructor() {
        this._pool = null;
    }

    async _initialize() {
        if (this._pool) return;
        const { Pool } = require('pg');
        this._pool = new Pool({ connectionString: global.config.DBServer });
        await this._pool.query(`
            CREATE TABLE IF NOT EXISTS players (
                guid      TEXT PRIMARY KEY,
                auth      TEXT,
                doc       JSONB NOT NULL DEFAULT '{}'
            );
            CREATE INDEX IF NOT EXISTS players_auth ON players (guid, auth);
            CREATE TABLE IF NOT EXISTS objects (
                object_id TEXT NOT NULL,
                mod       TEXT NOT NULL,
                doc       JSONB NOT NULL DEFAULT '{}',
                PRIMARY KEY (object_id, mod)
            );
            CREATE TABLE IF NOT EXISTS globals (
                mod  TEXT PRIMARY KEY,
                doc  JSONB NOT NULL DEFAULT '{}'
            );
        `);
    }

    createClient() {
        const self = this;
        return {
            connect: async () => { await self._initialize(); },
            db: (_name) => ({
                collection: (coll) => {
                    const tableName = tableForCollection(coll);
                    if (KNOWN_TABLES.has(tableName)) {
                        return new PostgreSQLCollection(self._pool, tableName);
                    }
                    return new PostgreSQLGenericCollection(self._pool, tableName);
                },
            }),
            close: async () => { /* shared pool – do not close per-request */ },
        };
    }
}

// Generic PostgreSQL collection for arbitrary collection names.
class PostgreSQLGenericCollection {
    constructor(pool, tableName) {
        this._pool = pool;
        this._table = tableName;
        this._ready = null; // promise that resolves when the table is ready
    }

    async _ensureTable() {
        if (!this._ready) {
            this._ready = this._pool.query(
                `CREATE TABLE IF NOT EXISTS "${this._table}" (
                    id  SERIAL PRIMARY KEY,
                    doc JSONB NOT NULL DEFAULT '{}'
                )`
            );
        }
        await this._ready;
    }

    async _query(sql, values) {
        await this._ensureTable();
        const client = await this._pool.connect();
        try {
            return await client.query(sql, values);
        } finally {
            client.release();
        }
    }

    find(query) { return new PostgreSQLGenericCursor(this, query); }

    async _getRows(query) {
        const result = await this._query(`SELECT * FROM "${this._table}"`, []);
        let rows = result.rows;
        if (query && Object.keys(query).length > 0) {
            rows = rows.filter(row => {
                const doc = typeof row.doc === 'string' ? JSON.parse(row.doc) : row.doc;
                return matchesDoc(doc, query);
            });
        }
        return rows;
    }

    _rowToDoc(row) {
        return typeof row.doc === 'string' ? JSON.parse(row.doc) : row.doc;
    }

    async countDocuments(query) {
        return (await this._getRows(query)).length;
    }

    async insertOne(doc) {
        await this._query(`INSERT INTO "${this._table}" (doc) VALUES ($1)`, [JSON.stringify(doc)]);
        return { ops: [doc], insertedId: null };
    }

    async insertMany(docs) {
        if (docs.length === 0) return { insertedCount: 0, insertedIds: [] };
        await this._ensureTable();
        const pgClient = await this._pool.connect();
        let insertedCount = 0;
        try {
            await pgClient.query('BEGIN');
            for (const doc of docs) {
                await pgClient.query(`INSERT INTO "${this._table}" (doc) VALUES ($1)`, [JSON.stringify(doc)]);
                insertedCount++;
            }
            await pgClient.query('COMMIT');
        } catch (e) {
            await pgClient.query('ROLLBACK');
            throw e;
        } finally {
            pgClient.release();
        }
        return { insertedCount, insertedIds: [] };
    }

    async updateOne(query, update, options = {}) {
        const rows = await this._getRows(query);
        if (rows.length === 0) {
            if (options.upsert) {
                const newDoc = applyUpdate({}, update);
                await this._query(`INSERT INTO "${this._table}" (doc) VALUES ($1)`, [JSON.stringify(newDoc)]);
                return { matchedCount: 0, upsertedCount: 1, modifiedCount: 0 };
            }
            return { matchedCount: 0, upsertedCount: 0, modifiedCount: 0 };
        }
        const doc = this._rowToDoc(rows[0]);
        const updated = applyUpdate(doc, update);
        await this._query(`UPDATE "${this._table}" SET doc = $1 WHERE id = $2`, [JSON.stringify(updated), rows[0].id]);
        return { matchedCount: 1, upsertedCount: 0, modifiedCount: 1 };
    }

    async distinct(field, query) {
        const rows = await this._getRows(query);
        const seen = new Set();
        for (const row of rows) {
            const v = getNestedValue(this._rowToDoc(row), field);
            if (v !== undefined && v !== null) seen.add(v);
        }
        return [...seen];
    }

    async createIndex() { return 'ok'; }
}

class PostgreSQLGenericCursor {
    constructor(collection, query) {
        this._coll = collection;
        this._query = query;
        this._sortSpec = null;
        this._limitN = 0;
    }
    sort(spec) { this._sortSpec = spec; return this; }
    limit(n) { this._limitN = n; return this; }
    async toArray() {
        const rows = await this._coll._getRows(this._query);
        let docs = rows.map(row => this._coll._rowToDoc(row));
        if (this._sortSpec) docs = sortDocs(docs, this._sortSpec);
        if (this._limitN > 0) docs = docs.slice(0, this._limitN);
        return docs;
    }
}

// ─── MongoDB pass-through adapter ────────────────────────────────────────────

class MongoAdapter {
    createClient() {
        const { MongoClient } = require('mongodb');
        return new MongoClient(global.config.DBServer, { useUnifiedTopology: true });
    }
}

// ─── Singletons ───────────────────────────────────────────────────────────────

let _mongoAdapter = null;
let _sqliteAdapter = null;
let _pgAdapter = null;

function getAdapter() {
    const type = (global.config.DBType || 'mongodb').toLowerCase();
    if (type === 'sqlite' || type === 'sqlite3') {
        if (!_sqliteAdapter) _sqliteAdapter = new SQLiteAdapter();
        return _sqliteAdapter;
    }
    if (type === 'postgresql' || type === 'postgres' || type === 'pg') {
        if (!_pgAdapter) _pgAdapter = new PostgreSQLAdapter();
        return _pgAdapter;
    }
    if (!_mongoAdapter) _mongoAdapter = new MongoAdapter();
    return _mongoAdapter;
}

/**
 * Returns a client object compatible with the MongoClient API surface used
 * across this codebase.  For SQLite and PostgreSQL the returned client wraps
 * a shared connection / pool; `connect()` and `close()` are therefore safe
 * to call on every request without actually opening/closing connections.
 */
function createClient() {
    return getAdapter().createClient();
}

/**
 * Create database indexes (MongoDB) or ensure tables exist (SQLite / PG).
 * Returns true on success, false on failure.
 */
async function installIndexes() {
    const type = (global.config.DBType || 'mongodb').toLowerCase();

    if (type === 'sqlite' || type === 'sqlite3' ||
        type === 'postgresql' || type === 'postgres' || type === 'pg') {
        try {
            // Initializing the adapter creates the tables / indexes
            const client = createClient();
            await client.connect();
            log('Database tables and indexes are ready');
            return true;
        } catch (e) {
            log(e, 'warn');
            return false;
        }
    }

    // MongoDB: create explicit indexes
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(global.config.DBServer, { useUnifiedTopology: true });
    try {
        await client.connect();
        const db = client.db(global.config.DB);
        const pcollection = db.collection('Players');
        await pcollection.createIndex({ GUID: 1 });
        await pcollection.createIndex({ GUID: 1, AUTH: 1 });
        const ocollection = db.collection('Objects');
        await ocollection.createIndex({ ObjectId: 1, Mod: 1 });
        const gcollection = db.collection('Globals');
        await gcollection.createIndex({ Mod: 1 });
        log('Successfully Created Indexes');
        return true;
    } catch (e) {
        log(e, 'warn');
        return false;
    } finally {
        await client.close();
    }
}

module.exports = { createClient, installIndexes };
