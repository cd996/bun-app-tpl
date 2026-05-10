import type { AppDatabase } from "@/db";
import { createClient } from "@libsql/client";
import { getTableName } from "drizzle-orm";
import { getDataModules, resolveModulesWithDeps } from "./registry";

export async function verifyDek(dbPath: string, dekHex: string): Promise<void> {
  const client = createClient({ url: `file:${dbPath}`, encryptionKey: dekHex });
  try {
    await client.execute("SELECT count(*) FROM sqlite_master");
  }
  finally {
    client.close();
  }
}

export interface BackupData {
  version: number;
  exportedAt: string;
  modules: string[];
  tables: Record<string, Record<string, unknown>[]>;
}

const STREAM_BATCH_SIZE = 1000;

/**
 * Stream a backup as JSON. Returns a `ReadableStream<Uint8Array>` whose
 * chunks form a single JSON document — `{"version":1,...,"tables":{"a":[...]}}`.
 *
 * Memory cost is ~one batch (≤ STREAM_BATCH_SIZE rows × row size) instead of
 * the entire DB. This matters when the audit table is unbounded — a 100k-row
 * export with the previous in-memory `JSON.stringify(..., null, 2)` path
 * peaked at ~200 MB and could OOM on small VMs.
 */
export function streamJsonBackup(db: AppDatabase, selectedModules: string[]): {
  modules: string[];
  body: ReadableStream<Uint8Array>;
} {
  const modules = resolveModulesWithDeps(selectedModules);
  const registry = getDataModules();
  const enc = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(enc.encode(
          `{"version":1,"exportedAt":${JSON.stringify(new Date().toISOString())},`
          + `"modules":${JSON.stringify(modules)},"tables":{`,
        ));

        let firstTable = true;
        for (const modName of modules) {
          const mod = registry[modName];
          if (!mod)
            continue;

          for (const table of mod.tables) {
            const tableName = getTableName(table);
            controller.enqueue(enc.encode(
              `${firstTable ? "" : ","}${JSON.stringify(tableName)}:[`,
            ));
            firstTable = false;

            // Page through the table in fixed-size batches. Holds at most
            // one batch in memory; lets the V8 GC reclaim each chunk after
            // the JSON.stringify call returns.
            let offset = 0;
            let firstRow = true;
            while (true) {
              const rows = await db.select().from(table).limit(STREAM_BATCH_SIZE).offset(offset).all();
              if (rows.length === 0)
                break;
              for (const row of rows) {
                controller.enqueue(enc.encode((firstRow ? "" : ",") + JSON.stringify(row)));
                firstRow = false;
              }
              if (rows.length < STREAM_BATCH_SIZE)
                break;
              offset += STREAM_BATCH_SIZE;
            }

            controller.enqueue(enc.encode("]"));
          }
        }

        controller.enqueue(enc.encode("}}"));
        controller.close();
      }
      catch (err) {
        controller.error(err);
      }
    },
  });

  return { modules, body };
}

/**
 * @deprecated Held the whole DB in memory before stringifying. Kept for tests
 * that snapshot the in-memory shape; production export uses
 * {@link streamJsonBackup} instead.
 */
export async function generateJsonBackup(db: AppDatabase, selectedModules: string[]): Promise<BackupData> {
  const modules = resolveModulesWithDeps(selectedModules);
  const registry = getDataModules();

  const tables: Record<string, Record<string, unknown>[]> = {};

  for (const modName of modules) {
    const mod = registry[modName];
    if (!mod)
      continue;

    for (const table of mod.tables) {
      const tableName = getTableName(table);
      const rows = await db.select().from(table).all();
      tables[tableName] = rows as Record<string, unknown>[];
    }
  }

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    modules,
    tables,
  };
}
