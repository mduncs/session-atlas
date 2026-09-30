#!/bin/bash
set -euo pipefail
umask 077

# Install and supervise the two owner-only Session Atlas LaunchAgents. The
# watchdog mode is intentionally small: it only repairs an absent index job;
# it never indexes, touches source logs, or makes provider calls.

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
home_dir="${HOME:?HOME is required}"
launch_agents_dir="$home_dir/Library/LaunchAgents"
logs_dir="$home_dir/Library/Logs"
config_path="$home_dir/.config/session-atlas/config.toml"
bun_path="$(command -v bun || true)"
wrappers_dir="$home_dir/Library/Application Support/LaunchAgent Wrappers"
index_wrapper="$wrappers_dir/Session Atlas Index"
watchdog_wrapper="$wrappers_dir/Session Atlas Watchdog"
index_template="$repo_root/examples/com.session-atlas.index.plist"
watchdog_template="$repo_root/examples/com.session-atlas.index-watchdog.plist"
index_plist="$launch_agents_dir/com.session-atlas.index.plist"
watchdog_plist="$launch_agents_dir/com.session-atlas.index-watchdog.plist"
watchdog_script_dir="$home_dir/Library/Application Support/Session Atlas"
watchdog_script="$watchdog_script_dir/ensure-launchd.sh"
user_domain="gui/$(id -u)"
index_service="$user_domain/com.session-atlas.index"
watchdog_service="$user_domain/com.session-atlas.index-watchdog"
watchdog_log="$logs_dir/session-atlas-watchdog.log"
mode="install"
temp_dir=""
render_dir=""

usage() {
  cat >&2 <<'EOF'
usage: ensure-launchd.sh [--install|--check|--watchdog|--render DIR] [--config PATH]

  --install   render, install, load, and verify both LaunchAgents
  --check     validate both installed plists and verify both services are loaded
  --watchdog  re-bootstrap the index agent if it is absent (used by launchd)
  --render    render plists and wrapper executables into DIR without installing/loading
EOF
}

