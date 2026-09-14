'use strict';

/**
 * 本地鉴权：只校验本机 token（每次启动随机生成，写在 ~/.workgremlin/server.json）。
 * 目的不是防攻击，而是防止同机其他进程伪造上报 / 订阅。
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
