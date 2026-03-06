#!/bin/bash
#
# Claude Desktop for Linux — updater
#
# Pulls the latest changes from GitHub and re-runs the installer.
# Only works with git-based installs (default: install.sh clones the repo).
#
# Usage:
#   bash ~/.local/share/claude-desktop/update.sh
#
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/share/claude-desktop}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Use SCRIPT_DIR if it looks like the real install (has install.sh)
if [[ -f "$SCRIPT_DIR/install.sh" && "$SCRIPT_DIR" != "$INSTALL_DIR" ]]; then
    INSTALL_DIR="$SCRIPT_DIR"
fi

if [[ ! -d "$INSTALL_DIR/.git" ]]; then
    echo "ERROR: $INSTALL_DIR is not a git repository."
    echo "If you installed via AUR or curl pipe without a git clone, re-run install.sh instead:"
    echo "  bash install.sh"
    exit 1
fi

echo "Pulling latest changes from GitHub..."
git -C "$INSTALL_DIR" pull -q --ff-only

echo "Re-running installer to apply updates..."
bash "$INSTALL_DIR/install.sh"

echo ""
echo "Update complete. Restart Claude Desktop to use the new version."
