'use strict';
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const DEFAULT_BASE = 'https://api.bamboodeploy.com';
const DIRECT_MAX = 95 * 1024 * 1024;

class BambooError extends Error {
  constructor(message, code, status, body) {
    super(message);
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

function resolveKey(explicit) {
  if (explicit) return explicit;
  if (process.env.BAMBOO_API_KEY) return process.env.BAMBOO_API_KEY;
  for (const dir of [process.cwd(), require('os').homedir()]) {
    const f = path.join(dir, '.bamboorc');
    try {
      const raw = fs.readFileSync(f);
      const text = raw[0] === 0xff && raw[1] === 0xfe ? raw.toString('utf16le') : raw.toString('utf8');
      const m = text.replace(/^﻿/, '').match(/^\s*(?:BAMBOO_API_KEY\s*=\s*)?(bd_live_[0-9a-f]+)\s*$/mi);
      if (m) return m[1];
    } catch {}
  }
  return null;
}

class BambooClient {
  constructor({ apiKey, apiBase, log } = {}) {
    this.apiKey = resolveKey(apiKey);
    if (!this.apiKey) throw new BambooError('No API key. Set BAMBOO_API_KEY, pass --api-key, or put the key in .bamboorc', 'no_key');
    this.base = (apiBase || process.env.BAMBOO_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');
    this.log = log || (() => {});
  }

  async req(method, p, init = {}) {
    const res = await fetch(this.base + p, {
      ...init,
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, ...(init.headers || {}) },
    });
    if (init.raw) return res;
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { error: text.slice(0, 300) }; }
    if (!res.ok) {
      const code = body.error === 'premium_required' ? 'premium_required'
        : body.error === 'connections_required' ? 'connections_required'
        : res.status === 401 ? 'unauthorized' : 'http_error';
      throw new BambooError(body.message || body.error || `HTTP ${res.status}`, code, res.status, body);
    }
    return body;
  }

  async upload(file) {
    const st = fs.statSync(file);
    const name = encodeURIComponent(path.basename(file));
    this.log(`Uploading ${path.basename(file)} (${fmtBytes(st.size)})`);
    if (st.size > DIRECT_MAX) {
      const init = await this.req('POST', `/uploads/init?name=${name}&size=${st.size}`);
      const put = await fetch(init.upload_url, {
        method: 'PUT',
        body: Readable.toWeb(fs.createReadStream(file)),
        duplex: 'half',
        headers: { 'Content-Length': String(st.size) },
      });
      if (!put.ok) throw new BambooError(`Upload failed: HTTP ${put.status}`, 'http_error', put.status);
      return this.req('POST', `/uploads/${init.id}/finalize?name=${name}`);
    }
    return this.req('POST', `/uploads?name=${name}`, {
      body: Readable.toWeb(fs.createReadStream(file)),
      duplex: 'half',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(st.size) },
    });
  }

  status(id) { return this.req('GET', `/uploads/${id}`); }
  list(limit = 20) { return this.req('GET', `/uploads?limit=${limit}`); }
  requestSign(id) { return this.req('POST', `/uploads/${id}/sign`); }
  remove(id) { return this.req('DELETE', `/uploads/${id}`); }

  async report(id, { timeout = 600, interval = 5 } = {}) {
    const deadline = Date.now() + timeout * 1000;
    for (;;) {
      const res = await this.req('GET', `/uploads/${id}/report`, { raw: true });
      if (res.ok) return res.text();
      if (res.status !== 409) throw new BambooError(`HTTP ${res.status}`, 'http_error', res.status);
      if (Date.now() > deadline) throw new BambooError('Scan did not finish in time', 'timeout');
      await sleep(interval * 1000);
    }
  }

  async waitForSign(id, { timeout = 900, interval = 10 } = {}) {
    const deadline = Date.now() + timeout * 1000;
    let last = null;
    for (;;) {
      const s = await this.status(id);
      const st = s.sign?.status || 'none';
      if (st !== last) {
        last = st;
        const why = st === 'pending' ? (s.sign.pending_reason === 'operator_review' ? ' (awaiting operator review)' : ' (awaiting scan results)') : '';
        this.log(`Sign status: ${st}${why}`);
      }
      if (st === 'done') return s;
      if (st === 'failed' || st === 'denied' || st === 'canceled') {
        throw new BambooError(`Sign ${st}${s.sign.error ? ': ' + s.sign.error : ''}`, 'sign_' + st, 200, s);
      }
      if (Date.now() > deadline) throw new BambooError(`Sign did not complete within ${timeout}s (last status: ${st})`, 'timeout', 200, s);
      await sleep(interval * 1000);
    }
  }

  async download(id, dest, variant = 'signed') {
    const res = await this.req('GET', `/uploads/${id}/download?variant=${variant}`, { raw: true });
    if (!res.ok) throw new BambooError(`Download failed: HTTP ${res.status}`, 'http_error', res.status);
    fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true });
    const tmp = dest + '.bamboo-tmp';
    await new Promise((ok, fail) => {
      const w = fs.createWriteStream(tmp);
      Readable.fromWeb(res.body).pipe(w).on('finish', ok).on('error', fail);
    });
    fs.renameSync(tmp, dest);
    return fs.statSync(dest).size;
  }
}

async function signFile(file, { out, apiKey, apiBase, timeout, interval, log } = {}) {
  const c = new BambooClient({ apiKey, apiBase, log });
  const up = await c.upload(file);
  c.log(`App id: ${up.id}${up.duplicate ? ' (already uploaded)' : ''}`);
  const sign = await c.requestSign(up.id);
  c.log(`Sign job ${sign.job_id}: ${sign.status}`);
  await c.waitForSign(up.id, { timeout, interval });
  const dest = out || file;
  const size = await c.download(up.id, dest);
  c.log(`Wrote ${dest} (${fmtBytes(size)})`);
  return { appId: up.id, jobId: sign.job_id, out: dest, size };
}

async function scanFile(file, { apiKey, apiBase, timeout, log } = {}) {
  const c = new BambooClient({ apiKey, apiBase, log });
  const up = await c.upload(file);
  const text = await c.report(up.id, { timeout });
  const s = await c.status(up.id);
  return { appId: up.id, report: text, summary: s.scan };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmtBytes = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(0) + ' KB' : n + ' B';

module.exports = { BambooClient, BambooError, signFile, scanFile, resolveKey, DEFAULT_BASE };
