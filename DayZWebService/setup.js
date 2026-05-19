#!/usr/bin/env node
// setup.js — one-time config bootstrap for DayZWebService
// Creates config.json from sample-config.json with a freshly generated ServerAuth.

const { existsSync, readFileSync, writeFileSync } = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const SAMPLE_PATH = path.join(__dirname, 'sample-config.json');

if (existsSync(CONFIG_PATH)) {
  console.log('config.json already exists — skipping setup. Delete it first to re-run.');
  process.exit(0);
}

const config = JSON.parse(readFileSync(SAMPLE_PATH, 'utf8'));

// Generate a unique ServerAuth token (same character set used by the app)
const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-.!~';
let token = '';
for (let i = 0; i < 48; i++) {
  token += chars.charAt(Math.floor(Math.random() * chars.length));
}
config.ServerAuth = token;

writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 4));

console.log('config.json created successfully.\n');
console.log('  ServerAuth : ' + config.ServerAuth);
console.log('  Port       : ' + config.Port);
console.log('  DBType     : ' + config.DBType);
console.log('  DBServer   : ' + config.DBServer);
console.log('\nEdit config.json before starting the server.');
console.log('Note: Port 443 requires elevated privileges on Linux — change it to e.g. 8443 for local use.');
