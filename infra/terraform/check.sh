#!/bin/sh
# Format check and validation for every Terraform root (no AWS access needed:
# backends are skipped). Used by CI's infra job; run locally with Docker:
#   docker run --rm -v "$PWD/infra/terraform:/tf" -w /tf --entrypoint sh hashicorp/terraform:1.16.4 check.sh
set -eu

terraform fmt -check -recursive -diff

for root in bootstrap envs/staging envs/prod; do
  echo "== terraform validate: $root"
  terraform -chdir="$root" init -backend=false -input=false -no-color >/dev/null
  terraform -chdir="$root" validate -no-color
done
