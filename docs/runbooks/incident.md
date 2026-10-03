# Incident checklist

Alarms go to the SNS topic `paint-<env>-alerts` (email). Each alarm's description says what to
check first.

## 1. In the first 5 minutes

- [ ] Acknowledge in the team channel: who is handling it, what is seen, when it started.
- [ ] How bad is it? Open `https://<app domain>`; `curl https://<app domain>/api/health/ready`.
- [ ] Is it us or AWS? [AWS Health Dashboard](https://health.aws.amazon.com/health/status)
      (ap-south-1: ECS, RDS, ELB, CloudFront, SES).
- [ ] Did something just change? The last **Deploy** run, the last `terraform apply`, a migration.
      If yes, **roll back first, investigate after** ([deploy.md](deploy.md#rolling-back)).
- [ ] If customers are affected for more than a few minutes, tell them (status message, WhatsApp
      group for key dealers).

## 2. Find the cause

| Symptom                         | Look at                                                                                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 5xx from the API                | Sentry (by release = commit SHA); CloudWatch Logs `/paint/<env>/api`, search the `X-Request-Id` a user quotes                                 |
| `api-down` / unhealthy targets  | ECS service events (`aws ecs describe-services --cluster paint-<env> --services api`); stopped task reasons; `/health/ready` fails = database |
| Slow                            | `api-latency` alarm; CloudWatch Database Insights for RDS (top SQL); slow query log in `/aws/rds/instance/paint-<env>/postgresql`             |
| Database                        | RDS events (failover, storage full, maintenance); `db-*` alarms; connections                                                                  |
| Uploads fail                    | ClamAV service (`/paint/<env>/clamav`): starting (signatures take minutes) or out of memory                                                   |
| Emails not arriving             | SES sending statistics, suppression list, sandbox status; `/paint/<env>/api` for "Sending email failed"                                       |
| App will not load / old version | CloudFront distribution status, last invalidation; S3 web bucket contents                                                                     |
| 403 "Forbidden" on `/api`       | Origin verify header out of sync between CloudFront and the load balancer (after a rotation)                                                  |

Useful commands:

```sh
aws ecs describe-services --cluster paint-prod --services api --query 'services[0].events[:10]'
aws ecs list-tasks --cluster paint-prod --service-name api --desired-status STOPPED
aws logs tail /paint/prod/api --since 30m --filter-pattern '{ $.level = "error" }'
aws ecs execute-command --cluster paint-prod --task <id> --container api --interactive --command sh
aws rds describe-events --source-identifier paint-prod --source-type db-instance --duration 120
```

## 3. Mitigate

- Bad release → redeploy the previous commit or point the service at the previous task definition.
- Overloaded → raise `api_max_count` / task size (Terraform), or temporarily
  `aws ecs update-service --desired-count N`.
- Database failover (Multi-AZ) takes 1–2 minutes; the API reconnects on its own.
- Data damage → stop writes (scale the API to 0) and follow [restore.md](restore.md).
- Leaked secret → [rotate-secrets.md](rotate-secrets.md).
- Abuse / attack → block at CloudFront (geo restriction or AWS WAF rate rule).

## 4. Afterwards (within 2 working days)

- [ ] Write a short review: timeline (IST), impact (who, how long), cause, what fixed it.
- [ ] Follow-ups as issues: tests that would have caught it, alarms that were missing or noisy,
      runbook steps that were wrong.
- [ ] If personal data may have been exposed, involve the business owner: India's DPDP Act
      requires notifying the Data Protection Board and affected people of a personal data breach.
