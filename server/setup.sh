#!/usr/bin/env bash
# Sets up the call bridge server on this Linux VPS, or updates it (run again from a newer copy, or
# after the VPS's IP changed). Run:  sudo bash setup.sh   (options: sudo bash setup.sh --help)
exec bash "$(dirname "${BASH_SOURCE[0]}")/deploy/linux/install.sh" "$@"
