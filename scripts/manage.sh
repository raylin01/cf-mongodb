#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_DIR/.env"
CF_CONFIG="$PROJECT_DIR/.cloudflare.json"

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: .env file not found at $ENV_FILE"
  exit 1
fi

source "$ENV_FILE"

MONGO_CONTAINER="mongodb"
MONGO_HOST="127.0.0.1"
MONGO_PORT="27017"

# --- MongoDB helpers ---

_encode_uri() {
  python3 -c "
import urllib.parse, sys
user = sys.argv[1]
pw = sys.argv[2]
host = sys.argv[3]
port = sys.argv[4]
target_db = sys.argv[5] if len(sys.argv) > 5 else 'admin'
print(f'mongodb://{urllib.parse.quote(user, safe=\"\")}:{urllib.parse.quote(pw, safe=\"\")}@{host}:{port}/{target_db}?authSource=admin')
" "$@"
}

MONGO_ROOT_URI=$(_encode_uri "$MONGO_ROOT_USER" "$MONGO_ROOT_PASSWORD" "127.0.0.1" "27017")

mongo_cmd() {
  docker exec "$MONGO_CONTAINER" mongosh "$MONGO_ROOT_URI" --quiet --eval "$1"
}

mongo_cmd_db() {
  local db="$1"
  shift
  local uri
  uri=$(_encode_uri "$MONGO_ROOT_USER" "$MONGO_ROOT_PASSWORD" "127.0.0.1" "27017" "$db")
  docker exec "$MONGO_CONTAINER" mongosh "$uri" --quiet --eval "$*"
}

generate_password() {
  openssl rand -base64 18 | tr -d '=/+'
}

# --- Cloudflare API helpers ---

