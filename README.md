# cf-mongodb

Self-hosted MongoDB with a web management UI and per-database IP access control via Cloudflare Tunnels. One command creates a database, provisions DNS, sets up tunnel routing, and applies IP whitelist policies.

Think of it as a self-hosted MongoDB Atlas.

## What's Included

- **MongoDB 8** running in Docker (auto-starts on boot)
- **Mongo Express** web UI for database management
- **CLI tool** for creating/deleting databases, managing users, backups
- **Cloudflare automation** — DNS records, tunnel routes, and IP access policies created automatically when you add a database

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (started and logged in)
- [A domain on Cloudflare](https://dash.cloudflare.com/) (free plan works)
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/) — `brew install cloudflared`

## Quick Start

### 1. Clone and configure

```bash
git clone https://github.com/raylin01/cf-mongodb.git
cd cf-mongodb

# Copy the example env and set your passwords
cp .env.example .env
# Edit .env — change both passwords to something strong
```

### 2. Start MongoDB

```bash
docker compose up -d
```

That's it. MongoDB and the web UI are running.

- **MongoDB**: `mongodb://admin:YOUR_PASSWORD@127.0.0.1:27017`
- **Web UI**: http://127.0.0.1:8081 (login with the credentials from `.env`)

### 3. Create your first database

```bash
./scripts/manage.sh create-db myapp
```

This creates a MongoDB database and user. You'll be prompted for a username and password (or it auto-generates one).

### 4. (Optional) Set up Cloudflare for remote access

This lets applications connect from anywhere with per-database IP whitelisting.

#### Create a Cloudflare API token

Go to https://dash.cloudflare.com/profile/api-tokens > **Create Token** and give it these permissions:

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

#### Run the setup

```bash
./scripts/manage.sh cf-setup
```

This will ask for your API token, then show you a list of your accounts, zones, and tunnels to pick from. It also sets a default IP whitelist used for all new databases.

#### Create a remote-enabled database

```bash
./scripts/manage.sh create-db myapp --remote
```

One command. It:
1. Creates the MongoDB database + user
2. Adds a DNS CNAME (`db-myapp.yourdomain.com` -> your tunnel)
3. Adds a tunnel route (hostname -> `localhost:27017`)
4. Creates an IP access policy (only your IPs can reach it)

Your app connects with:
```
mongodb://user:pass@db-myapp.yourdomain.com:27017/myapp?tls=true&directConnection=true
```

## CLI Reference

### Database commands

```bash
./scripts/manage.sh create-db <name> [--remote]   # Create DB + user (--remote adds Cloudflare)
./scripts/manage.sh create-user <db> <user>        # Add a user to an existing DB
./scripts/manage.sh delete-db <name>               # Drop DB + users + optional Cloudflare cleanup
./scripts/manage.sh list-dbs                       # List all DBs, users, and tunnel routes
./scripts/manage.sh list-users <db>                # Show users for a database
./scripts/manage.sh reset-password <db> <user>     # Reset a user's password
./scripts/manage.sh show-connection <db>           # Print connection strings
./scripts/manage.sh backup <db>                    # Backup to ./backups/
./scripts/manage.sh restore <db> <archive>         # Restore from backup
./scripts/manage.sh status                         # Health check
```

### Cloudflare commands

```bash
./scripts/manage.sh cf-setup                      # First-time Cloudflare configuration
./scripts/manage.sh cf-status                     # Show current config, routes, DNS
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
127.0.0.1:27017 (MongoDB on your machine)
    ├── Auth: does user have access to "myapp"? ── NO ──> Auth fail
    │
    ├── YES
    ▼
Database operations
```

Four layers of security:
1. **IP whitelist** (Cloudflare Zero Trust) — per-database at the edge
2. **TLS** — automatic through Cloudflare Tunnel
3. **MongoDB auth** — per-database users with RBAC
4. **Docker binding** — ports bound to `127.0.0.1` only, not exposed to LAN

## File Structure

```
cf-mongodb/
├── docker-compose.yml      # MongoDB + Mongo Express containers
├── mongod.conf             # MongoDB config (auth, storage)
├── .env.example            # Template for credentials
├── .env                    # Your actual credentials (gitignored)
├── .cloudflare.json        # Cloudflare config (gitignored, created by cf-setup)
├── scripts/
│   └── manage.sh           # CLI tool
├── cloudflare/
│   └── README.md           # Manual Cloudflare setup reference
├── data/mongo/             # MongoDB data (gitignored)
└── backups/                # Database backups (gitignored)
```

## Is It Free?

Yes. Everything runs on free tiers:

| Component | Cost |
|-----------|------|
| MongoDB | Free (self-hosted) |
| Docker Desktop | Free |
| Cloudflare Tunnel | Free, unlimited |
| Cloudflare Zero Trust policies | Free, unlimited |
| Cloudflare bandwidth | Free, unlimited |
| API calls | 1,200 / 5 min |

## Auto-Start

Docker Desktop auto-starts on login. Both containers use `restart: unless-stopped`, so they come up with Docker automatically.

## Common Operations

```bash
# Stop everything
docker compose down

# View logs
docker logs mongodb --tail 100 -f

# Update MongoDB version (edit docker-compose.yml, change "mongo:8")
docker compose pull && docker compose up -d

# Full reset (wipes all data)
docker compose down && rm -rf data/mongo/* && docker compose up -d
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `docker compose up` fails | Make sure Docker Desktop is running |
| Auth failed | Check `.env` passwords are set correctly |
| Web UI shows 401 | Use credentials from `.env` (`MONGOEXPRESS_USER`/`MONGOEXPRESS_PASSWORD`) |
| `cf-setup` can't find tunnel | Run `cloudflared tunnel create mongodb` first |
| Remote connection timeout | Tunnel not running, DNS wrong, or client IP not in the access policy |
| `--remote` API errors | Check token has all 3 permissions listed in step 4 |
