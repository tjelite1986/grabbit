#!/usr/bin/env node
'use strict';
// Admin CLI for the GDA client registry (DATA_DIR/gda-clients.json).
// Run inside the container so it writes the same file the server reads:
//
//   docker exec -it grabbit node gda-admin.js list
//   docker exec -it grabbit node gda-admin.js add <id> --audience general \
//       --targets legacy.tikshortis --ops job,status --main legacy.tikshortis --name "My app"
//   docker exec -it grabbit node gda-admin.js password <id>      # prints a new password once
//   docker exec -it grabbit node gda-admin.js token <id>         # prints a new bearer token once
//   docker exec -it grabbit node gda-admin.js revoke-token <id> <tokenId>
//   docker exec -it grabbit node gda-admin.js revoke <id>
//   docker exec -it grabbit node gda-admin.js targets
//
// The server picks up changes on its next request (it re-reads the file when
// its mtime changes); no restart is needed.

const path = require('path');
const gda = require('./gda');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const registry = gda.createRegistry({
  file: path.join(DATA_DIR, 'gda-clients.json'),
  sessionSecret: 'unused-by-the-cli',
});

function flags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) out[a.slice(2)] = args[++i];
    else out._.push(a);
  }
  return out;
}

const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

function main(argv) {
  const [cmd, ...rest] = argv;
  const f = flags(rest);
  const id = f._[0];
  switch (cmd) {
    case 'list':
      console.log(JSON.stringify(registry.list(), null, 2));
      return 0;
    case 'targets':
      for (const [tid, t] of Object.entries(gda.TARGETS)) console.log(`${tid}\t${t.audience}\t${t.label}`);
      return 0;
    case 'add': {
      if (!id) throw new Error('usage: add <id> --audience general|adult --targets a,b [--ops job,status] [--main t] [--name n] [--package p]');
      const c = registry.upsertClient({
        client_id: id,
        display_name: f.name || id,
        package: f.package || null,
        audience: f.audience,
        allowed_targets: list(f.targets),
        allowed_ops: list(f.ops || 'job,status'),
        legacy_main_target: f.main || null,
      });
      console.log(`client ${c.client_id} saved (${c.audience}: ${c.allowed_targets.join(', ')})`);
      return 0;
    }
    case 'password': {
      if (!id) throw new Error('usage: password <id>');
      const pw = registry.setPassword(id);
      console.log(`new password for ${id} (shown once, sessions made with the old one are ended):\n${pw}`);
      return 0;
    }
    case 'token': {
      if (!id) throw new Error('usage: token <id>');
      const t = registry.issueToken(id);
      console.log(`token ${t.id} for ${id} (shown once):\n${t.token}`);
      return 0;
    }
    case 'revoke-token':
      registry.revokeToken(id, f._[1]);
      console.log(`token ${f._[1]} of ${id} revoked`);
      return 0;
    case 'revoke':
      registry.revokeClient(id);
      console.log(`client ${id} revoked`);
      return 0;
    default:
      console.error('commands: list | targets | add | password | token | revoke-token | revoke');
      return 2;
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error(`gda-admin: ${e.message}`);
  process.exitCode = 1;
}