cf_api() {
  local method="$1"
  local endpoint="$2"
  local data="${3:-}"

  if [ ! -f "$CF_CONFIG" ]; then
    echo "Error: Cloudflare not configured. Run: manage.sh cf-setup" >&2
    return 1
  fi

  local token account_id zone_id
  token=$(python3 -c "import json; c=json.load(open('$CF_CONFIG')); print(c['token'])")
  account_id=$(python3 -c "import json; c=json.load(open('$CF_CONFIG')); print(c['account_id'])")
  zone_id=$(python3 -c "import json; c=json.load(open('$CF_CONFIG')); print(c['zone_id'])")

  local url
  if [[ "$endpoint" == accounts/* ]]; then
    url="https://api.cloudflare.com/client/v4/$endpoint"
    url="${url//\{account_id\}/$account_id}"
  else
    url="https://api.cloudflare.com/client/v4/$endpoint"
    url="${url//\{zone_id\}/$zone_id}"
    url="${url//\{account_id\}/$account_id}"
  fi

  if [ -n "$data" ]; then
    curl -s -X "$method" "$url" \
      -H "Authorization: Bearer $token" \
      -H "Content-Type: application/json" \
      -d "$data"
  else
    curl -s -X "$method" "$url" \
      -H "Authorization: Bearer $token" \
      -H "Content-Type: application/json"
  fi
}

cf_check_success() {
  local response="$1"
  local context="${2:-API call}"
  local success
  success=$(echo "$response" | python3 -c "import json,sys; print(json.load(sys.stdin).get('success', False))" 2>/dev/null || echo "False")
  if [ "$success" != "True" ]; then
    local errors
    errors=$(echo "$response" | python3 -c "
import json,sys
d=json.load(sys.stdin)
errs = d.get('errors', [])
if errs:
  for e in errs:
    print(f'  {e.get(\"message\", \"unknown error\")}')
else:
  print('  Unknown error')
" 2>/dev/null || echo "  Failed to parse response")
    echo "Error ($context): $errors" >&2
    return 1
  fi
}

cf_get_tunnel_id() {
  local tunnel_name
  tunnel_name=$(python3 -c "import json; c=json.load(open('$CF_CONFIG')); print(c.get('tunnel_name', 'mongodb'))")
  local response
  response=$(cf_api GET "accounts/{account_id}/cfd_tunnel")
  echo "$response" | python3 -c "
import json,sys
tunnels = json.load(sys.stdin).get('result', [])
for t in tunnels:
    if t.get('name') == '$tunnel_name':
        print(t['id'])
        sys.exit(0)
print('')
" 2>/dev/null
}

cf_list_zones() {
  cf_api GET "zones" | python3 -c "
import json,sys
zones = json.load(sys.stdin).get('result', [])
for z in zones:
    print(f\"  {z['name']} (ID: {z['id']})\")
" 2>/dev/null
}

cf_list_tunnels() {
  cf_api GET "accounts/{account_id}/cfd_tunnel" | python3 -c "
import json,sys
tunnels = json.load(sys.stdin).get('result', [])
for t in tunnels:
    status = t.get('tunnel_conns', []) and 'running' or 'inactive'
    print(f\"  {t['name']} (ID: {t['id']}, status: {status})\")
" 2>/dev/null
}

# --- Cloudflare commands ---

cmd_cf_setup() {
  echo "=== Cloudflare Setup ==="
  echo ""
  echo "This will configure Cloudflare Tunnel integration for automatic"
  echo "DNS routing and IP access policies when creating databases."
  echo ""

  # API Token
  local token="${CF_API_TOKEN:-}"
  if [ -z "$token" ]; then
    echo "Create an API token at: https://dash.cloudflare.com/profile/api-tokens"
    echo "Required permissions:"
    echo "  - Zone > DNS > Edit"
    echo "  - Account > Cloudflare Tunnel > Edit"
    echo "  - Account > Access Apps and Policies > Edit"
    echo ""
    read -rp "API Token: " token
  fi

  if [ -z "$token" ]; then
    echo "Error: API token is required"
    exit 1
  fi

  # Test the token
  local test_response
  test_response=$(curl -s -X GET "https://api.cloudflare.com/client/v4/user/tokens/verify" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json")
  local test_ok
  test_ok=$(echo "$test_response" | python3 -c "import json,sys; print(json.load(sys.stdin).get('result',{}).get('status',''))" 2>/dev/null)
  if [ "$test_ok" != "active" ]; then
    echo "Error: API token is invalid or expired"
    exit 1
  fi
  echo "Token verified."

  # Account ID
  echo ""
  local account_id="${CF_ACCOUNT_ID:-}"
  local accounts_response
  accounts_response=$(curl -s -X GET "https://api.cloudflare.com/client/v4/accounts" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json")
  echo "Available accounts:"
  echo "$accounts_response" | python3 -c "
import json,sys
accounts = json.load(sys.stdin).get('result', [])
for a in accounts:
    print(f\"  {a['name']} (ID: {a['id']})\")
" 2>/dev/null
  if [ -z "$account_id" ]; then
    read -rp "Account ID: " account_id
  fi

  # Zone (domain)
  echo ""
  echo "Available zones:"
  cf_list_zones
  local zone_id="${CF_ZONE_ID:-}"
  local domain="${CF_DOMAIN:-}"
  if [ -z "$zone_id" ]; then
    read -rp "Zone ID (from list above): " zone_id
    if [ -n "$zone_id" ]; then
      domain=$(curl -s -X GET "https://api.cloudflare.com/client/v4/zones/$zone_id" \
        -H "Authorization: Bearer $token" \
        -H "Content-Type: application/json" | python3 -c "import json,sys; print(json.load(sys.stdin).get('result',{}).get('name',''))" 2>/dev/null)
    fi
  fi

  # Tunnel
  echo ""
  echo "Available tunnels:"
  cf_list_tunnels
  local tunnel_id="${CF_TUNNEL_ID:-}"
  local tunnel_name="${CF_TUNNEL_NAME:-mongodb}"
  if [ -z "$tunnel_id" ]; then
    read -rp "Tunnel name (default: mongodb): " tunnel_name_input
    tunnel_name="${tunnel_name_input:-$tunnel_name}"
    tunnel_id=$(cf_api GET "accounts/{account_id}/cfd_tunnel" | python3 -c "
import json,sys
tunnels = json.load(sys.stdin).get('result', [])
for t in tunnels:
    if t.get('name') == '$tunnel_name':
        print(t['id'])
        sys.exit(0)
print('')
" 2>/dev/null)
  fi

  if [ -z "$tunnel_id" ]; then
    echo "No tunnel found. Create one in the Cloudflare dashboard or with:"
    echo "  cloudflared tunnel create $tunnel_name"
    exit 1
  fi
  echo "Using tunnel: $tunnel_name ($tunnel_id)"

  # DB subdomain prefix
  local db_prefix="${CF_DB_PREFIX:-db}"
  read -rp "Database subdomain prefix (default: db, e.g. db-myapp.example.com): " prefix_input
  db_prefix="${prefix_input:-$db_prefix}"

  # Default IP access policy
  local default_ips="${CF_DEFAULT_IPS:-}"
  read -rp "Default allowed IPs/CIDRs (comma-separated, e.g. 1.2.3.4,10.0.0.0/8): " ips_input
  default_ips="${ips_input:-$default_ips}"

  # Web UI subdomain
  local web_subdomain="${CF_WEB_SUBDOMAIN:-mongo-admin}"
  read -rp "Web UI subdomain (default: mongo-admin): " web_input
  web_subdomain="${web_input:-$web_subdomain}"

  # Save config
  python3 -c "
import json
config = {
    'token': '$token',
    'account_id': '$account_id',
    'zone_id': '$zone_id',
    'domain': '$domain',
    'tunnel_id': '$tunnel_id',
    'tunnel_name': '$tunnel_name',
    'db_prefix': '$db_prefix',
    'default_ips': '$default_ips',
    'web_subdomain': '$web_subdomain'
}
with open('$CF_CONFIG', 'w') as f:
    json.dump(config, f, indent=2)
"

  echo ""
  echo "Cloudflare configuration saved to $CF_CONFIG"
  echo ""
  echo "Summary:"
  echo "  Domain:          $domain"
  echo "  Tunnel:          $tunnel_name ($tunnel_id)"
  echo "  DB prefix:       $db_prefix (e.g. ${db_prefix}-myapp.$domain)"
  echo "  Default IPs:     ${default_ips:-<none set>}"
  echo "  Web UI:          $web_subdomain.$domain"
  echo ""
  echo "You can now use: manage.sh create-db myapp --remote"
  echo "  (use --remote flag to auto-create DNS + tunnel route + access policy)"
}

cmd_cf_status() {
  if [ ! -f "$CF_CONFIG" ]; then
    echo "Cloudflare not configured. Run: manage.sh cf-setup"
    exit 1
  fi

  python3 -c "
import json
c = json.load(open('$CF_CONFIG'))
print('=== Cloudflare Configuration ===')
print(f'  Domain:       {c[\"domain\"]}')
print(f'  Tunnel:       {c[\"tunnel_name\"]} ({c[\"tunnel_id\"]})')
print(f'  DB prefix:    {c[\"db_prefix\"]}')
print(f'  Default IPs:  {c.get(\"default_ips\", \"<none>\") or \"<none>\"}')
print(f'  Web UI:       {c.get(\"web_subdomain\", \"mongo-admin\")}.{c[\"domain\"]}')
" 2>/dev/null

  echo ""
  echo "=== Tunnel Hostnames ==="
  cf_api GET "accounts/{account_id}/cfd_tunnel/{tunnel_id}/public_hostnames" 2>/dev/null | python3 -c "
import json,sys
result = json.load(sys.stdin).get('result', [])
if not result:
    print('  (none configured)')
else:
    for h in result:
        print(f'  {h[\"hostname\"]} -> {h[\"service\"]}')
" 2>/dev/null || echo "  (could not fetch hostnames)"

  echo ""
  echo "=== DNS Records (tunnel) ==="
  local tunnel_id_cf
  tunnel_id_cf=$(python3 -c "import json; c=json.load(open('$CF_CONFIG')); print(c['tunnel_id'])")
  cf_api GET "zones/{zone_id}/dns_records?type=CNAME" 2>/dev/null | python3 -c "
import json,sys
records = json.load(sys.stdin).get('result', [])
tunnel_cname = '${tunnel_id_cf}.cfargotunnel.com'
for r in records:
    if r.get('content','').endswith('cfargotunnel.com'):
        proxied = 'Proxied' if r.get('proxied') else 'DNS only'
        print(f'  {r[\"name\"]:30} -> {r[\"content\"]:50} ({proxied})')
" 2>/dev/null || echo "  (could not fetch DNS records)"
}

cf_add_tunnel_route() {
  local hostname="$1"
  local service="$2"  # e.g. mongodb://127.0.0.1:27017 or http://127.0.0.1:8081

  echo "  Adding tunnel route: $hostname -> $service"
  local response
  response=$(cf_api POST "accounts/{account_id}/cfd_tunnel/{tunnel_id}/public_hostnames" "{
    \"hostname\": \"$hostname\",
    \"service\": \"$service\",
    \"originRequest\": {
      \"noTLSVerify\": true,
      \"connectTimeout\": 30
    }
  }")

  if ! cf_check_success "$response" "add tunnel route"; then
    return 1
  fi
  echo "  Tunnel route added."
}

cf_add_dns_record() {
  local hostname="$1"

  echo "  Adding DNS CNAME: $hostname"
  local tunnel_id_cf
  tunnel_id_cf=$(python3 -c "import json; c=json.load(open('$CF_CONFIG')); print(c['tunnel_id'])")
  local response
  response=$(cf_api POST "zones/{zone_id}/dns_records" "{
    \"type\": \"CNAME\",
    \"name\": \"$hostname\",
    \"content\": \"${tunnel_id_cf}.cfargotunnel.com\",
    \"proxied\": true
  }")

  if ! cf_check_success "$response" "add DNS record"; then
    return 1
  fi
  echo "  DNS record added."
}

cf_set_access_policy() {
  local hostname="$1"
  local ips="$2"  # comma-separated

  echo "  Setting IP access policy for $hostname"
  local policy_name="MongoDB - ${hostname}"
  local response
  response=$(cf_api POST "accounts/{account_id}/access/policies" "{
    \"name\": \"$policy_name\",
    \"decision\": \"allow\",
    \"include\": [
      $(_cf_build_ip_rules "$ips")
    ]
  }")

  if ! cf_check_success "$response" "create access policy"; then
    return 1
  fi

  local policy_id
  policy_id=$(echo "$response" | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['id'])" 2>/dev/null)
  echo "  Access policy created: $policy_id"
}

_cf_build_ip_rules() {
  local ips="$1"
  python3 -c "
import sys
ips = '$ips'.split(',')
rules = []
for ip in ips:
    ip = ip.strip()
    if not ip:
        continue
    if '/' in ip:
        rules.append({\"ip\": {\"ip\": ip}})
    else:
        rules.append({\"ip\": {\"ip\": ip + \"/32\"}})
import json
print(json.dumps(rules))
" 2>/dev/null
}

cf_remove_tunnel_route() {
  local hostname="$1"
  local response
  response=$(cf_api GET "accounts/{account_id}/cfd_tunnel/{tunnel_id}/public_hostnames" 2>/dev/null)

  local host_id
  host_id=$(echo "$response" | python3 -c "
import json,sys
hostnames = json.load(sys.stdin).get('result', [])
for h in hostnames:
    if h.get('hostname') == '$hostname':
        print(h['id'])
        sys.exit(0)
print('')
" 2>/dev/null)

  if [ -z "$host_id" ]; then
    echo "  No tunnel route found for $hostname (skipping)"
    return 0
  fi

  echo "  Removing tunnel route: $hostname ($host_id)"
  response=$(cf_api DELETE "accounts/{account_id}/cfd_tunnel/{tunnel_id}/public_hostnames/$host_id")
  if cf_check_success "$response" "remove tunnel route"; then
    echo "  Tunnel route removed."
  fi
}

cf_remove_dns_record() {
  local hostname="$1"
  local response
  response=$(cf_api GET "zones/{zone_id}/dns_records?name=$hostname" 2>/dev/null)

  local record_id
  record_id=$(echo "$response" | python3 -c "
import json,sys
records = json.load(sys.stdin).get('result', [])
for r in records:
    if r.get('name') == '$hostname':
        print(r['id'])
        sys.exit(0)
print('')
" 2>/dev/null)

  if [ -z "$record_id" ]; then
    echo "  No DNS record found for $hostname (skipping)"
    return 0
  fi

  echo "  Removing DNS record: $hostname ($record_id)"
  response=$(cf_api DELETE "zones/{zone_id}/dns_records/$record_id")
  if cf_check_success "$response" "remove DNS record"; then
    echo "  DNS record removed."
  fi
}

cf_get_hostname() {
  local db_name="$1"
  local prefix domain
  prefix=$(python3 -c "import json; c=json.load(open('$CF_CONFIG')); print(c['db_prefix'])")
  domain=$(python3 -c "import json; c=json.load(open('$CF_CONFIG')); print(c['domain'])")
  echo "${prefix}-${db_name}.${domain}"
}

cf_get_web_hostname() {
  local subdomain domain
  subdomain=$(python3 -c "import json; c=json.load(open('$CF_CONFIG')); print(c.get('web_subdomain', 'mongo-admin'))")
  domain=$(python3 -c "import json; c=json.load(open('$CF_CONFIG')); print(c['domain'])")
  echo "${subdomain}.${domain}"
}

# --- Core commands ---

cmd_create_db() {
  local db_name="${1:-}"
  local do_remote=false
  if [ -z "$db_name" ]; then
    echo "Usage: manage.sh create-db <name> [--remote]"
    exit 1
  fi
  if [[ "${2:-}" == "--remote" ]]; then
    do_remote=true
  fi

  read -rp "Username for '$db_name': " username
  if [ -z "$username" ]; then
    echo "Error: username cannot be empty"
    exit 1
  fi

  local password
  read -rp "Password (leave empty to auto-generate): " password
  if [ -z "$password" ]; then
    password=$(generate_password)
    echo "Generated password: $password"
  fi

  # Create the user on the target database
  mongo_cmd_db "$db_name" "
    db.createUser({
      user: '$username',
      pwd: '$password',
      roles: [
        { role: 'readWrite', db: '$db_name' },
        { role: 'dbAdmin', db: '$db_name' }
      ]
    })
  "

  echo ""
  echo "Database '$db_name' created with user '$username'."
  echo "Connection string:"
  echo "  mongodb://$username:$password@127.0.0.1:27017/$db_name"

  # Cloudflare automation
  if [ "$do_remote" = true ]; then
    if [ ! -f "$CF_CONFIG" ]; then
      echo ""
      echo "Cloudflare not configured. Skipping remote setup."
      echo "Run 'manage.sh cf-setup' to configure, then re-run with --remote."
      return 0
    fi

    local hostname
    hostname=$(cf_get_hostname "$db_name")
    echo ""
    echo "--- Cloudflare Setup ---"

    # IP access policy
    local ips
    ips=$(python3 -c "import json; c=json.load(open('$CF_CONFIG')); print(c.get('default_ips',''))" 2>/dev/null)
    read -rp "Allowed IPs/CIDRs for $hostname (comma-separated${ips:+, current default: $ips}): " ips_input
    ips="${ips_input:-$ips}"

    # DNS + Tunnel route
    cf_add_dns_record "$hostname"
    cf_add_tunnel_route "$hostname" "mongodb://127.0.0.1:27017"

    # Access policy (only if IPs specified)
    if [ -n "$ips" ]; then
      cf_set_access_policy "$hostname" "$ips"
    else
      echo "  No IP policy set (open to all tunnel traffic). Set one later via Cloudflare dashboard."
    fi

    echo ""
    echo "Remote connection string:"
    echo "  mongodb://$username:$password@${hostname}:27017/$db_name?tls=true&directConnection=true"
  fi
}

cmd_create_user() {
  local db_name="${1:-}"
  local username="${2:-}"
  if [ -z "$db_name" ] || [ -z "$username" ]; then
    echo "Usage: manage.sh create-user <db> <username>"
    exit 1
  fi

  local password
  read -rp "Password (leave empty to auto-generate): " password
  if [ -z "$password" ]; then
    password=$(generate_password)
    echo "Generated password: $password"
  fi

  local role="readWrite"
  read -rp "Role [readWrite/read/dbAdmin] (default: readWrite): " role_input
  if [ -n "$role_input" ]; then
    role="$role_input"
  fi

  mongo_cmd_db "$db_name" "
    db.createUser({
      user: '$username',
      pwd: '$password',
      roles: [{ role: '$role', db: '$db_name' }]
    })
  "

  echo "User '$username' created on '$db_name' with role '$role'."
}

cmd_delete_db() {
  local db_name="${1:-}"
  if [ -z "$db_name" ]; then
    echo "Usage: manage.sh delete-db <name>"
    exit 1
  fi

  echo "This will drop database '$db_name' and revoke all its users."
  read -rp "Are you sure? [y/N] " confirm
  if [[ "$confirm" != [yY] ]]; then
    echo "Cancelled."
    exit 0
  fi

  mongo_cmd_db "$db_name" "db.dropDatabase()"
  mongo_cmd_db "$db_name" "db.dropAllUsers()" 2>/dev/null || true

  echo "Database '$db_name' dropped."

  # Clean up Cloudflare resources
  if [ -f "$CF_CONFIG" ]; then
    local hostname
    hostname=$(cf_get_hostname "$db_name")
    read -rp "Also remove Cloudflare route for $hostname? [y/N]: " cf_confirm
    if [[ "$cf_confirm" == [yY] ]]; then
      echo "--- Cleaning up Cloudflare ---"
      cf_remove_tunnel_route "$hostname"
      cf_remove_dns_record "$hostname"
      echo "Cloudflare cleanup done."
    fi
  fi
}

cmd_list_dbs() {
  echo "=== Databases ==="
  mongo_cmd "
    db.adminCommand('listDatabases').databases.forEach(function(d) {
      print('  ' + d.name + ' (' + (d.sizeOnDisk / 1048576).toFixed(2) + ' MB)')
    })
  "

  echo ""
  echo "=== Users per Database ==="
  mongo_cmd "
    db.adminCommand('listDatabases').databases.forEach(function(d) {
      if (d.name !== 'admin' && d.name !== 'config' && d.name !== 'local') {
        var r = db.getSiblingDB(d.name).getUsers();
        var users = (r.users || []).map(function(u) { return u.user + ' [' + u.roles.map(function(role) { return role.role; }).join(', ') + ']'; });
        if (users.length > 0) {
          print('  ' + d.name + ': ' + users.join(', '))
        } else {
          print('  ' + d.name + ': (no users)')
        }
      }
    })
  "

  # Show Cloudflare routes if configured
  if [ -f "$CF_CONFIG" ]; then
    echo ""
    echo "=== Cloudflare Routes ==="
    cf_api GET "accounts/{account_id}/cfd_tunnel/{tunnel_id}/public_hostnames" 2>/dev/null | python3 -c "
import json,sys
result = json.load(sys.stdin).get('result', [])
prefix = json.load(open('$CF_CONFIG'))['db_prefix']
mongo_routes = [h for h in result if h.get('hostname','').startswith(prefix + '-')]
if mongo_routes:
    for h in mongo_routes:
        db = h['hostname'].split('.', 1)[0].replace(prefix + '-', '', 1)
        print(f'  {h[\"hostname\"]} -> {h[\"service\"]} (db: {db})')
else:
    print('  (no database routes configured)')
" 2>/dev/null || echo "  (could not fetch routes)"
  fi
}

cmd_list_users() {
  local db_name="${1:-}"
  if [ -z "$db_name" ]; then
    echo "Usage: manage.sh list-users <db>"
    exit 1
  fi

  mongo_cmd_db "$db_name" "
    var result = db.getUsers();
    var users = result.users || [];
    if (users.length === 0) {
      print('No users found in database: $db_name');
    } else {
      users.forEach(function(u) {
        print('  User: ' + u.user);
        print('  Roles: ' + u.roles.map(function(r) { return r.role; }).join(', '));
        print('');
      });
    }
  "
}

cmd_reset_password() {
  local db_name="${1:-}"
  local username="${2:-}"
  if [ -z "$db_name" ] || [ -z "$username" ]; then
    echo "Usage: manage.sh reset-password <db> <username>"
    exit 1
  fi

  local password
  read -rp "New password (leave empty to auto-generate): " password
  if [ -z "$password" ]; then
    password=$(generate_password)
  fi

  mongo_cmd_db "$db_name" "db.changeUserPassword('$username', '$password')"
  echo "Password for '$username' on '$db_name' has been reset."
  echo "New password: $password"
}

cmd_show_connection() {
  local db_name="${1:-}"
  if [ -z "$db_name" ]; then
    echo "Usage: manage.sh show-connection <db>"
    exit 1
  fi

  local user
  user=$(mongo_cmd_db "$db_name" "var r = db.getUsers(); r.users.length > 0 ? r.users[0].user : ''" 2>/dev/null || true)
  if [ -z "$user" ]; then
    echo "No users found for database '$db_name'."
    echo "Create one with: manage.sh create-user $db_name <username>"
    exit 1
  fi

  echo "Database: $db_name"
  echo "Local:    mongodb://$user:<password>@127.0.0.1:27017/$db_name"

  if [ -f "$CF_CONFIG" ]; then
    local hostname
    hostname=$(cf_get_hostname "$db_name")
    echo "Remote:   mongodb://$user:<password>@${hostname}:27017/$db_name?tls=true&directConnection=true"
  fi
}

cmd_backup() {
  local db_name="${1:-}"
  if [ -z "$db_name" ]; then
    echo "Usage: manage.sh backup <db>"
    exit 1
  fi

  local timestamp
  timestamp=$(date +%Y%m%d_%H%M%S)
  local backup_dir="$PROJECT_DIR/backups"
  mkdir -p "$backup_dir"

  local archive="$backup_dir/${db_name}_${timestamp}.archive.gz"
  local net_id
  net_id=$(docker network ls --filter name=mongodb-net -q)
  local backup_uri
  backup_uri=$(_encode_uri "$MONGO_ROOT_USER" "$MONGO_ROOT_PASSWORD" "mongodb" "27017" "$db_name")

  docker run --rm \
    --network "$net_id" \
    -v "$backup_dir:/backups" \
    mongo:8 \
    mongodump \
    --uri="$backup_uri" \
    --gzip \
    --archive="/backups/${db_name}_${timestamp}.archive.gz"

  echo "Backup saved to: $archive"
}

cmd_restore() {
  local db_name="${1:-}"
  local archive="${2:-}"
  if [ -z "$db_name" ] || [ -z "$archive" ]; then
    echo "Usage: manage.sh restore <db> <archive>"
    exit 1
  fi

  if [ ! -f "$archive" ]; then
    echo "Error: archive not found: $archive"
    exit 1
  fi

  echo "This will restore '$db_name' from backup. Existing data will be overwritten."
  read -rp "Continue? [y/N] " confirm
  if [[ "$confirm" != [yY] ]]; then
    echo "Cancelled."
    exit 0
  fi

  local net_id
  net_id=$(docker network ls --filter name=mongodb-net -q)
  local restore_uri
  restore_uri=$(_encode_uri "$MONGO_ROOT_USER" "$MONGO_ROOT_PASSWORD" "mongodb" "27017" "$db_name")

  docker run --rm \
    --network "$net_id" \
    -v "$(dirname "$archive"):/backups" \
    mongo:8 \
    mongorestore \
    --uri="$restore_uri" \
    --gzip \
    --archive="/backups/$(basename "$archive")" \
    --drop

  echo "Database '$db_name' restored from $archive"
}

cmd_status() {
  echo "=== Container Status ==="
  docker compose -f "$PROJECT_DIR/docker-compose.yml" ps 2>/dev/null || docker ps --filter name=mongodb --filter name=mongo-express

  echo ""
  echo "=== MongoDB Health ==="
  local ping
  ping=$(mongo_cmd "db.runCommand({ping:1}).ok" 2>/dev/null || echo "UNREACHABLE")
  if [ "$ping" = "1" ]; then
    echo "  MongoDB: OK"
  else
    echo "  MongoDB: NOT REACHABLE"
  fi

  echo ""
  echo "=== Web UI ==="
  echo "  URL: http://127.0.0.1:8081"
  echo "  User: $MONGOEXPRESS_USER"

  echo ""
  echo "=== Databases ==="
  mongo_cmd "
    db.adminCommand('listDatabases').databases.forEach(function(d) {
      if (!['admin','config','local'].includes(d.name)) {
        print('  ' + d.name + ' (' + (d.sizeOnDisk / 1048576).toFixed(2) + ' MB)')
      }
    })
  " 2>/dev/null || echo "  (could not list databases)"

  if [ -f "$CF_CONFIG" ]; then
    echo ""
    echo "=== Cloudflare ==="
    echo "  Connected: yes ($(python3 -c "import json; c=json.load(open('$CF_CONFIG')); print(c['domain'])" 2>/dev/null))"
  fi
}

# --- Usage ---

usage() {
  cat <<'USAGE'
MongoDB Management Script

Usage: manage.sh <command> [args]

Database Commands:
  create-db <name> [--remote]  Create DB + user. --remote also sets up
                              Cloudflare DNS, tunnel route, and IP policy
  create-user <db> <user>      Create a user for an existing database
  delete-db <name>             Drop database, users, and optionally Cloudflare routes
  list-dbs                     List all databases, users, and Cloudflare routes
  list-users <db>              List users for a specific database
  reset-password <db> <user>   Reset a user's password
  show-connection <db>         Print connection strings (local + remote)
  backup <db>                  Backup a database to ./backups/
  restore <db> <archive>       Restore a database from a backup
  status                       Show container status and health

Cloudflare Commands:
  cf-setup                     Interactive setup: token, account, zone, tunnel
  cf-status                    Show Cloudflare config, tunnel routes, DNS records

Examples:
  manage.sh cf-setup                     # First-time Cloudflare config
  manage.sh create-db myapp --remote     # Create DB + auto-configure Cloudflare
  manage.sh create-db myapp              # Create DB locally only
  manage.sh show-connection myapp
  manage.sh list-dbs
  manage.sh backup myapp
USAGE
  exit 1
}

# --- Main dispatch ---

case "${1:-}" in
  create-db)       cmd_create_db "${2:-}" "${3:-}" ;;
  create-user)     cmd_create_user "${2:-}" "${3:-}" ;;
  delete-db)       cmd_delete_db "${2:-}" ;;
  list-dbs)        cmd_list_dbs ;;
  list-users)      cmd_list_users "${2:-}" ;;
  reset-password)  cmd_reset_password "${2:-}" "${3:-}" ;;
  show-connection) cmd_show_connection "${2:-}" ;;
  backup)          cmd_backup "${2:-}" ;;
  restore)         cmd_restore "${2:-}" "${3:-}" ;;
  status)          cmd_status ;;
  cf-setup)        cmd_cf_setup ;;
  cf-status)       cmd_cf_status ;;
  *)               usage ;;
esac
