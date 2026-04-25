#!/usr/bin/env bash
#
# setup-runtime-dir.sh — one-time host setup for /run/social-manifold/.
# Idempotent: safe to re-run.
#
# Creates /run/social-manifold/ (mode 0750) owned by a `social-manifold`
# group and adds the invoking user to that group. Compose mounts this
# directory into the vault and core containers so they can publish their
# Unix-domain sockets at the canonical paths from CLAUDE.md §7.5.
#
# Run once before `docker compose up` on a fresh host (or after a reboot
# if /run is tmpfs and the directory has been wiped).

set -euo pipefail

RUNTIME_DIR="/run/social-manifold"
CHILDREN_DIR="/run/social-manifold/children"
GROUP_NAME="social-manifold"
INVOKING_USER="${SUDO_USER:-${USER:-$(id -un)}}"

require_root() {
  if [[ $EUID -ne 0 ]]; then
    echo "error: must run as root (use sudo). Re-run: sudo $0" >&2
    exit 1
  fi
}

ensure_group() {
  if getent group "$GROUP_NAME" >/dev/null 2>&1; then
    echo "group $GROUP_NAME already exists"
  else
    echo "creating group $GROUP_NAME"
    groupadd --system "$GROUP_NAME"
  fi
}

ensure_user_in_group() {
  if id -nG "$INVOKING_USER" | tr ' ' '\n' | grep -qx "$GROUP_NAME"; then
    echo "$INVOKING_USER is already a member of $GROUP_NAME"
  else
    echo "adding $INVOKING_USER to $GROUP_NAME"
    usermod -aG "$GROUP_NAME" "$INVOKING_USER"
    echo
    echo "NOTE: $INVOKING_USER's group membership won't take effect in your"
    echo "      current shell. Either log out and back in, or run:"
    echo "          newgrp $GROUP_NAME"
    echo "      before docker compose up."
  fi
}

ensure_runtime_dir() {
  if [[ -d "$RUNTIME_DIR" ]]; then
    echo "$RUNTIME_DIR already exists"
  else
    echo "creating $RUNTIME_DIR"
    install -d -o root -g "$GROUP_NAME" -m 0750 "$RUNTIME_DIR"
  fi

  # idempotent: re-apply ownership and mode every run so drift is corrected
  chown root:"$GROUP_NAME" "$RUNTIME_DIR"
  chmod 0750 "$RUNTIME_DIR"
  echo "$RUNTIME_DIR → mode 0750, owner root:$GROUP_NAME"
}

ensure_children_dir() {
  if [[ -d "$CHILDREN_DIR" ]]; then
    echo "$CHILDREN_DIR already exists"
  else
    echo "creating $CHILDREN_DIR"
    install -d -o root -g "$GROUP_NAME" -m 0750 "$CHILDREN_DIR"
  fi

  chown root:"$GROUP_NAME" "$CHILDREN_DIR"
  chmod 0750 "$CHILDREN_DIR"
  echo "$CHILDREN_DIR → mode 0750, owner root:$GROUP_NAME"
}

main() {
  require_root
  ensure_group
  ensure_user_in_group
  ensure_runtime_dir
  ensure_children_dir
  echo
  echo "done. /run is tmpfs on Linux — re-run this script after each host reboot."
}

main "$@"
