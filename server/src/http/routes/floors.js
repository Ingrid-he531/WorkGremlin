'use strict';

const express = require('express');

/** Floors (monitored products) with their install locations / on-disk info. ?refresh=1 forces a rescan */
function createProductsRouter() {
  const router = express.Router();
  router.get('/products', (req, res) => {
    const { detectProducts } = require('../../floors');
    res.json({ ok: true, products: detectProducts({ force: req.query.refresh === '1' }) });
  });
  return router;
}

module.exports = { createProductsRouter };
