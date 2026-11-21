const fs = require("node:fs");
const path = require("node:path");
const { loadEnv } = require("../src/config");
loadEnv();

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("Configure DATABASE_URL para apontar ao PostgreSQL do Supabase.");
  }

  const sourcePath = path.resolve(
    process.env.SALAON_DB_PATH || path.join(process.cwd(), "data", "salaon.sqlite"),
  );
  if (!fs.existsSync(sourcePath)) {
    throw new Error("O arquivo SQLite de origem não foi encontrado: " + sourcePath);
  }

  const { DatabaseSync } = require("node:sqlite");
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  const { db, initDb, closeDb } = require("../src/db");
  const tables = [
    "salons",
    "users",
    "professionals",
    "clients",
    "categories",
    "payment_methods",
    "services",
    "sessions",
    "appointments",
    "appointment_items",
    "financial_transactions",
    "commissions",
    "cash_sessions",
    "audit_logs",
    "professional_services",
    "ai_conversations",
  ];

  try {
    await initDb();
    await db.withContext(async () => {
      const existing = Number((await db.prepare("SELECT COUNT(*) AS n FROM salons").get()).n);
      if (existing) {
        throw new Error("A base Supabase já contém um salão; a importação foi cancelada sem alterar os dados.");
      }

      await db.exec("BEGIN");
      try {
        let total = 0;
        for (const table of tables) {
          const rows = source.prepare("SELECT * FROM " + table).all();
          if (!rows.length) continue;
          const columns = Object.keys(rows[0]);
          const insert = db.prepare(
            "INSERT INTO " + table + "(" + columns.join(",") + ") VALUES(" + columns.map(() => "?").join(",") + ")",
          );
          for (const row of rows) {
            await insert.run(...columns.map((column) => row[column]));
            total += 1;
          }
          if (columns.includes("id")) {
            await db.prepare(
              "SELECT setval(pg_get_serial_sequence(?, 'id'), COALESCE(MAX(id),1), COUNT(*) > 0) FROM " + table,
            ).get(table);
          }
        }
        await db.exec("COMMIT");
        console.log("Importação concluída: " + total + " registros migrados.");
      } catch (error) {
        await db.exec("ROLLBACK");
        throw error;
      }
    });
  } finally {
    source.close();
    await closeDb();
  }
}

main().catch((error) => {
  console.error("Falha ao importar SQLite para Supabase:", error.message);
  process.exitCode = 1;
});
