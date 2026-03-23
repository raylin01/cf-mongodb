const express = require('express');
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const app = express();
app.use(express.json());

// --- Inline basic-auth (no external dependency) ---
function parseBasicAuth(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice(6), 'base64').toString();
  const idx = decoded.indexOf(':');
  if (idx === -1) return null;
  return { name: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
}

// --- Config ---
const MONGO_HOST = process.env.MONGO_HOST || 'mongodb';
const MONGO_PORT = process.env.MONGO_PORT || '27017';
const MONGO_USER = process.env.MONGO_ROOT_USER;
const MONGO_PASS = process.env.MONGO_ROOT_PASSWORD;
const AUTH_USER = process.env.DASHBOARD_USER || process.env.MONGOEXPRESS_USER || 'admin';
const AUTH_PASS = process.env.DASHBOARD_PASSWORD || process.env.MONGOEXPRESS_PASSWORD || 'admin';
const CF_CONFIG_PATH = process.env.CF_CONFIG_PATH || '/app/.cloudflare.json';
const DATA_DIR = process.env.DATA_DIR || '/app/data';
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

let mongoClient;

async function getMongo() {
  if (!mongoClient) {
    const uri = `mongodb://${encodeURIComponent(MONGO_USER)}:${encodeURIComponent(MONGO_PASS)}@${MONGO_HOST}:${MONGO_PORT}/admin?authSource=admin`;
    mongoClient = new MongoClient(uri);
    await mongoClient.connect();
  }
  return mongoClient;
}

