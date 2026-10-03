#!/bin/sh
# tflint for every module and root (rules: .tflint.hcl). Used by CI's infra job;
# run locally with Docker:
#   docker run --rm -v "$PWD/infra/terraform:/data" -w /data --entrypoint sh ghcr.io/terraform-linters/tflint:v0.64.0 lint.sh
set -eu

tflint --version
tflint --init --config="$PWD/.tflint.hcl"
tflint --recursive --config="$PWD/.tflint.hcl" --format=compact
