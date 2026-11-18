// One factory builds the list/get/create/update/delete endpoints for every simple
// master-data table, so faculty, rooms, sections and courses all behave the same way:
//   GET    /            ?q=search&page=1&limit=20&sort=name&order=asc&<filter>=value
//   GET    /:id
//   POST   /            (admin/hod)
//   PATCH  /:id         (admin/hod)
//   DELETE /:id         (admin/hod)
import { Router } from 'express';
import { z } from 'zod';
import { query, transaction } from '../db/pg.js';
import { canEdit } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { notFound } from '../utils/errors.js';
import { newId } from '../utils/ids.js';
import { audit } from '../models/AuditLog.js';
import { cacheDel } from '../services/redis.js';

const camelToSnake = (s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const snakeToCamel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

export const toApi = (row) => {
  const out = {};
  for (const [k, v] of Object.entries(row)) if (k !== 'total_count') out[snakeToCamel(k)] = v;
  return out;
};

export const listQuery = (sortable, filters = []) =>
  z.object({
    q: z.string().trim().max(100).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(500).default(20),
    sort: z.enum(sortable).default(sortable[0]),
    order: z.enum(['asc', 'desc']).default('asc'),
    ...Object.fromEntries(filters.map((f) => [f, z.string().trim().max(60).optional()])),
  });

export const idParam = z.object({ id: z.string().trim().min(1).max(64).regex(/^[\w.-]+$/, 'Invalid id') });

/**
 * @param {object} cfg
 * @param {string} cfg.table        SQL table
 * @param {string} cfg.entity       name used in messages and audit logs
 * @param {string} cfg.idPrefix     prefix for generated ids ("fac" → "fac-x1y2z3")
 * @param {z.ZodObject} cfg.schema  body schema for create (update uses .partial())
 * @param {string[]} cfg.searchable columns matched by ?q=
 * @param {string[]} cfg.sortable   allowed ?sort= values (camelCase), first is default
 * @param {string[]} [cfg.filters]  exact-match filters (camelCase)
 * @param {string} [cfg.extraSelect] extra SQL select expressions (e.g. sub-queries)
 * @param {(client, id, body) => Promise} [cfg.afterWrite] save related rows in the same transaction
 * @param {string[]} [cfg.virtualFields] body fields handled by afterWrite, not stored as columns
 */
export function crudRouter(cfg) {
  const { table, entity, idPrefix, schema, searchable, sortable, filters = [], extraSelect = '', afterWrite, virtualFields = [] } = cfg;
  const router = Router();
  const select = `SELECT t.*${extraSelect ? `, ${extraSelect}` : ''}, count(*) OVER() AS total_count FROM ${table} t`;
  const createSchema = schema.extend({ id: idParam.shape.id.optional() });
  const columnsOf = (body) => Object.keys(body).filter((k) => !virtualFields.includes(k) && k !== 'id');

  router.get('/', validate({ query: listQuery(sortable, filters) }), async (req, res) => {
    const { q, page, limit, sort, order, ...rest } = req.valid.query;
    const where = [];
    const params = [];
    if (q) {
      params.push(`%${q}%`);
      where.push(`(${searchable.map((c) => `t.${c}::text ILIKE $${params.length}`).join(' OR ')})`);
    }
    for (const f of filters) {
      if (rest[f] == null) continue;
      params.push(rest[f]);
      where.push(`t.${camelToSnake(f)}::text = $${params.length}`);
    }
    params.push(limit, (page - 1) * limit);
    // Column names come from the zod enum above, never from raw user input.
    const sql = `${select} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY t.${camelToSnake(sort)} ${order === 'desc' ? 'DESC' : 'ASC'}, t.id
      LIMIT $${params.length - 1} OFFSET $${params.length}`;
    const { rows } = await query(sql, params);
    const total = rows[0]?.total_count ?? (page > 1 ? (await query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n : 0);
    res.json({ items: rows.map(toApi), total, page, limit, pages: Math.ceil(total / limit) });
  });

  router.get('/:id', validate({ params: idParam }), async (req, res) => {
    const { rows } = await query(`${select} WHERE t.id = $1`, [req.valid.params.id]);
    if (!rows[0]) throw notFound(entity);
    res.json(toApi(rows[0]));
  });

  router.post('/', canEdit, validate({ body: createSchema }), async (req, res) => {
    const body = req.valid.body;
    const id = body.id || newId(idPrefix);
    const cols = columnsOf(body);
    await transaction(async (client) => {
      await client.query(
        `INSERT INTO ${table} (id, ${cols.map(camelToSnake).join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})`,
        [id, ...cols.map((c) => body[c])],
      );
      await afterWrite?.(client, id, body);
    });
    await cacheDel('stats');
    audit(req.user, 'create', entity, id, body);
    const { rows } = await query(`${select} WHERE t.id = $1`, [id]);
    res.status(201).json(toApi(rows[0]));
  });

  router.patch('/:id', canEdit, validate({ params: idParam, body: schema.partial() }), async (req, res) => {
    const { id } = req.valid.params;
    const body = req.valid.body;
    const cols = columnsOf(body);
    await transaction(async (client) => {
      if (cols.length) {
        const r = await client.query(
          `UPDATE ${table} SET ${cols.map((c, i) => `${camelToSnake(c)} = $${i + 2}`).join(', ')} WHERE id = $1`,
          [id, ...cols.map((c) => body[c])],
        );
        if (!r.rowCount) throw notFound(entity);
      } else {
        const r = await client.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
        if (!r.rowCount) throw notFound(entity);
      }
      await afterWrite?.(client, id, body);
    });
    audit(req.user, 'update', entity, id, body);
    const { rows } = await query(`${select} WHERE t.id = $1`, [id]);
    res.json(toApi(rows[0]));
  });

  router.delete('/:id', canEdit, validate({ params: idParam }), async (req, res) => {
    const { id } = req.valid.params;
    const r = await query(`DELETE FROM ${table} WHERE id = $1`, [id]);
    if (!r.rowCount) throw notFound(entity);
    await cacheDel('stats');
    audit(req.user, 'delete', entity, id);
    res.status(204).end();
  });

  return router;
}