// --- Auth middleware ---
function authMiddleware(req, res, next) {
  const user = parseBasicAuth(req);
  if (!user || user.name !== AUTH_USER || user.pass !== AUTH_PASS) {
    res.setHeader('WWW-Authenticate', 'Basic realm="cf-mongodb"');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}
app.use(authMiddleware);

// --- Cloudflare helpers ---
function getCfConfig() {
  try {
    return JSON.parse(fs.readFileSync(CF_CONFIG_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function saveCfConfig(config) {
  fs.writeFileSync(CF_CONFIG_PATH, JSON.stringify(config, null, 2));
}

async function cfApi(method, path, body) {
  const config = getCfConfig();
  if (!config) throw new Error('Cloudflare not configured');
  const url = `https://api.cloudflare.com/client/v4/${path}`
    .replace('{account_id}', config.account_id)
    .replace('{zone_id}', config.zone_id)
    .replace('{tunnel_id}', config.tunnel_id);
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${config.token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const json = await res.json();
  if (!json.success) {
    const msg = json.errors?.map(e => e.message).join(', ') || 'Unknown error';
    throw new Error(msg);
  }
  return json.result;
}

function cfHostname(dbName) {
  const c = getCfConfig();
  return `${c.db_prefix}-${dbName}.${c.domain}`;
}

// --- MongoDB API ---

app.get('/api/status', async (req, res) => {
  try {
    const mongo = await getMongo();
    const adminDb = mongo.db('admin');
    const ping = await adminDb.command({ ping: 1 });
    const buildInfo = await adminDb.command({ buildInfo: 1 });
    const serverStatus = await adminDb.command({ serverStatus: 1 });
    const dbList = await adminDb.command({ listDatabases: 1 });
    const userDbs = dbList.databases.filter(d => !['admin', 'config', 'local'].includes(d.name));

    const cfConfig = getCfConfig();
    res.json({
      ok: ping.ok === 1,
      version: buildInfo.version,
      uptime: serverStatus.uptime,
      totalDatabases: userDbs.length,
      totalSize: dbList.totalSize,
      cloudflare: cfConfig ? { domain: cfConfig.domain, tunnel: cfConfig.tunnel_name } : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/databases', async (req, res) => {
  try {
    const mongo = await getMongo();
    const adminDb = mongo.db('admin');
    const dbList = await adminDb.command({ listDatabases: 1 });
    const cfConfig = getCfConfig();

    const databases = await Promise.all(
      dbList.databases
        .filter(d => !['admin', 'config', 'local'].includes(d.name))
        .map(async (d) => {
          const db = mongo.db(d.name);
          let users = [];
          let collections = [];
          try {
            const usersResult = await db.command({ usersInfo: 1 });
            users = (usersResult.users || []).map(u => ({
              user: u.user,
              roles: u.roles.map(r => r.role),
            }));
            collections = await db.listCollections().toArray();
          } catch {}
          const hostname = cfConfig ? cfHostname(d.name) : null;
          return {
            name: d.name,
            sizeOnDisk: d.sizeOnDisk,
            empty: d.empty,
            users,
            collections: collections.map(c => c.name),
            remoteHostname: hostname,
          };
        })
    );
    res.json({ databases });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/databases', async (req, res) => {
  try {
    const { name, username, password, enableRemote, ips } = req.body;
    if (!name || !username || !password) {
      return res.status(400).json({ error: 'name, username, and password are required' });
    }

    const mongo = await getMongo();
    const db = mongo.db(name);
    await db.command({
      createUser: username,
      pwd: password,
      roles: [
        { role: 'readWrite', db: name },
        { role: 'dbAdmin', db: name },
      ],
    });

    let remoteResult = null;
    if (enableRemote) {
      const cfConfig = getCfConfig();
      if (!cfConfig) {
        return res.status(400).json({ error: 'Cloudflare not configured' });
      }
      const hostname = cfHostname(name);

      // DNS CNAME
      await cfApi('POST', 'zones/{zone_id}/dns_records', {
        type: 'CNAME',
        name: hostname,
        content: `${cfConfig.tunnel_id}.cfargotunnel.com`,
        proxied: true,
      });

      // Tunnel route
      await cfApi('POST', 'accounts/{account_id}/cfd_tunnel/{tunnel_id}/public_hostnames', {
        hostname,
        service: 'mongodb://127.0.0.1:27017',
        originRequest: { noTLSVerify: true, connectTimeout: 30 },
      });

      // Access policy
      const ipList = (ips || cfConfig.default_ips || '').split(',').map(s => s.trim()).filter(Boolean);
      if (ipList.length > 0) {
        const include = ipList.map(ip => ({
          ip: { ip: ip.includes('/') ? ip : `${ip}/32` },
        }));
        await cfApi('POST', 'accounts/{account_id}/access/policies', {
          name: `MongoDB - ${hostname}`,
          decision: 'allow',
          include,
        });
      }

      remoteResult = { hostname, ips: ipList };
    }

    res.json({
      ok: true,
      database: name,
      username,
      connectionStrings: {
        local: `mongodb://${username}:${password}@127.0.0.1:27017/${name}`,
        remote: enableRemote ? `mongodb://${username}:${password}@${cfHostname(name)}:27017/${name}?tls=true&directConnection=true` : null,
      },
      remote: remoteResult,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/databases/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const { removeCloudflare } = req.body || {};
    const mongo = await getMongo();
    const db = mongo.db(name);

    await db.dropDatabase();
    try { await db.command({ dropAllUsersFromDatabase: 1 }); } catch {}

    let cfCleanup = null;
    if (removeCloudflare) {
      const cfConfig = getCfConfig();
      if (cfConfig) {
        const hostname = cfHostname(name);
        // Remove tunnel route
        try {
          const hostnames = await cfApi('GET', 'accounts/{account_id}/cfd_tunnel/{tunnel_id}/public_hostnames');
          const match = hostnames.find(h => h.hostname === hostname);
          if (match) {
            await cfApi('DELETE', `accounts/{account_id}/cfd_tunnel/{tunnel_id}/public_hostnames/${match.id}`);
          }
        } catch {}
        // Remove DNS record
        try {
          const records = await cfApi('GET', `zones/{zone_id}/dns_records?name=${hostname}`);
          const match = records.find(r => r.name === hostname);
          if (match) {
            await cfApi('DELETE', `zones/{zone_id}/dns_records/${match.id}`);
          }
        } catch {}
        cfCleanup = { hostname, removed: true };
      }
    }

    res.json({ ok: true, database: name, cloudflare: cfCleanup });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/databases/:name/users', async (req, res) => {
  try {
    const mongo = await getMongo();
    const db = mongo.db(req.params.name);
    const result = await db.command({ usersInfo: 1 });
    const users = (result.users || []).map(u => ({
      user: u.user,
      roles: u.roles.map(r => r.role),
    }));
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/databases/:name/users', async (req, res) => {
  try {
    const { username, password, role } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    const mongo = await getMongo();
    const db = mongo.db(req.params.name);
    await db.command({
      createUser: username,
      pwd: password,
      roles: [{ role: role || 'readWrite', db: req.params.name }],
    });
    res.json({ ok: true, user: username, role: role || 'readWrite' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/databases/:name/users/:user/reset-password', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'password required' });
    const mongo = await getMongo();
    const db = mongo.db(req.params.name);
    await db.command({ updateUser: req.params.user, pwd: password });
    res.json({ ok: true, user: req.params.user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/databases/:name/connection', async (req, res) => {
  try {
    const name = req.params.name;
    const mongo = await getMongo();
    const db = mongo.db(name);
    const result = await db.command({ usersInfo: 1 });
    const users = result.users || [];
    if (users.length === 0) return res.json({ connections: [] });

    const cfConfig = getCfConfig();
    const connections = users.map(u => ({
      user: u.user,
      local: `mongodb://${u.user}:<password>@127.0.0.1:27017/${name}`,
      remote: cfConfig ? `mongodb://${u.user}:<password>@${cfHostname(name)}:27017/${name}?tls=true&directConnection=true` : null,
    }));
    res.json({ connections });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/databases/:name/backup', async (req, res) => {
  try {
    const name = req.params.name;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const archive = `${name}_${timestamp}.archive.gz`;
    const archivePath = path.join(BACKUP_DIR, archive);

    // Use docker to run mongodump in the same network
    const uri = `mongodb://${encodeURIComponent(MONGO_USER)}:${encodeURIComponent(MONGO_PASS)}@mongodb:27017/${name}?authSource=admin`;
    execSync(
      `docker run --rm --network mongodb_mongodb-net -v "${BACKUP_DIR}:/backups" mongo:8 mongodump --uri="${uri}" --gzip --archive="/backups/${archive}"`,
      { timeout: 120000 }
    );

    res.download(archivePath, archive);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Cloudflare API ---

app.get('/api/cloudflare/status', async (req, res) => {
  try {
    const cfConfig = getCfConfig();
    if (!cfConfig) return res.json({ configured: false });

    let tunnelHostnames = [];
    try {
      tunnelHostnames = await cfApi('GET', 'accounts/{account_id}/cfd_tunnel/{tunnel_id}/public_hostnames');
    } catch {}

    res.json({
      configured: true,
      domain: cfConfig.domain,
      tunnelName: cfConfig.tunnel_name,
      tunnelId: cfConfig.tunnel_id,
      dbPrefix: cfConfig.db_prefix,
      defaultIps: cfConfig.default_ips || null,
      webSubdomain: cfConfig.web_subdomain || 'mongo-admin',
      tunnelHostnames: tunnelHostnames.map(h => ({
        hostname: h.hostname,
        service: h.service,
        isDb: h.hostname.startsWith(`${cfConfig.db_prefix}-`),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cloudflare/zones', async (req, res) => {
  try {
    const cfConfig = getCfConfig();
    if (!cfConfig) return res.status(400).json({ error: 'No token configured' });
    const zones = await cfApi('GET', 'zones');
    res.json({ zones: zones.map(z => ({ id: z.id, name: z.name })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cloudflare/tunnels', async (req, res) => {
  try {
    const cfConfig = getCfConfig();
    if (!cfConfig) return res.status(400).json({ error: 'No token configured' });
    const tunnels = await cfApi('GET', 'accounts/{account_id}/cfd_tunnel');
    res.json({
      tunnels: tunnels.map(t => ({
        id: t.id,
        name: t.name,
        running: (t.tunnel_conns || []).length > 0,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cloudflare/accounts', async (req, res) => {
  try {
    const cfConfig = getCfConfig();
    if (!cfConfig) return res.status(400).json({ error: 'No token configured' });
    const accounts = await cfApi('GET', 'accounts');
    res.json({ accounts: accounts.map(a => ({ id: a.id, name: a.name })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cloudflare/setup', async (req, res) => {
  try {
    const { token, account_id, zone_id, domain, tunnel_id, tunnel_name, db_prefix, default_ips, web_subdomain } = req.body;

    // Verify token
    const verifyRes = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const verifyJson = await verifyRes.json();
    if (verifyJson.result?.status !== 'active') {
      return res.status(400).json({ error: 'Invalid or expired API token' });
    }

    saveCfConfig({
      token, account_id, zone_id, domain,
      tunnel_id, tunnel_name: tunnel_name || 'mongodb',
      db_prefix: db_prefix || 'db',
      default_ips: default_ips || '',
      web_subdomain: web_subdomain || 'mongo-admin',
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cloudflare/verify-token', async (req, res) => {
  try {
    const { token } = req.body;
    const verifyRes = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const verifyJson = await verifyRes.json();
    res.json({ valid: verifyJson.result?.status === 'active' });
  } catch {
    res.json({ valid: false });
  }
});

// --- Serve frontend ---
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(FRONTEND_HTML);
});

const FRONTEND_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>cf-mongodb</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0a0a;--surface:#141414;--surface2:#1e1e1e;--border:#2a2a2a;--text:#e4e4e4;--text2:#888;--accent:#3b82f6;--accent2:#2563eb;--green:#22c55e;--red:#ef4444;--yellow:#eab308;--radius:8px}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);line-height:1.5}
a{color:var(--accent);text-decoration:none}
button{cursor:pointer;font-family:inherit}
input,select{font-family:inherit;font-size:14px}

/* Layout */
.app{display:flex;height:100vh}
.sidebar{width:220px;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;flex-shrink:0}
.sidebar h1{padding:20px;font-size:15px;font-weight:600;letter-spacing:-0.3px;border-bottom:1px solid var(--border)}
.sidebar h1 span{color:var(--accent)}
.nav{flex:1;padding:12px}
.nav a{display:block;padding:10px 14px;border-radius:var(--radius);color:var(--text2);font-size:13px;margin-bottom:2px;transition:all .15s}
.nav a:hover,.nav a.active{background:var(--surface2);color:var(--text)}
.main{flex:1;overflow-y:auto;padding:32px}

/* Cards */
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px;margin-bottom:16px}
.card-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.card h2{font-size:15px;font-weight:600}
.card h3{font-size:13px;font-weight:500;color:var(--text2);margin-bottom:8px}

/* Status dots */
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:6px}
.dot.green{background:var(--green)}
.dot.red{background:var(--red)}
.dot.yellow{background:var(--yellow)}

/* DB grid */
.db-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}
.db-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px;cursor:pointer;transition:border-color .15s}
.db-card:hover{border-color:var(--accent)}
.db-card .name{font-size:15px;font-weight:600;margin-bottom:4px}
.db-card .meta{font-size:12px;color:var(--text2);display:flex;gap:12px;align-items:center;margin-bottom:8px}
.db-card .conn{font-size:11px;color:var(--text2);font-family:monospace;background:var(--surface2);padding:6px 8px;border-radius:4px;word-break:break-all;margin-top:8px}

/* Forms */
.form-group{margin-bottom:16px}
.form-group label{display:block;font-size:12px;font-weight:500;color:var(--text2);margin-bottom:6px}
.form-group input,.form-group select{width:100%;padding:10px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);outline:none;transition:border-color .15s}
.form-group input:focus,.form-group select:focus{border-color:var(--accent)}
.form-group input::placeholder{color:#555}
.form-row{display:flex;gap:12px}
.form-row .form-group{flex:1}
.toggle-row{display:flex;align-items:center;gap:10px;margin-bottom:16px;font-size:13px}
.toggle-row input[type=checkbox]{width:16px;height:16px;accent-color:var(--accent)}

/* Buttons */
.btn{padding:8px 16px;border-radius:var(--radius);border:none;font-size:13px;font-weight:500;transition:all .15s}
.btn-primary{background:var(--accent);color:#fff}
.btn-primary:hover{background:var(--accent2)}
.btn-danger{background:var(--red);color:#fff}
.btn-danger:hover{background:#dc2626}
.btn-ghost{background:transparent;color:var(--text2);border:1px solid var(--border)}
.btn-ghost:hover{border-color:var(--text2);color:var(--text)}
.btn-sm{padding:5px 10px;font-size:12px}
.btn-row{display:flex;gap:8px;margin-top:16px}

/* Table */
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--border);font-size:13px}
th{color:var(--text2);font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.5px}
td{color:var(--text)}
tr:hover td{background:var(--surface2)}

/* Toast */
.toast{position:fixed;bottom:24px;right:24px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius);padding:12px 20px;font-size:13px;z-index:100;opacity:0;transform:translateY(10px);transition:all .3s;pointer-events:none}
.toast.show{opacity:1;transform:translateY(0)}
.toast.error{border-color:var(--red);color:var(--red)}
.toast.success{border-color:var(--green);color:var(--green)}

/* Modal */
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:50;display:flex;align-items:center;justify-content:center}
.modal{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:24px;width:480px;max-width:90vw;max-height:90vh;overflow-y:auto}
.modal h2{margin-bottom:20px;font-size:16px}

/* Badge */
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:500}
.badge-green{background:rgba(34,197,94,.15);color:var(--green)}
.badge-blue{background:rgba(59,130,246,.15);color:var(--accent)}
.badge-red{background:rgba(239,68,68,.15);color:var(--red)}

/* Responsive */
@media(max-width:768px){
  .sidebar{display:none}
  .main{padding:16px}
  .db-grid{grid-template-columns:1fr}
}
</style>
</head>
<body>
<div class="app">
  <div class="sidebar">
    <h1>cf-<span>mongodb</span></h1>
    <div class="nav">
      <a href="#" onclick="showPage('dashboard')" id="nav-dashboard" class="active">Databases</a>
      <a href="#" onclick="showPage('cloudflare')" id="nav-cloudflare">Cloudflare</a>
    </div>
  </div>
  <div class="main" id="main"></div>
</div>
<div class="toast" id="toast"></div>

<script>
const api = {
  async get(path) {
    const r = await fetch('/api/' + path);
    return r.json();
  },
  async post(path, body) {
    const r = await fetch('/api/' + path, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
    return r.json();
  },
  async del(path, body) {
    const r = await fetch('/api/' + path, { method: 'DELETE', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
    return r.json();
  },
};

function toast(msg, type='') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show ' + type;
  setTimeout(() => el.className = 'toast', 3500);
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(() => toast('Copied to clipboard', 'success'));
}

function genPassword() {
  const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let pw = '';
  for (let i = 0; i < 24; i++) pw += chars[Math.floor(Math.random() * chars.length)];
  return pw;
}

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatUptime(s) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return d + 'd ' + h + 'h';
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}

// --- Pages ---
async function showPage(page) {
  document.querySelectorAll('.nav a').forEach(a => a.classList.remove('active'));
  document.getElementById('nav-' + page)?.classList.add('active');
  if (page === 'dashboard') await renderDashboard();
  else if (page === 'cloudflare') await renderCloudflare();
  else if (page.startsWith('db-')) await renderDbDetail(page.slice(3));
}

async function renderDashboard() {
  const [status, dbs] = await Promise.all([api.get('status'), api.get('databases')]);
  const cfBadge = status.cloudflare
    ? '<span class="badge badge-green">Cloudflare connected</span>'
    : '<span class="badge badge-blue">Local only</span>';

  document.getElementById('main').innerHTML = \`
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px">
      <div>
        <h2 style="font-size:20px;font-weight:600">Databases</h2>
        <p style="color:var(--text2);font-size:13px;margin-top:4px">\${dbs.databases.length} database\${dbs.databases.length !== 1 ? 's' : ''} &middot; \${formatSize(status.totalSize)} total &middot; MongoDB \${status.version} &middot; Uptime \${formatUptime(status.uptime)}</p>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        \${cfBadge}
        <button class="btn btn-primary" onclick="showCreateDbModal()">+ New Database</button>
      </div>
    </div>
    <div class="db-grid">
      \${dbs.databases.length === 0 ? '<div class="card" style="text-align:center;color:var(--text2);grid-column:1/-1;padding:48px"><p>No databases yet</p><p style="font-size:12px;margin-top:4px">Click "New Database" to create one</p></div>' : ''}
      \${dbs.databases.map(db => \`
        <div class="db-card" onclick="showPage('db-\${db.name}')">
          <div class="name">\${db.name}</div>
          <div class="meta">
            <span>\${formatSize(db.sizeOnDisk)}</span>
            <span>\${db.users.length} user\${db.users.length !== 1 ? 's' : ''}</span>
            <span>\${db.collections.length} collection\${db.collections.length !== 1 ? 's' : ''}</span>
            \${db.remoteHostname ? '<span class="dot green"></span>Remote' : ''}
          </div>
          \${db.users.length > 0 ? \`<div class="conn" onclick="event.stopPropagation();copyText('\${db.remoteHostname ? 'mongodb://' + db.users[0].user + ':<password>@' + db.remoteHostname + ':27017/' + db.name + '?tls=true&directConnection=true' : 'mongodb://' + db.users[0].user + ':<password>@127.0.0.1:27017/' + db.name}')">mongodb://\${db.users[0].user}:***@\${db.remoteHostname || '127.0.0.1:27017'}/\${db.name}\${db.remoteHostname ? '?tls=true' : ''}</div>\` : ''}
        </div>
      \`).join('')}
    </div>
  \`;
}

function showCreateDbModal() {
  const pw = genPassword();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'modal';
  overlay.innerHTML = \`
    <div class="modal">
      <h2>Create Database</h2>
      <div class="form-group">
        <label>Database Name</label>
        <input id="db-name" placeholder="myapp" autofocus>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Username</label>
          <input id="db-user" placeholder="myapp_user">
        </div>
        <div class="form-group">
          <label>Password</label>
          <div style="display:flex;gap:6px">
            <input id="db-pass" value="\${pw}" style="flex:1">
            <button class="btn btn-ghost btn-sm" onclick="document.getElementById('db-pass').value=genPassword()">Regenerate</button>
          </div>
        </div>
      </div>
      <div class="toggle-row">
        <input type="checkbox" id="db-remote">
        <label for="db-remote" style="margin:0;cursor:pointer">Enable remote access (Cloudflare)</label>
      </div>
      <div id="remote-opts" style="display:none">
        <div class="form-group">
          <label>Allowed IPs / CIDRs (comma-separated)</label>
          <input id="db-ips" placeholder="1.2.3.4,10.0.0.0/8">
        </div>
        <p style="font-size:11px;color:var(--text2)">Creates DNS record, tunnel route, and IP access policy automatically.</p>
      </div>
      <div class="btn-row">
        <button class="btn btn-primary" onclick="createDb()">Create Database</button>
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      </div>
    </div>
  \`;
  document.body.appendChild(overlay);
  document.getElementById('db-remote').addEventListener('change', e => {
    document.getElementById('remote-opts').style.display = e.target.checked ? 'block' : 'none';
  });
}

function closeModal() {
  document.getElementById('modal')?.remove();
}

async function createDb() {
  const name = document.getElementById('db-name').value.trim();
  const username = document.getElementById('db-user').value.trim();
  const password = document.getElementById('db-pass').value;
  const remote = document.getElementById('db-remote').checked;
  const ips = document.getElementById('db-ips')?.value.trim() || '';
  if (!name || !username || !password) return toast('All fields are required', 'error');
  try {
    const result = await api.post('databases', { name, username, password, enableRemote: remote, ips });
    closeModal();
    toast('Database created: ' + name, 'success');
    if (result.connectionStrings?.remote) {
      setTimeout(() => {
        const conn = result.connectionStrings.remote;
        if (confirm('Remote connection string:\\n\\n' + conn + '\\n\\nCopy to clipboard?')) copyText(conn);
      }, 500);
    }
    showPage('db-' + name);
  } catch (err) {
    toast(err.message || 'Failed to create database', 'error');
  }
}

async function renderDbDetail(dbName) {
  const [db, users, conn] = await Promise.all([
    api.get('databases/' + encodeURIComponent(dbName)),
    api.get('databases/' + encodeURIComponent(dbName) + '/users'),
    api.get('databases/' + encodeURIComponent(dbName) + '/connection'),
  ]);
  document.querySelectorAll('.nav a').forEach(a => a.classList.remove('active'));

  document.getElementById('main').innerHTML = \`
    <div style="margin-bottom:24px">
      <button class="btn btn-ghost btn-sm" onclick="showPage('dashboard')" style="margin-bottom:12px">&larr; Back</button>
      <h2 style="font-size:20px;font-weight:600">\${dbName}</h2>
      <p style="color:var(--text2);font-size:13px;margin-top:4px">\${formatSize(db.sizeOnDisk)} &middot; \${db.collections.length} collection\${db.collections.length !== 1 ? 's' : ''} \${db.remoteHostname ? '&middot; <span class="dot green"></span>' + db.remoteHostname : ''}</p>
    </div>

    <div class="card">
      <div class="card-header"><h2>Connection Strings</h2></div>
      \${conn.connections.map(c => \`
        <div class="form-group">
          <label>\${c.remote ? 'Remote' : 'Local'} — \${c.user}</label>
          <div style="display:flex;gap:6px">
            <input value="\${c.local}" readonly style="flex:1;font-family:monospace;font-size:12px">
            <button class="btn btn-ghost btn-sm" onclick="copyText('\${c.local.replace(/'/g, "\\\\'")}')">Copy</button>
          </div>
          \${c.remote ? \`
          <div style="display:flex;gap:6px;margin-top:6px">
            <input value="\${c.remote}" readonly style="flex:1;font-family:monospace;font-size:12px">
            <button class="btn btn-ghost btn-sm" onclick="copyText('\${c.remote.replace(/'/g, "\\\\'")}')">Copy</button>
          </div>
          \` : ''}
        </div>
      \`).join('')}
    </div>

    <div class="card">
      <div class="card-header">
        <h2>Users (\${users.users.length})</h2>
        <button class="btn btn-ghost btn-sm" onclick="showAddUserModal('\${dbName}')">+ Add User</button>
      </div>
      \${users.users.length === 0 ? '<p style="color:var(--text2);font-size:13px">No users</p>' : ''}
      <table>
        <thead><tr><th>User</th><th>Roles</th><th>Actions</th></tr></thead>
        <tbody>
          \${users.users.map(u => \`
            <tr>
              <td>\${u.user}</td>
              <td>\${u.roles.map(r => '<span class="badge badge-blue">' + r + '</span> ').join('')}</td>
              <td><button class="btn btn-ghost btn-sm" onclick="showResetPwModal('\${dbName}','\${u.user}')">Reset Password</button></td>
            </tr>
          \`).join('')}
        </tbody>
      </table>
    </div>

    <div class="card">
      <div class="card-header"><h2>Collections (\${db.collections.length})</h2></div>
      \${db.collections.length === 0 ? '<p style="color:var(--text2);font-size:13px">No collections yet</p>' : ''}
      <table>
        <thead><tr><th>Name</th></tr></thead>
        <tbody>\${db.collections.map(c => '<tr><td>' + c + '</td></tr>').join('')}</tbody>
      </table>
    </div>

    <div class="card">
      <div class="card-header"><h2>Actions</h2></div>
      <div class="btn-row">
        <button class="btn btn-ghost" onclick="backupDb('\${dbName}')">Backup Database</button>
        <button class="btn btn-danger" onclick="deleteDb('\${dbName}')">Delete Database</button>
      </div>
    </div>
  \`;
}

function showAddUserModal(dbName) {
  const pw = genPassword();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'modal';
  overlay.innerHTML = \`
    <div class="modal">
      <h2>Add User to \${dbName}</h2>
      <div class="form-group"><label>Username</label><input id="new-user"></div>
      <div class="form-group"><label>Password</label>
        <div style="display:flex;gap:6px"><input id="new-pass" value="\${pw}" style="flex:1"><button class="btn btn-ghost btn-sm" onclick="document.getElementById('new-pass').value=genPassword()">Regenerate</button></div>
      </div>
      <div class="form-group"><label>Role</label>
        <select id="new-role"><option value="readWrite">readWrite</option><option value="read">read</option><option value="dbAdmin">dbAdmin</option></select>
      </div>
      <div class="btn-row">
        <button class="btn btn-primary" onclick="addUser('\${dbName}')">Add User</button>
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      </div>
    </div>
  \`;
  document.body.appendChild(overlay);
}

async function addUser(dbName) {
  const username = document.getElementById('new-user').value.trim();
  const password = document.getElementById('new-pass').value;
  const role = document.getElementById('new-role').value;
  if (!username || !password) return toast('All fields required', 'error');
  try {
    await api.post('databases/' + encodeURIComponent(dbName) + '/users', { username, password, role });
    closeModal();
    toast('User added: ' + username, 'success');
    showPage('db-' + dbName);
  } catch (err) { toast(err.message || 'Failed', 'error'); }
}

function showResetPwModal(dbName, username) {
  const pw = genPassword();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'modal';
  overlay.innerHTML = \`
    <div class="modal">
      <h2>Reset Password</h2>
      <p style="color:var(--text2);font-size:13px;margin-bottom:16px">User: <strong>\${username}</strong> on <strong>\${dbName}</strong></p>
      <div class="form-group"><label>New Password</label>
        <div style="display:flex;gap:6px"><input id="reset-pass" value="\${pw}" style="flex:1"><button class="btn btn-ghost btn-sm" onclick="document.getElementById('reset-pass').value=genPassword()">Regenerate</button></div>
      </div>
      <div class="btn-row">
        <button class="btn btn-primary" onclick="resetPw('\${dbName}','\${username}')">Reset Password</button>
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      </div>
    </div>
  \`;
  document.body.appendChild(overlay);
}

async function resetPw(dbName, username) {
  const password = document.getElementById('reset-pass').value;
  if (!password) return toast('Password required', 'error');
  try {
    const result = await api.post('databases/' + encodeURIComponent(dbName) + '/users/' + encodeURIComponent(username) + '/reset-password', { password });
    closeModal();
    toast('Password reset for ' + username, 'success');
  } catch (err) { toast(err.message || 'Failed', 'error'); }
}

async function backupDb(dbName) {
  toast('Starting backup...', 'success');
  try {
    const a = document.createElement('a');
    a.href = '/api/databases/' + encodeURIComponent(dbName) + '/backup';
    a.download = dbName + '_backup.archive.gz';
    a.click();
  } catch (err) { toast('Backup failed: ' + err.message, 'error'); }
}

async function deleteDb(dbName) {
  const cfConfig = await api.get('cloudflare/status');
  const hasRemote = cfConfig.configured;
  const msg = hasRemote
    ? 'Delete database "' + dbName + '" and its Cloudflare routes?'
    : 'Delete database "' + dbName + '"? This cannot be undone.';
  if (!confirm(msg)) return;
  try {
    await api.del('databases/' + encodeURIComponent(dbName), { removeCloudflare: hasRemote });
    toast('Deleted: ' + dbName, 'success');
    showPage('dashboard');
  } catch (err) { toast(err.message || 'Failed', 'error'); }
}

// --- Cloudflare page ---
async function renderCloudflare() {
  const status = await api.get('cloudflare/status');
  document.getElementById('main').innerHTML = \`
    <h2 style="font-size:20px;font-weight:600;margin-bottom:24px">Cloudflare</h2>
    \${status.configured ? renderCfConfigured(status) : renderCfNotConfigured()}
  \`;
}

function renderCfNotConfigured() {
  return \`
    <div class="card" style="text-align:center;padding:48px">
      <p style="font-size:15px;margin-bottom:8px">Cloudflare not configured</p>
      <p style="color:var(--text2);font-size:13px;margin-bottom:20px">Set up your API token to enable automatic DNS, tunnel routes, and IP access policies.</p>
      <button class="btn btn-primary" onclick="showCfSetupModal()">Configure Cloudflare</button>
    </div>
  \`;
}

function renderCfConfigured(s) {
  return \`
    <div class="card">
      <div class="card-header"><h2>Status</h2><span class="badge badge-green">Connected</span></div>
      <table>
        <tr><td style="color:var(--text2)">Domain</td><td>\${s.domain}</td></tr>
        <tr><td style="color:var(--text2)">Tunnel</td><td>\${s.tunnelName} (\${s.tunnelId})</td></tr>
        <tr><td style="color:var(--text2)">DB Prefix</td><td>\${s.dbPrefix}</td></tr>
        <tr><td style="color:var(--text2)">Default IPs</td><td>\${s.defaultIps || '<em style="color:var(--text2)">none set</em>'}</td></tr>
      </table>
    </div>
    <div class="card">
      <div class="card-header"><h2>Tunnel Routes</h2></div>
      \${s.tunnelHostnames.length === 0 ? '<p style="color:var(--text2);font-size:13px">No routes configured</p>' : ''}
      <table>
        <thead><tr><th>Hostname</th><th>Service</th><th>Type</th></tr></thead>
        <tbody>\${s.tunnelHostnames.map(h => \`
          <tr>
            <td>\${h.hostname}</td>
            <td style="font-family:monospace;font-size:12px">\${h.service}</td>
            <td>\${h.isDb ? '<span class="badge badge-green">Database</span>' : '<span class="badge badge-blue">Other</span>'}</td>
          </tr>
        \`).join('')}</tbody>
      </table>
    </div>
  \`;
}

function showCfSetupModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'modal';
  overlay.innerHTML = \`
    <div class="modal">
      <h2>Configure Cloudflare</h2>
      <div class="form-group">
        <label>API Token</label>
        <input id="cf-token" type="password" placeholder="Paste your API token">
        <p style="font-size:11px;color:var(--text2);margin-top:4px">Permissions: Zone > DNS > Edit, Account > Cloudflare Tunnel > Edit, Account > Access Apps and Policies > Edit</p>
      </div>
      <div class="btn-row" style="margin-bottom:16px">
        <button class="btn btn-ghost" onclick="verifyCfToken()">Verify Token</button>
      </div>
      <div id="cf-step2" style="display:none">
        <div class="form-group"><label>Account</label><select id="cf-account"><option value="">Loading...</option></select></div>
        <div class="form-group"><label>Zone (Domain)</label><select id="cf-zone"><option value="">Loading...</option></select></div>
        <div class="form-group"><label>Tunnel</label><select id="cf-tunnel"><option value="">Loading...</option></select></div>
        <div class="form-row">
          <div class="form-group"><label>DB Subdomain Prefix</label><input id="cf-prefix" value="db" placeholder="db"></div>
          <div class="form-group"><label>Default IPs</label><input id="cf-ips" placeholder="1.2.3.4,10.0.0.0/8"></div>
        </div>
        <div class="btn-row">
          <button class="btn btn-primary" onclick="saveCfConfig()">Save Configuration</button>
          <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        </div>
      </div>
      <div id="cf-step1-cancel">
        <div class="btn-row"><button class="btn btn-ghost" onclick="closeModal()">Cancel</button></div>
      </div>
    </div>
  \`;
  document.body.appendChild(overlay);
}

async function verifyCfToken() {
  const token = document.getElementById('cf-token').value.trim();
  if (!token) return toast('Enter a token first', 'error');
  try {
    const result = await api.post('cloudflare/verify-token', { token });
    if (!result.valid) return toast('Invalid or expired token', 'error');
    toast('Token verified', 'success');

    // Load dropdowns
    const tempConfig = { token };
    const origFetch = window.fetch;
    window.fetch = async (url, opts) => {
      if (url.startsWith('/api/cloudflare/')) {
        url = 'https://api.cloudflare.com/client/v4/' + url.replace('/api/cloudflare/', '').replace('{account_id}', '');
        opts = opts || {};
        opts.headers = { ...opts.headers, 'Authorization': 'Bearer ' + token };
        const r = await origFetch(url, opts);
        const j = await r.json();
        return new Response(JSON.stringify({ result: j.result || j }));
      }
      return origFetch(url, opts);
    };

    try {
      const [accounts, zones, tunnels] = await Promise.all([
        api.get('cloudflare/accounts'),
        api.get('cloudflare/zones'),
        api.get('cloudflare/tunnels'),
      ]);

      document.getElementById('cf-account').innerHTML = accounts.accounts.map(a => '<option value="' + a.id + '">' + a.name + ' (' + a.id + ')</option>').join('');
      document.getElementById('cf-zone').innerHTML = zones.zones.map(z => '<option value="' + z.id + '" data-domain="' + z.name + '">' + z.name + '</option>').join('');
      document.getElementById('cf-tunnel').innerHTML = tunnels.tunnels.map(t => '<option value="' + t.id + '">' + t.name + ' (' + (t.running ? 'running' : 'inactive') + ')</option>').join('');

      document.getElementById('cf-zone').addEventListener('change', () => {
        // nothing needed, we read domain from the option
      });

      document.getElementById('cf-step2').style.display = 'block';
      document.getElementById('cf-step1-cancel').style.display = 'none';
    } finally {
      window.fetch = origFetch;
    }
  } catch (err) { toast(err.message || 'Verification failed', 'error'); }
}

async function saveCfConfig() {
  const token = document.getElementById('cf-token').value.trim();
  const account_id = document.getElementById('cf-account').value;
  const zoneSelect = document.getElementById('cf-zone');
  const zone_id = zoneSelect.value;
  const domain = zoneSelect.options[zoneSelect.selectedIndex].dataset.domain;
  const tunnelSelect = document.getElementById('cf-tunnel');
  const tunnel_id = tunnelSelect.value;
  const tunnel_name = tunnelSelect.options[tunnelSelect.selectedIndex].text.split(' (')[0];
  const db_prefix = document.getElementById('cf-prefix').value.trim() || 'db';
  const default_ips = document.getElementById('cf-ips').value.trim();

  if (!account_id || !zone_id || !tunnel_id) return toast('Select account, zone, and tunnel', 'error');
  try {
    await api.post('cloudflare/setup', { token, account_id, zone_id, domain, tunnel_id, tunnel_name, db_prefix, default_ips });
    closeModal();
    toast('Cloudflare configured', 'success');
    showPage('cloudflare');
  } catch (err) { toast(err.message || 'Failed', 'error'); }
}

// Init
showPage('dashboard');
</script>
</body>
</html>`;

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Dashboard running on port ${PORT}`);
});
