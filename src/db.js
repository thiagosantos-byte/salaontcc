const fs = require("node:fs");
const path = require("node:path");
const { AsyncLocalStorage } = require("node:async_hooks");
const { loadEnv } = require("./config");
loadEnv();

const contexts = new AsyncLocalStorage();
const usingPostgres = Boolean(process.env.DATABASE_URL);
if (!usingPostgres && process.env.NODE_ENV === "production") {
  throw new Error("DATABASE_URL é obrigatório em produção para conectar ao PostgreSQL do Supabase.");
}
let sqlite;
let pool;
let dbPath = null;

if (usingPostgres) {
  const { Pool, types } = require("pg");
  types.setTypeParser(20, (value) => Number(value));
  types.setTypeParser(1700, (value) => Number(value));
  let connectionString = process.env.DATABASE_URL;
  let ssl;
  if (process.env.PGSSL === "disable") {
    ssl = false;
  } else if (process.env.PGSSL_CA_CERT) {
    // Remove URL SSL parameters so pg-connection-string does not override the supplied CA.
    const databaseUrl = new URL(connectionString);
    databaseUrl.searchParams.delete("sslmode");
    databaseUrl.searchParams.delete("sslrootcert");
    connectionString = databaseUrl.toString();
    ssl = {
      ca: process.env.PGSSL_CA_CERT.replace(/\\n/g, "\n"),
      rejectUnauthorized: true,
    };
  } else {
    ssl = { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== "false" };
  }
  pool = new Pool({
    connectionString,
    allowExitOnIdle: true,
    max: Number(process.env.DB_POOL_MAX || 5),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    ssl,
  });
  pool.on("error", (error) => console.error("Erro inesperado no pool PostgreSQL:", error));
} else {
  const { DatabaseSync } = require("node:sqlite");
  dbPath = path.resolve(
    process.env.SALAON_DB_PATH || path.join(process.cwd(), "data", "salaon.sqlite"),
  );
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  sqlite = new DatabaseSync(dbPath);
  sqlite.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
}

function toPostgres(sql) {
  let output = "";
  let parameter = 0;
  let quote = null;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    if (quote) {
      output += char;
      if (char === quote) {
        if (sql[i + 1] === quote) output += sql[++i];
        else quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      output += char;
      continue;
    }
    if (char === "?") {
      output += "$" + (++parameter);
      continue;
    }
    output += char;
  }
  return output
    .replace(/GROUP_CONCAT\(([^(),]+),\s*'([^']*)'\)/gi, "string_agg($1, '$2')")
    .replace(/\bLIKE\b/gi, "ILIKE")
    .replace(/HAVING\s+last_visit\s*<\s*\$(\d+)/gi, (_, number) => "HAVING MAX(substr(a.starts_at,1,10)) < $" + number)
    .replace(/\bCURRENT_TIMESTAMP\b/gi, "CURRENT_TIMESTAMP::TEXT");
}

function normalizePostgresError(error) {
  if (error && error.code === "23505") {
    error.message = "UNIQUE constraint failed: " + (error.constraint || "registro");
  }
  return error;
}

async function query(sql, args = []) {
  if (!usingPostgres) return null;
  const context = contexts.getStore();
  try {
    return await (context && context.client
      ? context.client.query(sql, args)
      : pool.query(sql, args));
  } catch (error) {
    throw normalizePostgresError(error);
  }
}

const db = {
  prepare(sql) {
    return {
      async get(...args) {
        if (!usingPostgres) return sqlite.prepare(sql).get(...args);
        const result = await query(toPostgres(sql), args);
        return result.rows[0];
      },
      async all(...args) {
        if (!usingPostgres) return sqlite.prepare(sql).all(...args);
        const result = await query(toPostgres(sql), args);
        return result.rows;
      },
      async run(...args) {
        if (!usingPostgres) {
          const result = sqlite.prepare(sql).run(...args);
          return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
        }
        let statement = toPostgres(sql);
        if (/^\s*INSERT\s+INTO\s+(salons|users|professionals|clients|categories|payment_methods|services|appointments|appointment_items|financial_transactions|commissions|cash_sessions|audit_logs|professional_services|ai_conversations)\b/i.test(statement) && !/\bRETURNING\b/i.test(statement)) {
          statement += " RETURNING id";
        }
        const result = await query(statement, args);
        return {
          changes: result.rowCount,
          lastInsertRowid: result.rows && result.rows[0] ? Number(result.rows[0].id) : undefined,
        };
      },
    };
  },
  async exec(sql) {
    if (!usingPostgres) {
      sqlite.exec(sql);
      return;
    }
    const command = sql.trim().toUpperCase();
    const context = contexts.getStore();
    if (command === "BEGIN" || command === "BEGIN IMMEDIATE") {
      if (!context) throw new Error("A transação requer contexto de requisição.");
      if (context.client) throw new Error("Transações aninhadas não são suportadas.");
      context.client = await pool.connect();
      try {
        await context.client.query("BEGIN");
      } catch (error) {
        context.client.release();
        context.client = null;
        throw normalizePostgresError(error);
      }
      return;
    }
    if (command === "COMMIT" || command === "ROLLBACK") {
      if (!context || !context.client) throw new Error("Não há transação aberta.");
      const client = context.client;
      try {
        await client.query(command);
      } catch (error) {
        throw normalizePostgresError(error);
      } finally {
        context.client = null;
        client.release();
      }
      return;
    }
    const client = context && context.client;
    if (client) {
      try {
        await client.query(sql);
      } catch (error) {
        throw normalizePostgresError(error);
      }
    } else {
      try {
        await pool.query(sql);
      } catch (error) {
        throw normalizePostgresError(error);
      }
    }
  },
  withContext(callback) {
    return contexts.run({ client: null }, callback);
  },
};

async function initDb() {
  return db.withContext(async () => {
    if (usingPostgres) {
      await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::TEXT))");
    } else {
      sqlite.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    }

    const migrationsDir = path.resolve(
      process.cwd(),
      usingPostgres ? "migrations/postgres" : "migrations",
    );
    const applied = new Set(
      (await db.prepare("SELECT version FROM schema_migrations").all()).map((row) => Number(row.version)),
    );
    for (const file of fs.readdirSync(migrationsDir).filter((name) => /^\d+_.*\.sql$/.test(name)).sort()) {
      const version = Number(file.split("_")[0]);
      if (applied.has(version)) continue;
      await db.exec(usingPostgres ? "BEGIN" : "BEGIN IMMEDIATE");
      try {
        await db.exec(fs.readFileSync(path.join(migrationsDir, file), "utf8"));
        await db.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(version);
        await db.exec("COMMIT");
      } catch (error) {
        await db.exec("ROLLBACK");
        throw error;
      }
    }
  });
}

async function closeDb() {
  if (pool) await pool.end();
  if (sqlite) sqlite.close();
}

module.exports = { db, dbPath, usingPostgres, initDb, closeDb };
