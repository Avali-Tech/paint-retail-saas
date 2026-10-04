# Deploy runbook

## Routine deploy

1. Merge to `main`; wait for CI to pass.
2. GitHub → Actions → **Deploy** → _Run workflow_. Choose `staging` (or `prod`) and the ref
   (default `main`).
3. Production only: the workflow opens an issue "Deploy `<sha>` to production". An approver listed
   in `PROD_APPROVERS` comments `approve` (or `deny`, or closes the issue). The run waits up to an hour.
4. Watch the run. It:
   1. builds and pushes `api:<sha>` and `ops:<sha>` to ECR (skipped if they already exist; tags are
      immutable);
   2. runs migrations as a one-off ops task and prints its log. **If it fails, nothing else
      changed** — fix forward and deploy again;
   3. registers a new API task definition revision with the new image and `SENTRY_RELEASE=<sha>`,
      rolls the service (new tasks must pass the load balancer's `/health/ready` check before old
      ones stop; the container's own check is the liveness route `/health`) and waits until it
      is stable. If the new tasks keep failing, ECS's circuit breaker rolls back to the previous
      revision and the workflow fails;
   4. uploads the web build (hashed assets cached for a year, everything else `no-cache`; source
      maps are not published) and invalidates CloudFront.
5. Smoke test: open the app, sign in, open a few screens; `curl https://<app domain>/api/health/ready`.

Deploy staging first, then the same commit to production (the images are reused).

### Migrations must be backward compatible

Old API tasks keep serving while new ones start, and a rollback runs the previous image against
the migrated database. So a migration must work with the previous release: add columns as
nullable or with defaults, backfill, and only drop or rename in a later release.

## Rolling back

- **API only:** re-run **Deploy** with the previous good commit as `ref`. Images exist, so it takes
  a few minutes. Migrations are not reverted (see above).
- **Faster, from the console/CLI:** `aws ecs update-service --cluster paint-<env> --service api
--task-definition paint-<env>-api:<previous revision>`.
- **Web only:** re-run Deploy with the previous commit (the bucket is versioned too).
- **Data:** see [restore.md](restore.md).

## Approvals

The organisation is on GitHub Free. Private repositories there have no environments, required
reviewers or branch protection, so:

- both deploy roles trust workflow runs **on `main`** of this repository (OIDC subject
  `repo:Avali-Tech/paint-retail-saas:ref:refs/heads/main`);
- production waits for an issue-comment approval ([trstringer/manual-approval](https://github.com/trstringer/manual-approval)),
  and only deploys commits that are on `main`.

Anyone with write access to the repository can change the workflow, so keep write access small.
With **GitHub Team** you get environments: create `staging` and `prod`, restrict `prod` to `main`,
set `github_oidc_subjects = ["repo:Avali-Tech/paint-retail-saas:environment:prod"]` in
`envs/prod` and add `environment: ${{ inputs.environment }}` to the deploy job. Required reviewers
in private repositories need **GitHub Enterprise**; with it, replace the approval job.

## Changing configuration

Environment variables and sizes live in Terraform. After `terraform apply` changes a task
definition, run **Deploy**: it starts from the newest revision (Terraform's) and swaps in the image.

## First-time setup of an AWS account

Done once by a person with administrator access. Nothing in this repository has been applied.

1. **Account.** Use separate AWS accounts for staging and production if possible (AWS
   Organizations); otherwise one account works, since every name is prefixed `paint-<env>`.
   Turn on MFA for the root user; work as an IAM Identity Center user.
2. **Tools.** Terraform 1.11+ (or `docker run hashicorp/terraform:1.16.4`), AWS CLI v2.
3. **State bucket and GitHub OIDC provider** (once per account):
   ```sh
   cd infra/terraform/bootstrap && terraform init && terraform apply
   ```
   Keep `bootstrap/terraform.tfstate` safe (password manager or the new bucket).
4. **Domains.** Choose the app domain (`app.example.in`), the origin domain
   (`origin.app.example.in`) and the email domain (`notify.example.in`). If the zone is in
   Route 53, pass `route53_zone_id` and Terraform creates every record; otherwise apply once, then
   add the records from the `dns_records_to_create` output at your DNS provider. Certificate
   validation waits for them.
5. **Environment.** For `envs/staging` (then `envs/prod`):
   ```sh
   cp backend.hcl.example backend.hcl        # bucket from step 3
   cp terraform.tfvars.example terraform.tfvars   # domains, alert emails, optional Sentry DSN
   terraform init -backend-config=backend.hcl
   terraform plan -out=plan && terraform apply plan
   ```
   The first apply creates task definitions pointing at the image tag `initial`, which does not
   exist yet, so the API and ops tasks cannot start until the first deploy. That is expected.
   Confirm the SNS email subscriptions you receive.
6. **SES.** New accounts are in the SES sandbox (mail only to verified addresses). In the SES
   console (ap-south-1) request production access. Check the domain shows _Verified_ with DKIM.
7. **GitHub.** Repository variables (Settings → Secrets and variables → Actions → Variables):
   - `DEPLOY_CONFIG_STAGING` = `terraform -chdir=infra/terraform/envs/staging output -json github_environment_variables`
   - `DEPLOY_CONFIG_PROD` = the same for prod
   - `PROD_APPROVERS` = e.g. `alice,bob`
   - optionally `WEB_SENTRY_DSN_STAGING`, `WEB_SENTRY_DSN_PROD`
8. **First deploy** to staging (above). RDS master users are not superusers: when the first
   migration creates the `app_tenant` role, PostgreSQL 17 gives its creator only ADMIN OPTION, so
   the migration task then runs `GRANT app_tenant TO CURRENT_USER` itself and logs
   `Granted app_tenant to the database user`. If it reports `cannot SET ROLE app_tenant` instead
   (the role was created by someone else), run that grant once as a user with ADMIN OPTION on
   `app_tenant` and deploy again.
9. **First platform operator.** Set `platform_bootstrap_enabled = true`, apply, deploy, read the
   token from Secrets Manager (`paint-<env>/platform-bootstrap-token`), call
   `POST /api/platform/bootstrap`, then set it back to `false`, apply and deploy.
10. **Restore drill.** Run [the drill](restore.md#restore-drill) once on staging to prove backups work.
11. **Before go-live:** review the [incident checklist](incident.md), subscribe the on-call people
    to the alerts topic, consider AWS WAF on CloudFront, and enable AWS Backup vault lock or
    cross-region snapshot copies if your recovery objectives need them.
