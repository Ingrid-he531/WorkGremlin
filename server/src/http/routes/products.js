'use strict';

const express = require('express');

/** 楼层（受监控产品）及其安装位置 / 落盘信息。?refresh=1 强制重新扫盘 */
function createProductsRouter() {
  const router = express.Router();
  router.get('/products', (req, res) => {
    const { detectProducts } = require('../../products');
    res.json({ ok: true, products: detectProducts({ force: req.query.refresh === '1' }) });
  });
  return router;
}

module.exports = { createProductsRouter };
