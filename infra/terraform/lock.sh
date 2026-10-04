#!/bin/sh
# Refreshes .terraform.lock.hcl in every root with provider checksums for CI
# (linux) and developer machines (macOS). Run after changing provider versions:
#   docker run --rm -v "$PWD/infra/terraform:/tf" -w /tf --entrypoint sh hashicorp/terraform:1.16.4 lock.sh
set -eu

for root in bootstrap envs/staging envs/prod; do
  terraform -chdir="$root" init -backend=false -input=false -upgrade >/dev/null
  terraform -chdir="$root" providers lock \
    -platform=linux_amd64 -platform=linux_arm64 -platform=darwin_amd64 -platform=darwin_arm64
done
