#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 /absolute/path/to/existing/netwatch" >&2
  exit 2
fi

source_repo="${1%/}"
base="$HOME/.local/share/netwatch"
config_dir="$base/config"
data_dir="$base/data"

backend_env="$source_repo/backend/.env"
wireguard_conf="$source_repo/docker/wireguard/wg_confs/wg0.conf"
prowlarr_source="$source_repo/docker/prowlarr/config"

if [[ ! -f "$backend_env" ]]; then
  echo "Missing: $backend_env" >&2
  exit 1
fi
if [[ ! -f "$wireguard_conf" ]]; then
  echo "Missing: $wireguard_conf" >&2
  exit 1
fi

mkdir -p "$config_dir/wireguard/wg_confs" "$data_dir/prowlarr"
install -m 600 "$backend_env" "$config_dir/backend.env"
install -m 600 "$wireguard_conf" "$config_dir/wireguard/wg_confs/wg0.conf"

if [[ -d "$prowlarr_source" ]]; then
  cp -a "$prowlarr_source/." "$data_dir/prowlarr/"
fi

chmod 700 "$config_dir" "$config_dir/wireguard" "$config_dir/wireguard/wg_confs" "$data_dir" "$data_dir/prowlarr" || true

echo "NetWatch packaged configuration installed under:"
echo "  $base"
echo
 echo "The installer/source archive still contains no copied credentials."