while (($#)); do
  case "$1" in
    --install) mode="install" ;;
    --check) mode="check" ;;
    --watchdog) mode="watchdog" ;;
    --render)
      mode="render"
      shift
      (($#)) || { usage; exit 2; }
      render_dir="$1"
      ;;
    --config)
      shift
      (($#)) || { usage; exit 2; }
      config_path="$1"
      ;;
    -h|--help) usage 2>&1; exit 0 ;;
    *) printf 'ensure-launchd.sh: unknown argument: %s\n' "$1" >&2; usage; exit 2 ;;
  esac
  shift
done

if [[ "$mode" != "render" && "$(uname -s)" != "Darwin" ]]; then
  printf '%s\n' 'ensure-launchd.sh: macOS launchd is required' >&2
  exit 2
fi

escape_sed() {
  printf '%s' "$1" | sed 's/[&|\\]/\\&/g'
}

render_plist() {
  local template="$1" target="$2"
  local repo_value config_path_value logs_value watchdog_value index_wrapper_value watchdog_wrapper_value
  repo_value="$(escape_sed "$repo_root")"
  config_path_value="$(escape_sed "$config_path")"
  logs_value="$(escape_sed "$logs_dir")"
  watchdog_value="$(escape_sed "$watchdog_script")"
  index_wrapper_value="$(escape_sed "$index_wrapper")"
  watchdog_wrapper_value="$(escape_sed "$watchdog_wrapper")"
  sed \
    -e "s|REPLACE_ME_ABSOLUTE_REPO_PATH|$repo_value|g" \
    -e "s|REPLACE_ME_ABSOLUTE_CONFIG_PATH|$config_path_value|g" \
    -e "s|REPLACE_ME_ABSOLUTE_LOG_PATH|$logs_value|g" \
    -e "s|REPLACE_ME_ABSOLUTE_WATCHDOG_SCRIPT_PATH|$watchdog_value|g" \
    -e "s|REPLACE_ME_ABSOLUTE_INDEX_WRAPPER_PATH|$index_wrapper_value|g" \
    -e "s|REPLACE_ME_ABSOLUTE_WATCHDOG_WRAPPER_PATH|$watchdog_wrapper_value|g" \
    "$template" > "$target"
  chmod 600 "$target"
  if command -v plutil >/dev/null 2>&1; then plutil -lint "$target" >/dev/null; fi
}

shell_single_quote() {
  local value="$1" escaped
  escaped="$(printf '%s' "$value" | sed "s/'/'\\\\''/g")"
  printf "'%s'" "$escaped"
}

render_index_wrapper() {
  local target="$1" quoted_bun
  quoted_bun="$(shell_single_quote "$bun_path")"
  printf '#!/bin/sh\nexec %s "$@"\n' "$quoted_bun" > "$target"
  chmod 755 "$target"
}

render_watchdog_wrapper() {
  local target="$1"
  printf '%s\n' '#!/bin/sh' 'exec /bin/bash "$@"' > "$target"
  chmod 755 "$target"
}

plist_arg() {
  local plist="$1" index="$2"
  /usr/libexec/PlistBuddy -c "Print :ProgramArguments:$index" "$plist" 2>/dev/null
}

assert_plist_arg() {
  local plist="$1" index="$2" expected="$3" actual
  actual="$(plist_arg "$plist" "$index")" || {
    printf 'ensure-launchd.sh: missing ProgramArguments[%s] in %s\n' "$index" "$plist" >&2
    return 1
  }
  [[ "$actual" == "$expected" ]] || {
    printf 'ensure-launchd.sh: ProgramArguments[%s] drift in %s: expected %s, found %s\n' "$index" "$plist" "$expected" "$actual" >&2
    return 1
  }
}

assert_no_plist_arg() {
  local plist="$1" index="$2"
  if plist_arg "$plist" "$index" >/dev/null 2>&1; then
    printf 'ensure-launchd.sh: unexpected ProgramArguments[%s] in %s\n' "$index" "$plist" >&2
    return 1
  fi
}

assert_index_plist_semantics() {
  local plist="$1"
  [[ -x /usr/libexec/PlistBuddy ]] || return 0
  assert_plist_arg "$plist" 0 "$index_wrapper" || return 1
  assert_plist_arg "$plist" 1 "run" || return 1
  assert_plist_arg "$plist" 2 "$repo_root/src/cli.ts" || return 1
  assert_plist_arg "$plist" 3 "index" || return 1
  assert_plist_arg "$plist" 4 "--scheduled" || return 1
  assert_plist_arg "$plist" 5 "--config" || return 1
  assert_plist_arg "$plist" 6 "$config_path" || return 1
  assert_no_plist_arg "$plist" 7 || return 1
}

assert_watchdog_plist_semantics() {
  local plist="$1"
  [[ -x /usr/libexec/PlistBuddy ]] || return 0
  assert_plist_arg "$plist" 0 "$watchdog_wrapper" || return 1
  assert_plist_arg "$plist" 1 "$watchdog_script" || return 1
  assert_plist_arg "$plist" 2 "--watchdog" || return 1
  assert_plist_arg "$plist" 3 "--config" || return 1
  assert_plist_arg "$plist" 4 "$config_path" || return 1
  assert_no_plist_arg "$plist" 5 || return 1
}

assert_plist_semantics() {
  assert_index_plist_semantics "$1" || return 1
  assert_watchdog_plist_semantics "$2" || return 1
}

render_assets() {
  local destination="$1"
  mkdir -p "$destination"
  render_index_wrapper "$destination/Session Atlas Index"
  render_watchdog_wrapper "$destination/Session Atlas Watchdog"
  render_plist "$index_template" "$destination/com.session-atlas.index.plist"
  render_plist "$watchdog_template" "$destination/com.session-atlas.index-watchdog.plist"
  assert_plist_semantics "$destination/com.session-atlas.index.plist" "$destination/com.session-atlas.index-watchdog.plist"
}

require_bun() {
  [[ -n "$bun_path" && -x "$bun_path" ]] || {
    printf '%s\n' 'ensure-launchd.sh: could not find executable bun on PATH' >&2
    return 2
  }
}

assert_watchdog_index_contract() {
  local plist="$1" cli_path
  [[ -x /usr/libexec/PlistBuddy ]] || return 0
  assert_plist_arg "$plist" 0 "$index_wrapper" || return 1
  assert_plist_arg "$plist" 1 "run" || return 1
  cli_path="$(plist_arg "$plist" 2)" || return 1
  [[ "$cli_path" == /*/src/cli.ts ]] || {
    printf 'ensure-launchd.sh: watchdog refused unexpected index CLI path: %s\n' "$cli_path" >&2
    return 1
  }
  assert_plist_arg "$plist" 3 "index" || return 1
  assert_plist_arg "$plist" 4 "--scheduled" || return 1
  assert_plist_arg "$plist" 5 "--config" || return 1
  assert_plist_arg "$plist" 6 "$config_path" || return 1
  assert_no_plist_arg "$plist" 7 || return 1
  [[ -x "$index_wrapper" ]] || {
    printf 'ensure-launchd.sh: index wrapper missing or not executable: %s\n' "$index_wrapper" >&2
    return 1
  }
}

service_loaded() {
  launchctl print "$1" >/dev/null 2>&1
}

wait_for_service_absent() {
  local service="$1"
  local attempt
  for attempt in {1..50}; do
    service_loaded "$service" || return 0
    sleep 0.1
  done
  printf 'ensure-launchd.sh: service did not unload: %s\n' "$service" >&2
  return 1
}

bootout_service() {
  local service="$1"
  service_loaded "$service" || return 0
  if ! launchctl bootout "$service" >/dev/null 2>&1; then
    service_loaded "$service" || return 0
    printf 'ensure-launchd.sh: could not unload %s\n' "$service" >&2
    return 1
  fi
  wait_for_service_absent "$service"
}

bootstrap_service() {
  local service="$1" plist="$2" output rc
  service_loaded "$service" && return 0
  if output="$(launchctl bootstrap "$user_domain" "$plist" 2>&1)"; then
    rc=0
  else
    rc=$?
  fi
  # launchctl can report a transient bootstrap error after the service has
  # appeared. Treat the service domain as the source of truth in that race.
  if ((rc != 0)) && ! service_loaded "$service"; then
    printf '%s\n' "$output" >&2
    printf 'ensure-launchd.sh: could not load %s\n' "$service" >&2
    return "$rc"
  fi
  if ! service_loaded "$service"; then
    printf 'ensure-launchd.sh: bootstrap returned success but %s is absent\n' "$service" >&2
    return 1
  fi
}

append_watchdog_log() {
  mkdir -p "$logs_dir"
  printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$1" >> "$watchdog_log"
}

watchdog() {
  [[ -f "$index_plist" ]] || {
    append_watchdog_log "index plist missing: $index_plist"
    return 1
  }
  if ! assert_watchdog_index_contract "$index_plist" >> "$watchdog_log" 2>&1; then
    append_watchdog_log "index plist/wrapper semantic contract failed; refusing bootstrap"
    return 1
  fi
  if service_loaded "$index_service"; then
    exit 0
  fi
  append_watchdog_log "index service absent; bootstrapping $index_plist"
  if launchctl bootstrap "$user_domain" "$index_plist" >> "$watchdog_log" 2>&1; then
    service_loaded "$index_service" || {
      append_watchdog_log "bootstrap returned success but index service is still absent"
      return 1
    }
    append_watchdog_log "index service restored"
    exit 0
  fi
  if service_loaded "$index_service"; then
    append_watchdog_log "index service appeared during bootstrap race"
    exit 0
  fi
  append_watchdog_log "index service bootstrap failed"
  return 1
}

check() {
  [[ -f "$index_plist" ]] || { printf '[DOWN] missing %s\n' "$index_plist"; return 1; }
  [[ -f "$watchdog_plist" ]] || { printf '[DOWN] missing %s\n' "$watchdog_plist"; return 1; }
  plutil -lint "$index_plist"
  plutil -lint "$watchdog_plist"
  local healthy=0
  if ! assert_plist_semantics "$index_plist" "$watchdog_plist"; then
    printf '[DOWN] installed plist ProgramArguments violate the wrapper contract\n'
    healthy=1
  fi
  if [[ ! -x "$index_wrapper" || ! -x "$watchdog_wrapper" ]]; then
    printf '[DOWN] launchd wrapper executable missing\n'
    healthy=1
  else
    require_bun || return $?
    temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/session-atlas-launchd-check.XXXXXX")"
    trap 'if [[ -n "$temp_dir" ]]; then rm -rf -- "$temp_dir"; fi' EXIT
    render_index_wrapper "$temp_dir/Session Atlas Index"
    render_watchdog_wrapper "$temp_dir/Session Atlas Watchdog"
    if ! cmp -s "$temp_dir/Session Atlas Index" "$index_wrapper"; then
      printf '[DOWN] index wrapper content differs from rendered contract\n'
      healthy=1
    fi
    if ! cmp -s "$temp_dir/Session Atlas Watchdog" "$watchdog_wrapper"; then
      printf '[DOWN] watchdog wrapper content differs from rendered contract\n'
      healthy=1
    fi
  fi
  if service_loaded "$index_service"; then printf '[ok] %s loaded\n' "$index_service"; else printf '[DOWN] %s not loaded\n' "$index_service"; healthy=1; fi
  if service_loaded "$watchdog_service"; then printf '[ok] %s loaded\n' "$watchdog_service"; else printf '[DOWN] %s not loaded\n' "$watchdog_service"; healthy=1; fi
  return "$healthy"
}

install_agents() {
  require_bun || return $?
  [[ -f "$index_template" ]] || { printf 'missing template: %s\n' "$index_template" >&2; return 2; }
  [[ -f "$watchdog_template" ]] || { printf 'missing template: %s\n' "$watchdog_template" >&2; return 2; }
  mkdir -p "$launch_agents_dir" "$logs_dir" "$watchdog_script_dir" "$wrappers_dir"
  temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/session-atlas-launchd.XXXXXX")"
  trap 'if [[ -n "$temp_dir" ]]; then rm -rf -- "$temp_dir"; fi' EXIT
  render_assets "$temp_dir"

  local rendered_index_plist="$temp_dir/com.session-atlas.index.plist"
  local rendered_watchdog_plist="$temp_dir/com.session-atlas.index-watchdog.plist"
  local rendered_index_wrapper="$temp_dir/Session Atlas Index"
  local rendered_watchdog_wrapper="$temp_dir/Session Atlas Watchdog"
  local replace_index=1 replace_watchdog=1 replace_index_wrapper=1 replace_watchdog_wrapper=1 replace_watchdog_script=1
  local index_definition_changed=0 watchdog_definition_changed=0
  [[ -f "$index_plist" ]] && cmp -s "$rendered_index_plist" "$index_plist" && replace_index=0
  [[ -f "$watchdog_plist" ]] && cmp -s "$rendered_watchdog_plist" "$watchdog_plist" && replace_watchdog=0
  [[ -x "$index_wrapper" ]] && cmp -s "$rendered_index_wrapper" "$index_wrapper" && replace_index_wrapper=0
  [[ -x "$watchdog_wrapper" ]] && cmp -s "$rendered_watchdog_wrapper" "$watchdog_wrapper" && replace_watchdog_wrapper=0
  [[ -x "$watchdog_script" ]] && cmp -s "$script_dir/ensure-launchd.sh" "$watchdog_script" && replace_watchdog_script=0

  ((replace_index || replace_index_wrapper)) && index_definition_changed=1
  ((replace_watchdog || replace_watchdog_wrapper || replace_watchdog_script)) && watchdog_definition_changed=1

  # Wrapper/helper content is part of the executable service definition. The
  # watchdog must stop before any index definition change so it cannot restore
  # the index job between its plist and wrapper writes.
  if ((watchdog_definition_changed || index_definition_changed)); then
    bootout_service "$watchdog_service"
  fi
  if ((index_definition_changed)); then
    bootout_service "$index_service"
  fi

  ((replace_watchdog_script)) && install -m 755 "$script_dir/ensure-launchd.sh" "$watchdog_script"
  ((replace_watchdog_wrapper)) && install -m 755 "$rendered_watchdog_wrapper" "$watchdog_wrapper"
  ((replace_index_wrapper)) && install -m 755 "$rendered_index_wrapper" "$index_wrapper"
  ((replace_watchdog)) && install -m 600 "$rendered_watchdog_plist" "$watchdog_plist"
  ((replace_index)) && install -m 600 "$rendered_index_plist" "$index_plist"

  assert_plist_semantics "$index_plist" "$watchdog_plist"
  [[ -x "$index_wrapper" && -x "$watchdog_wrapper" && -x "$watchdog_script" ]]
  cmp -s "$rendered_index_wrapper" "$index_wrapper"
  cmp -s "$rendered_watchdog_wrapper" "$watchdog_wrapper"
  bootstrap_service "$index_service" "$index_plist"
  bootstrap_service "$watchdog_service" "$watchdog_plist"
  launchctl print "$index_service" >/dev/null
  launchctl print "$watchdog_service" >/dev/null
  printf 'installed and verified: %s\n' "$index_service"
  printf 'installed and verified: %s\n' "$watchdog_service"
}

render_only() {
  require_bun || return $?
  [[ -f "$index_template" ]] || { printf 'missing template: %s\n' "$index_template" >&2; return 2; }
  [[ -f "$watchdog_template" ]] || { printf 'missing template: %s\n' "$watchdog_template" >&2; return 2; }
  [[ "$render_dir" == /* ]] || {
    printf 'ensure-launchd.sh: --render DIR must be absolute: %s\n' "$render_dir" >&2
    return 2
  }
  render_assets "$render_dir"
  printf 'rendered without installation: %s\n' "$render_dir"
  shasum -a 256 \
    "$render_dir/com.session-atlas.index.plist" \
    "$render_dir/com.session-atlas.index-watchdog.plist" \
    "$render_dir/Session Atlas Index" \
    "$render_dir/Session Atlas Watchdog"
}

case "$mode" in
  check) check ;;
  watchdog) watchdog ;;
  install) install_agents ;;
  render) render_only ;;
esac
