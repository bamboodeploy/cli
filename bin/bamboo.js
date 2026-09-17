#!/usr/bin/env node
'use strict';
const { BambooClient, BambooError, signFile, scanFile } = require('../lib/api');
const pkg = require('../package.json');

const HELP = `bamboo ${pkg.version}  Scan and code-sign Windows binaries via Bamboo Deploy

Usage:
  bamboo sign <file> [--out <path>] [--timeout 900] [--interval 10]
  bamboo scan <file> [--json] [--fail-on-findings]
  bamboo status [app-id]
  bamboo delete <app-id>
  bamboo config

Options:
  --api-key <key>   API key (else BAMBOO_API_KEY env or .bamboorc)
  --out <path>      Where to write the signed file (default: replace input)
  --timeout <s>     Max seconds to wait for signing (default 900)
  --interval <s>    Poll interval in seconds (default 10)
  --json            Machine-readable output
  --quiet           No progress output

Exit codes: 0 ok, 1 error, 2 premium required, 3 verification required, 4 timeout or pending review, 5 scan findings`;

function parse(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (['out', 'timeout', 'interval', 'limit', 'api-key', 'api-base'].includes(k)) opts[k] = argv[++i];
      else opts[k] = true;
    } else opts._.push(a);
  }
  return opts;
}

const opts = parse(process.argv.slice(2));
const cmd = opts._[0];
const log = opts.quiet || opts.json ? () => {} : m => console.error(m);
const common = { apiKey: opts['api-key'], apiBase: opts['api-base'], log, timeout: opts.timeout && +opts.timeout, interval: opts.interval && +opts.interval };

function fail(e) {
  const map = { premium_required: 2, connections_required: 3, timeout: 4, sign_denied: 1, sign_failed: 1, no_key: 1, unauthorized: 1 };
  const code = map[e.code] ?? 1;
  if (e.code === 'ENOENT') e.message = `File not found: ${e.path}`;
  if (opts.json) console.log(JSON.stringify({ ok: false, error: e.code || 'error', message: e.message, ...(e.body || {}) }));
  else {
    console.error(`Error: ${e.message}`);
    if (e.code === 'premium_required') console.error(`Upgrade at ${e.body?.upgrade_url || 'https://www.bamboodeploy.com/dashboard/#billing'}`);
    if (e.code === 'connections_required') console.error('Verify your publisher connections at https://www.bamboodeploy.com/dashboard/');
    if (e.code === 'timeout' && e.body?.sign?.pending_reason === 'operator_review')
      console.error('The job is waiting for operator review. Re-run once approved, or ask Bamboo to enable Auto-sign on your account so clean builds sign without review.');
  }
  process.exit(code);
}

(async () => {
  if (!cmd || opts.help || cmd === 'help') { console.log(HELP); return; }
  if (cmd === 'sign') {
    const file = opts._[1];
    if (!file) throw new BambooError('Usage: bamboo sign <file>', 'usage');
    const r = await signFile(file, { ...common, out: opts.out });
    if (opts.json) console.log(JSON.stringify({ ok: true, app_id: r.appId, job_id: r.jobId, out: r.out, size: r.size }));
    else console.log(`Signed: ${r.out}`);
    return;
  }
  if (cmd === 'scan') {
    const file = opts._[1];
    if (!file) throw new BambooError('Usage: bamboo scan <file>', 'usage');
    const r = await scanFile(file, common);
    const s = r.summary || {};
    const installer = /NSIS|Inno|MSI|Installer|\.NET|dotnet|Electron|Squirrel|WiX/i;
    const findings = !!(s.yara_matches || (s.packer && !installer.test(s.packer)));
    if (opts.json) console.log(JSON.stringify({ ok: true, app_id: r.appId, findings, summary: s, report: r.report }));
    else {
      console.log(r.report.trim());
      console.log('');
      console.log(`Code signing: ${s.code_signing || 'unknown'}${s.packer ? '\nPacker: ' + s.packer : ''}${s.yara_matches ? '\nYARA: ' + s.yara_matches : ''}`);
      console.log(`Full report: https://www.bamboodeploy.com/dashboard/#apps`);
      if (/not signed/i.test(s.code_signing || '')) console.log('This build is unsigned, so Windows SmartScreen will warn users. Sign it with: bamboo sign <file>');
    }
    if (findings && opts['fail-on-findings']) process.exit(5);
    return;
  }
  if (cmd === 'status') {
    const c = new BambooClient(common);
    const id = opts._[1];
    const out = id ? await c.status(id) : await c.list(+opts.limit || 20);
    if (opts.json || id) console.log(JSON.stringify(out, null, 2));
    else for (const u of out.uploads) console.log(`${u.id}  ${u.file_name.padEnd(32)}  scan:${u.scan.status.padEnd(7)} sign:${u.sign.status}`);
    return;
  }
  if (cmd === 'delete') {
    const c = new BambooClient(common);
    if (!opts._[1]) throw new BambooError('Usage: bamboo delete <app-id>', 'usage');
    await c.remove(opts._[1]);
    console.log('Deleted');
    return;
  }
  if (cmd === 'config') {
    const { resolveKey, DEFAULT_BASE } = require('../lib/api');
    const k = resolveKey(opts['api-key']);
    console.log(`API base: ${opts['api-base'] || process.env.BAMBOO_API_BASE || DEFAULT_BASE}`);
    console.log(`API key:  ${k ? k.slice(0, 12) + '...' + k.slice(-4) : '(none) set BAMBOO_API_KEY or create .bamboorc'}`);
    return;
  }
  throw new BambooError(`Unknown command: ${cmd}\n\n${HELP}`, 'usage');
})().catch(fail);
