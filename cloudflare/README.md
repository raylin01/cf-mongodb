# Cloudflare Tunnel Reference

This is a reference for how the Cloudflare integration works under the hood. For setup instructions, see the main [README](../README.md).

## API Endpoints Used

The `manage.sh` script calls these Cloudflare API endpoints:

| Operation | Method | Endpoint |
|-----------|--------|----------|
| Create DNS record | POST | `/zones/{zone_id}/dns_records` |
| Delete DNS record | DELETE | `/zones/{zone_id}/dns_records/{record_id}` |
| List tunnel hostnames | GET | `/accounts/{account_id}/cfd_tunnel/{tunnel_id}/public_hostnames` |
| Add tunnel hostname | POST | `/accounts/{account_id}/cfd_tunnel/{tunnel_id}/public_hostnames` |
| Remove tunnel hostname | DELETE | `/accounts/{account_id}/cfd_tunnel/{tunnel_id}/public_hostnames/{id}` |
| Create access policy | POST | `/accounts/{account_id}/access/policies` |

## API Token Permissions

Create at https://dash.cloudflare.com/profile/api-tokens:

- **Zone** > **DNS** > **Edit**
- **Account** > **Cloudflare Tunnel** > **Edit**
- **Account** > **Access Apps and Policies** > **Edit**

## Tunnel Configuration

The script manages tunnel routes via the API (no need to manually edit `~/.cloudflared/config.yml`). Each database hostname is added as a public hostname on your tunnel pointing to `mongodb://127.0.0.1:27017`.

If you also manage your tunnel via `~/.cloudflared/config.yml`, the API-managed routes and the config file routes are merged. The script's API routes take precedence for the hostnames it manages.

## DNS Records

Each database gets a CNAME record:

```
db-myapp.example.com  CNAME  <tunnel-id>.cfargotunnel.com  (Proxied)
```

The `Proxied` (orange cloud) flag is required — it routes traffic through Cloudflare's edge where access policies are enforced.

## Access Policies

When you run `create-db myapp --remote`, a Cloudflare Access policy is created:

- **Name**: `MongoDB - db-myapp.example.com`
- **Decision**: Allow
- **Include**: IP ranges from your default IPs (or per-DB override)

MongoDB uses the wire protocol (TCP), not HTTP. Access policies for TCP tunnel routes are enforced at the Cloudflare edge based on the connecting client's IP.

## Connection Strings

```
# Remote (through Cloudflare)
mongodb://user:pass@db-myapp.example.com:27017/myapp?tls=true&directConnection=true

# Local (no tunnel needed)
mongodb://user:pass@127.0.0.1:27017/myapp
```

The `directConnection=true` parameter is needed for some MongoDB drivers when connecting through a proxy/tunnel, since the server doesn't report itself as a replica set.

## Manual Configuration

If you prefer not to use `cf-setup`, you can create `.cloudflare.json` manually:

```json
{
  "token": "your-api-token",
  "account_id": "your-account-id",
  "zone_id": "your-zone-id",
  "domain": "example.com",
  "tunnel_id": "your-tunnel-id",
  "tunnel_name": "mongodb",
  "db_prefix": "db",
  "default_ips": "1.2.3.4/32,10.0.0.0/8",
  "web_subdomain": "mongo-admin"
}
```

Find your IDs:
- **Account ID**: Cloudflare Dashboard > any domain > right sidebar
- **Zone ID**: Cloudflare Dashboard > your domain > Overview > right sidebar
- **Tunnel ID**: Cloudflare Dashboard > Zero Trust > Networks > Tunnels
