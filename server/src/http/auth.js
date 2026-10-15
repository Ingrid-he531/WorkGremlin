'use strict';

/**
 * Local authentication: only validates the local machine token (randomly generated on every
 * start and written to ~/.workgremlin/server.json).
 * The goal is not to defend against attacks, but to stop other processes on the same machine
 * from forging reports / subscriptions.
 */

const { ERROR_CODES } = require('@workgremlin/shared');

/**
 * @param {string|null} token
 * @returns {import('express').RequestHandler}
 */
function requireToken(token) {
  return (req, res, next) => {
    if (!token) return next();
    const header = req.get('authorization') || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
    const provided = bearer || (req.query && req.query.token) || '';
    if (provided !== token) {
      return res.status(401).json({ ok: false, error: { code: ERROR_CODES.BAD_TOKEN, message: 'bad token' } });
    }
    return next();
  };
}

module.exports = { requireToken };
