#!/usr/bin/env bash
# Run as root from an uploaded private deployment bundle on the existing ECS.
# Bundle: app/, seed-data/, auth.hash (bcrypt only), VERSION, this script.
set -Eeuo pipefail
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
STAMP=$(date +%Y%m%d-%H%M%S)-$$
BACKUP="$BASE/backups/$STAMP"
install -d -m 755 "$BASE" "$BASE/releases" "$BASE/runtime"
install -d -m 700 "$BASE/backups" "$BACKUP"
cp -p /etc/caddy/Caddyfile "$BACKUP/Caddyfile.before"
[[ ! -e "$BASE/current" || -L "$BASE/current" ]] || { echo 'Current release must be a symlink'; exit 1; }
readlink "$BASE/current" > "$BACKUP/previous-release" || true
for entry in env unit runtime; do
  case "$entry" in
    env) original=/etc/zhishi.env ;;
    unit) original=/etc/systemd/system/zhishi.service ;;
    runtime) original="$BASE/runtime/node" ;;
  esac
  if [[ -e "$original" || -L "$original" ]]; then cp -a "$original" "$BACKUP/$entry.before"; fi
done
systemctl is-enabled zhishi > "$BACKUP/service-enabled.before" 2>/dev/null || true
systemctl is-active zhishi > "$BACKUP/service-active.before" 2>/dev/null || true
PREVIOUS_ENABLED=$(cat "$BACKUP/service-enabled.before")
PREVIOUS_ACTIVE=$(cat "$BACKUP/service-active.before")
case "$PREVIOUS_ENABLED" in enabled|enabled-runtime|disabled|static|indirect|not-found|'') ;; *) echo 'Unexpected service enable state; inspect before deploying'; exit 1 ;; esac
case "$PREVIOUS_ACTIVE" in active|inactive|failed|unknown|'') ;; *) echo 'Service is changing state; retry after it settles'; exit 1 ;; esac
if [[ -f "$DATA/plants.json" ]]; then cp -p "$DATA/plants.json" "$BACKUP/plants.json"; fi
APP_SWITCHED=0
FILES_CHANGED=0
SERVICE_TOUCHED=0
PROXY_CHANGED=0
install_atomic() {
  local mode=$1 source=$2 target=$3
  install -m "$mode" "$source" "$target.zhishi-$STAMP.tmp" && mv -Tf "$target.zhishi-$STAMP.tmp" "$target"
}
restore_file() {
  local entry=$1 target=$2
  if [[ -e "$BACKUP/$entry.before" || -L "$BACKUP/$entry.before" ]]; then
    cp -a "$BACKUP/$entry.before" "$target.zhishi-$STAMP.restore" && mv -Tf "$target.zhishi-$STAMP.restore" "$target"
  else
    rm -f "$target"
  fi
}
rollback() {
  local status=$1 reason=$2 rollback_failed=0 previous
  trap - ERR INT TERM
  set +e
  if [[ $PROXY_CHANGED == 1 ]]; then
    if cmp -s /etc/caddy/Caddyfile "$BACKUP/Caddyfile.candidate"; then
      if install_atomic 644 "$BACKUP/Caddyfile.before" /etc/caddy/Caddyfile; then
        systemctl reload caddy || rollback_failed=1
      else
        rollback_failed=1
      fi
    elif cmp -s /etc/caddy/Caddyfile "$BACKUP/Caddyfile.before"; then
      systemctl reload caddy || rollback_failed=1
    else
      echo 'Caddyfile changed externally; preserving those changes. Manual routing review required.' >&2
      rollback_failed=1
    fi
  fi
  if [[ $SERVICE_TOUCHED == 1 ]]; then
    systemctl stop zhishi || rollback_failed=1
    systemctl disable zhishi || rollback_failed=1
  fi
  if [[ $APP_SWITCHED == 1 ]]; then
    previous=$(cat "$BACKUP/previous-release")
    if [[ -n $previous ]]; then
      ln -sfn "$previous" "$BASE/current.rollback" && mv -Tf "$BASE/current.rollback" "$BASE/current" || rollback_failed=1
    else
      rm -f "$BASE/current" || rollback_failed=1
    fi
  fi
  if [[ $FILES_CHANGED == 1 ]]; then
    restore_file env /etc/zhishi.env || rollback_failed=1
    restore_file unit /etc/systemd/system/zhishi.service || rollback_failed=1
    restore_file runtime "$BASE/runtime/node" || rollback_failed=1
    systemctl daemon-reload || rollback_failed=1
  fi
  if [[ $SERVICE_TOUCHED == 1 ]]; then
    case "$PREVIOUS_ENABLED" in
      enabled) systemctl enable zhishi || rollback_failed=1 ;;
      enabled-runtime) systemctl enable --runtime zhishi || rollback_failed=1 ;;
    esac
    if [[ $PREVIOUS_ACTIVE == active ]]; then systemctl restart zhishi || rollback_failed=1; fi
  fi
  systemctl is-enabled zhishi > "$BACKUP/service-enabled.after-rollback" 2>/dev/null || true
  systemctl is-active zhishi > "$BACKUP/service-active.after-rollback" 2>/dev/null || true
  if [[ $rollback_failed == 1 ]]; then
    echo "Deployment failed ($reason); rollback needs manual review. Data retained. Backup: $BACKUP" >&2
  else
    echo "Deployment failed ($reason); prior application and routing restored. Data retained. Backup: $BACKUP" >&2
  fi
  exit "$status"
}
trap 'rollback "$?" "command failure"' ERR
trap 'rollback 130 "interrupted (INT)"' INT
trap 'rollback 143 "terminated (TERM)"' TERM
id zhishi >/dev/null 2>&1 || useradd --system --no-create-home --shell /sbin/nologin zhishi
install -d -m 700 -o zhishi -g zhishi "$DATA"
if [[ ! -e "$DATA/plants.json" ]]; then
  cp -a "$BUNDLE/seed-data/." "$DATA/"
  chown -R zhishi:zhishi "$DATA"
