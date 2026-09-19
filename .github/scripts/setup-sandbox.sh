#!/usr/bin/env bash
# Lets the unit, integration, and browser suites run real bubblewrap sandboxes on a
# GitHub-hosted Ubuntu runner.
#
# The processing and watermark tests spawn /usr/bin/bwrap with --unshare-user, which
# needs unprivileged user namespaces. Ubuntu 24.04 blocks those through AppArmor.
set -euo pipefail

sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  bubblewrap imagemagick fonts-noto-cjk fonts-noto-mono
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
