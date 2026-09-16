'use strict';

/** 只读查询接口。WS 断线时前端降级轮询 /api/v1/snapshot 也会走这里。 */

const express = require('express');
const { DEFAULTS } = require('@workgremlin/shared');

/**
 * @param {{bus: any, repo: any}} ctx
 */
function createQueryRouter({ bus, repo }) {
  const router = express.Router();

  router.get('/teams', (req, res) => {
    res.json({ ok: true, teams: bus.listTeamSummaries() });
  });

  router.get('/snapshot', (req, res) => {
    res.json({ ok: true, snapshot: bus.buildSnapshot(req.query.team || null) });
  });

  router.get('/messages', (req, res) => {
    const team = req.query.team;
    if (!team) return res.status(400).json({ ok: false, error: { code: 'bad_payload', message: 'missing team' } });
    const q = req.query;
    const items = repo
      .listMessages(team, {
        members: q.members ? String(q.members).split(',').filter(Boolean) : undefined,
        types: q.types ? String(q.types).split(',').filter(Boolean) : undefined,
        since: q.since ? Number(q.since) : undefined,
        until: q.until ? Number(q.until) : undefined,
        keyword: q.keyword ? String(q.keyword) : undefined,
        beforeId: q.beforeId ? Number(q.beforeId) : undefined,
        limit: q.limit ? Number(q.limit) : DEFAULTS.MESSAGE_WINDOW,
        direction: q.direction === 'asc' ? 'asc' : 'desc',
      })
      .map(bus.toMessage);
    return res.json({ ok: true, items, hasMore: items.length >= (Number(q.limit) || DEFAULTS.MESSAGE_WINDOW) });
  });

  return router;
}

module.exports = { createQueryRouter };
