'use strict';

const express = require('express');

/** 楼层（受监控产品）及其安装状态 */
function createProductsRouter() {
  const router = express.Router();
  router.get('/products', (_req, res) => {
    res.json({ ok: true, products: require('../../products').detectProducts() });
  });
  return router;
}

module.exports = { createProductsRouter };