fi
FILES_CHANGED=1
install_atomic 755 "$RUNTIME_SOURCE" "$BASE/runtime/node"
if [[ ! -d "$BASE/releases/$VERSION" ]]; then
  install -d -m 755 "$BASE/releases/$VERSION"
  cp -a "$BUNDLE/app/." "$BASE/releases/$VERSION/"
  chmod -R a+rX "$BASE/releases/$VERSION"
fi
cat > "$BACKUP/env.candidate" <<'ENV'
PORT=18188
BASE_PATH=/plants
PUBLIC_ORIGIN=https://f.qdfb.tech
PLANT_DATA_DIR=/var/lib/zhishi
PLANT_PHOTO_PROVIDER=inaturalist
TZ=Asia/Shanghai
ENV
install_atomic 600 "$BACKUP/env.candidate" /etc/zhishi.env
install_atomic 644 "$BUNDLE/app/deploy/zhishi.service" /etc/systemd/system/zhishi.service
ln -sfn "$BASE/releases/$VERSION" "$BASE/current.next"
APP_SWITCHED=1
mv -Tf "$BASE/current.next" "$BASE/current"
SERVICE_TOUCHED=1
systemctl daemon-reload
systemctl enable --now zhishi
systemctl restart zhishi
for attempt in {1..20}; do
  if curl --connect-timeout 2 --max-time 5 -fsS http://127.0.0.1:18188/plants/api/config > "$BACKUP/config-check.json"; then break; fi
  sleep 0.5
done
curl --connect-timeout 2 --max-time 10 -fsS http://127.0.0.1:18188/plants/api/state > "$BACKUP/state-after.json"
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
PROXY_CHANGED=1
install_atomic 644 "$BACKUP/Caddyfile.candidate" /etc/caddy/Caddyfile
systemctl reload caddy
for service in zhishi caddy tongbanji-VVox8g; do systemctl is-active --quiet "$service"; done
curl --connect-timeout 5 --max-time 20 -fsS https://f.qdfb.tech/api/health
if ! STATUS=$(curl --connect-timeout 5 --max-time 20 -sS -o /dev/null -w '%{http_code}' https://f.qdfb.tech/plants/api/state); then
  rollback 1 'public authentication check failed'
fi
[[ $STATUS == 401 ]]
systemctl is-enabled zhishi > "$BACKUP/service-enabled.after" 2>/dev/null || true
systemctl is-active zhishi > "$BACKUP/service-active.after" 2>/dev/null || true
trap - ERR INT TERM
printf '\nZHISHI_DEPLOYED %s\nBACKUP %s\n' "$VERSION" "$BACKUP"
