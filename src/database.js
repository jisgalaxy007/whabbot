import pg from 'pg';
import fs from 'fs';
import path from 'path';

const { Pool } = pg;

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : process.cwd();
const QUEUE_FILE = path.resolve(DATA_DIR, 'queue.json');

// URL padrão: Cluster Fly Postgres interno (metaai-db / whabot_db)
const defaultFlyPostgresUrl =
  'postgres://whabot:b51g1VGhWsMX5QY@metaai-db.flycast:5432/whabot_db?sslmode=disable';

const connectionString = process.env.DATABASE_URL || defaultFlyPostgresUrl;

const isSslDisabled =
  connectionString.includes('sslmode=disable') ||
  connectionString.includes('.flycast') ||
  connectionString.includes('localhost') ||
  connectionString.includes('127.0.0.1');

export const pool = new Pool({
  connectionString,
  ssl: isSslDisabled ? false : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 20000,
  connectionTimeoutMillis: 3500 // 3.5 segundos para falhar rápido e nunca travar o bot
});

// Flag de circuito: se o DB falhar consecutivamente, pausa chamadas por 20 segundos
let isDbHealthy = true;
let nextDbCheckTime = 0;

pool.on('error', (err) => {
  console.warn('⚠️ [PostgreSQL Pool Warning]:', err.message);
  isDbHealthy = false;
  nextDbCheckTime = Date.now() + 20000;
});

// Funções auxiliares para fila local quando o banco estiver offline
function loadLocalQueue() {
  try {
    if (fs.existsSync(QUEUE_FILE)) {
      return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'));
    }
  } catch (e) {}
  return { pending: [], history: [], nextScheduledRun: null };
}

function saveLocalQueue(data) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {}
}

/**
 * Função utilitária para executar consultas com auto-retry rápido
 */
async function executeWithRetry(fn, retries = 2) {
  if (!isDbHealthy && Date.now() < nextDbCheckTime) {
    throw new Error('PostgreSQL temporariamente em modo de espera por falha anterior');
  }

  let attempt = 0;
  while (attempt < retries) {
    attempt++;
    try {
      const res = await fn();
      isDbHealthy = true;
      return res;
    } catch (err) {
      const isConnError =
        err.message.includes('terminated unexpectedly') ||
        err.message.includes('closed') ||
        err.message.includes('timeout') ||
        err.message.includes('connect ECONNREFUSED') ||
        err.code === '57P01';

      if (isConnError && attempt < retries) {
        await new Promise((r) => setTimeout(r, 600));
      } else {
        if (isConnError) {
          isDbHealthy = false;
          nextDbCheckTime = Date.now() + 20000;
        }
        throw err;
      }
    }
  }
}

/**
 * Inicializa a tabela de links no PostgreSQL se não existir
 */
