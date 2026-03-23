# cf-mongodb

Self-hosted MongoDB with a web dashboard and per-database IP access control via Cloudflare Tunnels. Create databases, manage users, and automatically provision DNS records, tunnel routes, and IP whitelist policies — all from a browser.

Think of it as a self-hosted MongoDB Atlas.

## What's Included

- **MongoDB 8** running in Docker (auto-starts on boot)
- **Web dashboard** for database management (create, delete, users, backups, connection strings)
- **Cloudflare automation** — one click to create DNS records, tunnel routes, and per-database IP access policies
- **CLI tool** for scripting/automation (`scripts/manage.sh`)

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (started and logged in)
- [A domain on Cloudflare](https://dash.cloudflare.com/) (free plan works)
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/) — `brew install cloudflared`

## Quick Start

### 1. Clone and configure

```bash
git clone https://github.com/raylin01/cf-mongodb.git
cd cf-mongodb

cp .env.example .env
# Edit .env — change both passwords to something strong
```

### 2. Start

```bash
docker compose up -d
```

MongoDB and the web dashboard are running.

- **Dashboard**: http://127.0.0.1:8081 (login with credentials from `.env`)
- **MongoDB**: `mongodb://admin:YOUR_PASSWORD@127.0.0.1:27017`

### 3. Use it

Open http://127.0.0.1:8081, log in, and click **+ New Database**.

That's it. Create databases, add users, copy connection strings, download backups — all from the dashboard.

### 4. (Optional) Cloudflare remote access

This lets applications connect from anywhere with per-database IP whitelisting.

#### Create a Cloudflare API token

Go to https://dash.cloudflare.com/profile/api-tokens > **Create Token** with these permissions:

| Permission | Scope |
|-----------|-------|
| Zone > DNS > Edit | Specific zone (your domain) |
| Account > Cloudflare Tunnel > Edit | Your account |
| Account > Access Apps and Policies > Edit | Your account |

#### Create a tunnel (if you don't have one)

```bash
cloudflared tunnel login        # Pick your domain
cloudflared tunnel create mongodb
```

#### Configure in the dashboard

Open the dashboard, click **Cloudflare** in the sidebar, and click **Configure Cloudflare**. Paste your API token, verify it, then select your account, zone, and tunnel from the dropdowns.

#### Create a remote-enabled database

When creating a database, toggle **Enable remote access** — it automatically creates:
1. A DNS CNAME record (`db-myapp.yourdomain.com`)
2. A tunnel route (hostname -> `localhost:27017`)
3. An IP access policy (only your IPs can reach it)

Your app connects with:
```
mongodb://user:pass@db-myapp.yourdomain.com:27017/myapp?tls=true&directConnection=true
```

## CLI Tool

The dashboard can do everything, but there's also a CLI for scripting:

```bash
./scripts/manage.sh create-db myapp --remote   # Create DB + Cloudflare
./scripts/manage.sh list-dbs
./scripts/manage.sh backup myapp
./scripts/manage.sh cf-setup                     # Interactive Cloudflare config
./scripts/manage.sh cf-status                    # Show Cloudflare status
```

## How It Works

```
Your App (1.2.3.4)
    │
    │  mongodb://user:pass@db-myapp.domain.com:27017/myapp?tls=true
    ▼
Cloudflare Edge
    ├── IP policy: is 1.2.3.4 allowed? ── NO ──> REJECT
    │
    ├── YES
    ▼
Cloudflare Tunnel (encrypted, no open ports)
    │
    ▼
127.0.0.1:27017 (MongoDB)
    ├── Auth: does user have access to "myapp"? ── NO ──> Auth fail
    │
    ├── YES
    ▼
Database operations
```

Four security layers:
1. **IP whitelist** (Cloudflare Zero Trust) — per-database at the edge
2. **TLS** — automatic through Cloudflare Tunnel
3. **MongoDB auth** — per-database users with RBAC
4. **Docker binding** — ports bound to `127.0.0.1` only

## Is It Free?

Yes. Everything runs on free tiers:

| Component | Cost |
|-----------|------|
| MongoDB | Free (self-hosted) |
| Docker Desktop | Free |
| Cloudflare Tunnel | Free, unlimited |
| Cloudflare Zero Trust policies | Free, unlimited |
| Cloudflare bandwidth | Free, unlimited |

## File Structure

```
cf-mongodb/
├── docker-compose.yml      # MongoDB + dashboard containers
├── mongod.conf             # MongoDB config
├── .env.example            # Template for credentials
├── .env                    # Your credentials (gitignored)
├── .cloudflare.json        # Cloudflare config (gitignored, created via dashboard)
├── dashboard/
│   ├── Dockerfile
│   ├── package.json
│   └── server.js           # Dashboard app (API + embedded frontend)
├── scripts/
│   └── manage.sh           # CLI tool
├── cloudflare/
│   └── README.md           # Cloudflare API reference
├── data/mongo/             # MongoDB data (gitignored)
└── backups/                # Database backups (gitignored)
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `docker compose up` fails | Make sure Docker Desktop is running |
| Dashboard shows 401 | Check `.env` has correct `DASHBOARD_USER`/`DASHBOARD_PASSWORD` |
| Database not showing in list | Insert some data first — MongoDB doesn't allocate disk space for empty DBs |
| `cf-setup` can't find tunnel | Run `cloudflared tunnel create mongodb` first |
| Remote connection timeout | Tunnel not running, DNS wrong, or client IP not in access policy |
| Cloudflare API errors | Check token has all 3 permissions listed above |
