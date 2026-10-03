# Backup and restore runbook

## What is backed up

| Data              | Backup                                                                            | Recovery                                                                               |
| ----------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| PostgreSQL (RDS)  | Automated daily snapshots plus transaction logs: 7 days (staging), 14 days (prod) | Point-in-time restore to any second in the window (typically up to the last 5 minutes) |
| PostgreSQL, final | A final snapshot `paint-<env>-final` if the instance is ever deleted              | Restore from snapshot                                                                  |
| Documents (S3)    | Versioning: overwritten and deleted objects are kept for 90 days                  | Restore an earlier version                                                             |
| Web app (S3)      | Versioning (30 days); every commit can be rebuilt                                 | Re-run Deploy with an earlier commit                                                   |
| Secrets           | Secrets Manager keeps deleted secrets for 7 days                                  | `aws secretsmanager restore-secret`                                                    |

Targets to agree with the business (defaults this setup supports): **RPO ≈ 5 minutes**
(point-in-time recovery), **RTO ≈ 1–2 hours** (restoring an instance takes 20–60 minutes,
depending on size).

## Point-in-time recovery (RDS PITR)

Use when data was lost or corrupted (a bad migration, a mistaken bulk change). RDS always restores
to a **new** instance; the current one keeps running until you switch.

1. **Decide the time.** Find the last good moment in UTC (audit log, Sentry, CloudWatch logs). Note
   that `aws rds describe-db-instances --db-instance-identifier paint-prod --query
'DBInstances[0].LatestRestorableTime'` is the latest possible.
2. **Stop writes if the damage is ongoing:** scale the API to zero
   (`aws ecs update-service --cluster paint-prod --service api --desired-count 0`) and post a
   status message.
3. **Restore to a new instance** with the same network and settings:
   ```sh
   aws rds restore-db-instance-to-point-in-time \
     --source-db-instance-identifier paint-prod \
     --target-db-instance-identifier paint-prod-pitr-$(date -u +%Y%m%d%H%M) \
     --restore-time 2026-10-02T08:15:00Z \
     --db-subnet-group-name paint-prod \
     --vpc-security-group-ids <sg of paint-prod-db> \
     --db-parameter-group-name paint-prod-pg17 \
     --multi-az --no-publicly-accessible --deletion-protection --copy-tags-to-snapshot
   aws rds wait db-instance-available --db-instance-identifier paint-prod-pitr-...
   ```
   The restored instance has the same master user and password as the source at that time.
4. **Check it** with the restore drill (below) pointed at the new instance, and look at the data
   you expected to get back.
5. **Choose how to recover:**
   - **Copy back only what was lost** (preferred for a small, known set of rows): read from the
     restored instance and write into production with a reviewed SQL script. Production keeps every
     change made since.
   - **Switch to the restored instance** (large or unclear damage; loses writes after the restore
     time): update the `paint-prod/database-url` secret with the new host (same user and password)
     and redeploy, or, to keep Terraform in charge, rename: delete-protect off and rename the old
     instance to `paint-prod-old` (`modify-db-instance --new-db-instance-identifier`), rename the
     restored one to `paint-prod`, then `terraform plan` must show no changes to the instance.
     Restart the API (`update-service --force-new-deployment`, desired count back).
6. Keep the old instance (stopped or with deletion protection) until the business confirms the
   data, then delete it with a final snapshot.

## Restoring a document

```sh
aws s3api list-object-versions --bucket paint-prod-documents-<account> --prefix <key>
aws s3api copy-object --bucket paint-prod-documents-<account> --key <key> \
  --copy-source "paint-prod-documents-<account>/<key>?versionId=<version>"
```

## Restore drill

The drill proves a backup can actually be restored and is still correct: it dumps a database with
`pg_dump` (one consistent snapshot), restores it into a **brand-new database** with `pg_restore`,
then compares the two: the same number of applied migrations (and the same latest one), the same
tables with the same row counts (counted inside the dump's snapshot, so they match exactly),
row-level security still on with the same policies, and the same grants to `app_tenant`. Any
difference fails the drill. The code is [packages/ops/src/restore-drill.ts](../../packages/ops/src/restore-drill.ts);
its integration test runs it against PostgreSQL 17 on every `pnpm verify`.

**Schedule:** quarterly in production, and after any change to the database setup. Record each run
(date, source, result, duration) in the operations log.

### In AWS (production)

Never point the drill at the live production instance: restore a copy first.

1. Restore production to a new instance as in steps 3 of PITR above, named
   `paint-prod-drill-<date>` (single-AZ is fine: drop `--multi-az`, use `--no-deletion-protection`).
2. Run the drill as a one-off ops task. It uses the `DATABASE_URL` secret's credentials with the
   host replaced, and creates (then drops) a `restore_drill_<timestamp>` database **on the drill
   instance**:
   ```sh
   aws ecs run-task --cluster paint-prod --launch-type FARGATE \
     --task-definition paint-prod-ops \
     --network-configuration "awsvpcConfiguration={subnets=[<private subnets>],securityGroups=[<paint-prod-ops sg>],assignPublicIp=DISABLED}" \
     --overrides '{"containerOverrides":[{"name":"ops","command":["node","src/restore-drill-cli.ts"],
       "environment":[{"name":"DRILL_SOURCE_HOST","value":"paint-prod-drill-<date>.<id>.ap-south-1.rds.amazonaws.com"}]}]}'
   ```
   (The subnets and security group are in `DEPLOY_CONFIG_PROD`: `ECS_SUBNETS`, `ECS_OPS_SECURITY_GROUP`.)
3. Read the result in CloudWatch Logs, group `/paint/prod/ops`: `RESTORE DRILL PASSED` with
   migrations, tables, rows and duration, or `RESTORE DRILL FAILED` with each problem.
4. Delete the drill instance:
   `aws rds delete-db-instance --db-instance-identifier paint-prod-drill-<date> --skip-final-snapshot`.

### Locally or against staging

```sh
# pg_dump/pg_restore 17 on PATH, or DRILL_TOOLS=docker to use the postgres:17 image
DRILL_SOURCE_URL=postgres://paint:paint@localhost:55432/paint DRILL_TOOLS=docker \
  pnpm --filter @paint/ops restore-drill
```

Add `DRILL_KEEP=true` to keep the restored database for a look around, and `DRILL_TARGET_URL` to
restore onto a different server. `--help` lists every setting.