export async function initDb() {
  const query = `
    CREATE TABLE IF NOT EXISTS group_links (
      id SERIAL PRIMARY KEY,
      code VARCHAR(64) UNIQUE NOT NULL,
      url TEXT NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      group_name TEXT DEFAULT '',
      reason TEXT DEFAULT '',
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;
  try {
    await executeWithRetry(async () => {
      const client = await pool.connect();
      try {
        await client.query(query);
      } finally {
        client.release();
      }
    });
    console.log('🐘 PostgreSQL conectado e tabela group_links pronta!');
  } catch (err) {
    console.warn('⚠️ PostgreSQL offline ou inacessível no momento. Usando armazenamento local em disco (/var/data):', err.message);
  }
}

/**
 * Adiciona novos convites ao PostgreSQL ou fila local
 */
export async function addLinks(items) {
  if (!items || items.length === 0) {
    const totalPending = await getPendingCount();
    return { addedCount: 0, totalPending };
  }

  let addedCount = 0;

  try {
    await executeWithRetry(async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const item of items) {
          const res = await client.query(
            `INSERT INTO group_links (code, url, status) 
             VALUES ($1, $2, 'pending') 
             ON CONFLICT (code) DO NOTHING;`,
            [item.code, item.url]
          );
          if (res.rowCount > 0) {
            addedCount++;
          }
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    });
    const totalPending = await getPendingCount();
    return { addedCount, totalPending };
  } catch (err) {
    // Fallback transparente para armazenamento local em arquivo
    const local = loadLocalQueue();
    const existingCodes = new Set([
      ...local.pending.map((i) => i.code),
      ...local.history.map((h) => h.code)
    ]);

    for (const item of items) {
      if (!existingCodes.has(item.code)) {
        existingCodes.add(item.code);
        local.pending.push({
          code: item.code,
          url: item.url,
          addedAt: new Date().toISOString()
        });
        addedCount++;
      }
    }
    saveLocalQueue(local);
    return { addedCount, totalPending: local.pending.length };
  }
}

/**
 * Retorna todos os links com status 'pending'
 */
export async function getPendingLinks() {
  try {
    return await executeWithRetry(async () => {
      const res = await pool.query(
        `SELECT id, code, url FROM group_links WHERE status = 'pending' ORDER BY id ASC;`
      );
      return res.rows;
    });
  } catch (err) {
    const local = loadLocalQueue();
    return local.pending.map((item, idx) => ({
      id: idx + 1,
      code: item.code,
      url: item.url
    }));
  }
}

/**
 * Retorna o total de links com status 'pending'
 */
export async function getPendingCount() {
  try {
    return await executeWithRetry(async () => {
      const res = await pool.query(`SELECT COUNT(*)::int as count FROM group_links WHERE status = 'pending';`);
      return res.rows[0]?.count || 0;
    });
  } catch (err) {
    const local = loadLocalQueue();
    return local.pending.length;
  }
}

/**
 * Atualiza o status e informações de um link após a tentativa de entrada
 */
export async function updateLinkStatus(code, status, groupName = '', reason = '') {
  try {
    await executeWithRetry(async () => {
      await pool.query(
        `UPDATE group_links 
         SET status = $1, group_name = $2, reason = $3, updated_at = NOW() 
         WHERE code = $4;`,
        [status, groupName, reason, code]
      );
    });
  } catch (err) {
    // Atualiza na fila local
    const local = loadLocalQueue();
    const idx = local.pending.findIndex((p) => p.code === code);
    if (idx !== -1) {
      const item = local.pending.splice(idx, 1)[0];
      local.history.push({
        ...item,
        status,
        groupName,
        reason,
        processedAt: new Date().toISOString()
      });
      saveLocalQueue(local);
    }
  }
}

/**
 * Retorna o resumo estatístico de todos os links no banco ou fila local
 */
export async function getStats() {
  try {
    return await executeWithRetry(async () => {
      const res = await pool.query(`
        SELECT 
          COUNT(*)::int as total,
          COUNT(*) FILTER (WHERE status = 'pending')::int as pending,
          COUNT(*) FILTER (WHERE status = 'success')::int as success,
          COUNT(*) FILTER (WHERE status = 'failed')::int as failed,
          COUNT(*) FILTER (WHERE status = 'rate_limited')::int as rate_limited
        FROM group_links;
      `);
      return res.rows[0] || { total: 0, pending: 0, success: 0, failed: 0, rate_limited: 0 };
    });
  } catch (err) {
    const local = loadLocalQueue();
    const pending = local.pending.length;
    const success = local.history.filter((h) => h.status === 'success').length;
    const failed = local.history.filter((h) => h.status === 'failed').length;
    const rateLimited = local.history.filter((h) => h.status === 'rate_limited').length;
    const total = pending + local.history.length;
    return { total, pending, success, failed, rate_limited: rateLimited };
  }
}

/**
 * Remove todos os links do banco de dados e da fila local
 */
export async function deleteAllLinks() {
  let count = 0;
  try {
    await executeWithRetry(async () => {
      const res = await pool.query(`DELETE FROM group_links;`);
      count = res.rowCount;
    });
  } catch (err) {}

  const local = loadLocalQueue();
  count = Math.max(count, local.pending.length + local.history.length);
  saveLocalQueue({ pending: [], history: [], nextScheduledRun: null });
  return count;
}

/**
 * Retorna todos os links cadastrados (para GET /api/links e dashboard)
 */
export async function getAllLinks(statusFilter = null) {
  try {
    return await executeWithRetry(async () => {
      if (statusFilter) {
        const res = await pool.query(
          `SELECT id, code, url, status, group_name, reason, created_at, updated_at 
           FROM group_links WHERE status = $1 ORDER BY id DESC;`,
          [statusFilter]
        );
        return res.rows;
      }
      const res = await pool.query(
        `SELECT id, code, url, status, group_name, reason, created_at, updated_at 
         FROM group_links ORDER BY id DESC LIMIT 500;`
      );
      return res.rows;
    });
  } catch (err) {
    const local = loadLocalQueue();
    const all = [
      ...local.pending.map((p) => ({
        code: p.code,
        url: p.url,
        status: 'pending',
        group_name: '',
        reason: '',
        created_at: p.addedAt
      })),
      ...local.history.map((h) => ({
        code: h.code,
        url: h.url,
        status: h.status || 'processed',
        group_name: h.groupName || '',
        reason: h.reason || '',
        created_at: h.addedAt || h.processedAt
      }))
    ];
    if (statusFilter) {
      return all.filter((i) => i.status === statusFilter);
    }
    return all.slice(0, 500);
  }
}
