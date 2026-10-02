#!/usr/bin/env bash
# Run as root from an uploaded private deployment bundle on the existing ECS.
# Bundle: app/, seed-data/, auth.hash (bcrypt only), VERSION, this script.
set -euo pipefail
umask 077
[[ $(id -u) == 0 ]] || { echo 'Run as root'; exit 1; }
BUNDLE=$(cd "$(dirname "$0")" && pwd)
VERSION=$(cat "$BUNDLE/VERSION")
[[ $VERSION =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid commit'; exit 1; }
BASE=/opt/zhishi
DATA=/var/lib/zhishi
RUNTIME_SOURCE=/root/tongbanji-20260925-VVox8g/runtime/bin/node
test -x "$RUNTIME_SOURCE"
test -s "$BUNDLE/app/server.mjs"
test -s "$BUNDLE/auth.hash"
test -s "$BUNDLE/seed-data/plants.json"
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP="$BASE/backups/$STAMP"
install -d -m 755 "$BASE" "$BASE/releases" "$BASE/runtime"
install -d -m 700 "$BASE/backups" "$BACKUP"
cp -p /etc/caddy/Caddyfile "$BACKUP/Caddyfile.before"
readlink "$BASE/current" > "$BACKUP/previous-release" || true
if [[ -f /etc/zhishi.env ]]; then cp -p /etc/zhishi.env "$BACKUP/zhishi.env.before"; fi
if [[ -f "$DATA/plants.json" ]]; then cp -p "$DATA/plants.json" "$BACKUP/plants.json"; fi
APP_SWITCHED=0
PROXY_CHANGED=0
rollback() {
  local status=$?
  trap - ERR
  set +e
  if [[ $PROXY_CHANGED == 1 ]]; then
    install -m 644 "$BACKUP/Caddyfile.before" /etc/caddy/Caddyfile
    systemctl reload caddy
  fi
  if [[ $APP_SWITCHED == 1 ]]; then
    local previous
    previous=$(cat "$BACKUP/previous-release")
    if [[ -n $previous && -d $previous ]]; then
      ln -sfn "$previous" "$BASE/current.rollback"
      mv -Tf "$BASE/current.rollback" "$BASE/current"
      if [[ -f "$BACKUP/zhishi.env.before" ]]; then install -m 600 "$BACKUP/zhishi.env.before" /etc/zhishi.env; fi
      systemctl restart zhishi
    else
      systemctl stop zhishi
    fi
  fi
  echo "Deployment failed; prior routing restored. Data retained. Backup: $BACKUP"
  exit "$status"
}
trap rollback ERR
id zhishi >/dev/null 2>&1 || useradd --system --no-create-home --shell /sbin/nologin zhishi
install -d -m 700 -o zhishi -g zhishi "$DATA"
if [[ ! -e "$DATA/plants.json" ]]; then
  cp -a "$BUNDLE/seed-data/." "$DATA/"
  chown -R zhishi:zhishi "$DATA"
fi
install -m 755 "$RUNTIME_SOURCE" "$BASE/runtime/node"
if [[ ! -d "$BASE/releases/$VERSION" ]]; then
  install -d -m 755 "$BASE/releases/$VERSION"
  cp -a "$BUNDLE/app/." "$BASE/releases/$VERSION/"
  chmod -R a+rX "$BASE/releases/$VERSION"
fi
cat > /etc/zhishi.env <<'ENV'
PORT=18188
BASE_PATH=/plants
PUBLIC_ORIGIN=https://f.qdfb.tech
PLANT_DATA_DIR=/var/lib/zhishi
PLANT_PHOTO_PROVIDER=inaturalist
TZ=Asia/Shanghai
ENV
chmod 600 /etc/zhishi.env
install -m 644 "$BUNDLE/app/deploy/zhishi.service" /etc/systemd/system/zhishi.service
ln -sfn "$BASE/releases/$VERSION" "$BASE/current.next"
mv -Tf "$BASE/current.next" "$BASE/current"
APP_SWITCHED=1
systemctl daemon-reload
systemctl enable --now zhishi
systemctl restart zhishi
for attempt in {1..20}; do
  if curl -fsS http://127.0.0.1:18188/plants/api/config > "$BACKUP/config-check.json"; then break; fi
  sleep 0.5
done
curl -fsS http://127.0.0.1:18188/plants/api/state > "$BACKUP/state-after.json"
python3 - "$BUNDLE/auth.hash" "$BACKUP/Caddyfile.before" "$BACKUP/Caddyfile.candidate" <<'PY'
import pathlib,re,sys
password_hash=pathlib.Path(sys.argv[1]).read_text().strip()
assert re.fullmatch(r'\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}',password_hash), 'Invalid bcrypt hash'
original=pathlib.Path(sys.argv[2]).read_text()
block='''\t# BEGIN ZHISHI
\t@zhishi path /plants /plants/*
\thandle @zhishi {
\t\tbasicauth bcrypt "Zhishi" {
\t\t\tzhishi HASH
\t\t}
\t\treverse_proxy 127.0.0.1:18188
\t}
\thandle {
\t\treverse_proxy 127.0.0.1:18080
\t}
\t# END ZHISHI'''.replace('HASH',password_hash)
if '# BEGIN ZHISHI' in original:
 candidate,count=re.subn(r'(?m)^\s*# BEGIN ZHISHI[\s\S]*?^\s*# END ZHISHI',lambda _:block,original)
else:
 assert original.count('https://f.qdfb.tech {')==1, 'Unexpected site config'
 candidate,count=re.subn(r'(?m)^[ \t]*reverse_proxy 127\.0\.0\.1:18080[ \t]*$',lambda _:block,original)
assert count==1, 'Unexpected routing config; inspect manually'
pathlib.Path(sys.argv[3]).write_text(candidate)
PY
caddy validate --config "$BACKUP/Caddyfile.candidate" --adapter caddyfile
cmp -s /etc/caddy/Caddyfile "$BACKUP/Caddyfile.before"
install -m 644 "$BACKUP/Caddyfile.candidate" /etc/caddy/Caddyfile
PROXY_CHANGED=1
systemctl reload caddy
for service in zhishi caddy tongbanji-VVox8g; do systemctl is-active --quiet "$service"; done
curl -fsS https://f.qdfb.tech/api/health
STATUS=$(curl -sS -o /dev/null -w '%{http_code}' https://f.qdfb.tech/plants/api/state)
[[ $STATUS == 401 ]]
trap - ERR
printf '\nZHISHI_DEPLOYED %s\nBACKUP %s\n' "$VERSION" "$BACKUP"
