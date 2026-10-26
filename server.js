const express = require('express');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const MONGO_URL = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017';

const RESERVED = new Set(['create', 'refresh', 'alias', 'remove']);

let links; 

function normalizeUrl(input) {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw || /\s/.test(raw)) return null;

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  const candidate = hasScheme ? raw : 'https://' + raw;

  let u;
  try {
    u = new URL(candidate);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  const host = u.hostname;
  const isDomain = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(host);
  const isIPv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(host) &&
    host.split('.').every(n => Number(n) <= 255);
  if (!isDomain && !isIPv4) return null; 

  return u.href;
}

function generateCode() {
  return crypto.randomBytes(6).toString('base64url');
}

const toShortUrl = code => `${BASE_URL}/${code}`;
const isDuplicateKey = err => err && err.code === 11000;

const reply = (res, body) => res.json(body);

async function insertNew(original) {
  for (let i = 0; i < 5; i++) {
    const code = generateCode();
    if (RESERVED.has(code)) continue;
    try {
      await links.insertOne({ original, shorts: [code], createdAt: new Date() });
      return code;
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      const existing = await links.findOne({ original });
      if (existing) return null;
    }
  }
  throw new Error('Не удалось сгенерировать уникальный код');
}

const app = express();

app.get('/create', async (req, res) => {
  const original = req.query.url;
  try {
    const norm = normalizeUrl(original);
    if (!norm) return reply(res, { original, created: false });

    const existing = await links.findOne({ original: norm });
    if (existing) {
      return reply(res, { original, short: toShortUrl(existing.shorts[0]), created: null });
    }

    const code = await insertNew(norm);
    if (code === null) {
      const again = await links.findOne({ original: norm });
      return reply(res, { original, short: toShortUrl(again.shorts[0]), created: null });
    }
    reply(res, { original, short: toShortUrl(code), created: true });
  } catch (err) {
    console.error(err);
    reply(res, { original, created: false });
  }
});

app.get('/refresh', async (req, res) => {
  const original = req.query.url;
  try {
    const norm = normalizeUrl(original);
    if (!norm) return reply(res, { original, refresh: false });

    const existing = await links.findOne({ original: norm });
    if (!existing) return reply(res, { original, refresh: null });

    for (let i = 0; i < 5; i++) {
      const code = generateCode();
      if (RESERVED.has(code)) continue;
      try {
        await links.updateOne({ original: norm }, { $set: { 'shorts.0': code } });
        return reply(res, { original, short: toShortUrl(code), refresh: true });
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
      }
    }
    reply(res, { original, refresh: false });
  } catch (err) {
    console.error(err);
    reply(res, { original, refresh: false });
  }
});

app.get('/alias', async (req, res) => {
  const original = req.query.url;
  try {
    const norm = normalizeUrl(original);
    if (!norm) return reply(res, { original, alias: false });

    const existing = await links.findOne({ original: norm });
    if (!existing) {
      const code = await insertNew(norm);
      if (code === null) {
        const again = await links.findOne({ original: norm });
        return reply(res, { original, short: toShortUrl(again.shorts[0]), created: null });
      }
      return reply(res, { original, short: toShortUrl(code), created: true });
    }

    for (let i = 0; i < 5; i++) {
      const code = generateCode();
      if (RESERVED.has(code)) continue;
      try {
        await links.updateOne({ original: norm }, { $push: { shorts: code } });
        return reply(res, { original, short: toShortUrl(code), alias: true });
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
      }
    }
    reply(res, { original, alias: false });
  } catch (err) {
    console.error(err);
    reply(res, { original, alias: false });
  }
});

app.get('/remove', async (req, res) => {
  const original = req.query.url;
  try {
    const norm = normalizeUrl(original);
    if (!norm) return reply(res, { original, deleted: false });

    const result = await links.deleteOne({ original: norm });
    if (result.deletedCount === 0) return reply(res, { original, deleted: null });
    reply(res, { original, deleted: true });
  } catch (err) {
    console.error(err);
    reply(res, { original, deleted: false });
  }
});

app.get('/:code', async (req, res) => {
  try {
    const doc = await links.findOne({ shorts: req.params.code });
    if (!doc) return res.status(404).send('Not found');
    res.redirect(302, doc.original);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

const { MongoMemoryServer } = require('mongodb-memory-server');
const fs = require('fs');

(async () => {
  let url = process.env.MONGO_URL;

  if (!url) {
    fs.mkdirSync('./data', { recursive: true });
    const mongod = await MongoMemoryServer.create({
      instance: { dbPath: './data', storageEngine: 'wiredTiger' }
    });
    url = mongod.getUri();
    console.log('Встроенная MongoDB:', url);
  }

  const client = new MongoClient(url);
  await client.connect();
  links = client.db('shortener').collection('links');

  await links.createIndex({ original: 1 }, { unique: true });
  await links.createIndex({ shorts: 1 }, { unique: true });

  app.listen(PORT, () => console.log(`Сервис запущен: ${BASE_URL}`));
})().catch(err => {
  console.error('Ошибка запуска:', err);
  process.exit(1);
});