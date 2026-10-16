# One complete environment (staging or prod): network, database, documents,
# email, the API with ClamAV, the web app on CloudFront, alarms, image
# repositories and the GitHub deploy role. Environments differ only in inputs.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  name       = "paint-${var.environment}"
  account_id = data.aws_caller_identity.current.account_id
  app_url    = "https://${var.app_domain}"
}

# Shared secret that proves a request to the load balancer came through CloudFront.
# It is in Terraform state (CloudFront needs the value); rotate with -replace.
resource "random_password" "origin_verify" {
  length  = 48
  special = false
}

module "network" {
  source                   = "../network"
  name                     = local.name
  cidr_block               = var.vpc_cidr
  az_count                 = var.az_count
  single_nat_gateway       = var.single_nat_gateway
  flow_logs_retention_days = var.log_retention_days
}

module "ecr" {
  source = "../ecr"
  name   = local.name
}

module "documents" {
  source                  = "../documents"
  bucket_name             = "${local.name}-documents-${local.account_id}"
  noncurrent_version_days = var.document_version_retention_days
}

module "email" {
  source          = "../email"
  name            = local.name
  domain          = var.email_domain
  route53_zone_id = var.route53_zone_id
}

# ---- TLS certificates: the load balancer's (this region) and CloudFront's (us-east-1) ----

resource "aws_acm_certificate" "origin" {
  domain_name       = var.origin_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_acm_certificate" "app" {
  provider          = aws.us_east_1
  domain_name       = var.app_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

locals {
  validation_records = var.route53_zone_id == null ? {} : {
    for option in concat(
      tolist(aws_acm_certificate.origin.domain_validation_options),
      tolist(aws_acm_certificate.app.domain_validation_options),
    ) : option.domain_name => option
  }
}

resource "aws_route53_record" "certificate_validation" {
  for_each        = local.validation_records
  zone_id         = var.route53_zone_id
  name            = each.value.resource_record_name
  type            = each.value.resource_record_type
  records         = [each.value.resource_record_value]
  ttl             = 300
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "origin" {
  count                   = var.route53_zone_id == null ? 0 : 1
  certificate_arn         = aws_acm_certificate.origin.arn
  validation_record_fqdns = [aws_route53_record.certificate_validation[var.origin_domain].fqdn]
}

resource "aws_acm_certificate_validation" "app" {
  count                   = var.route53_zone_id == null ? 0 : 1
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.app.arn
  validation_record_fqdns = [aws_route53_record.certificate_validation[var.app_domain].fqdn]
}

# ---- Database ----

module "database" {
  source                       = "../database"
  name                         = local.name
  vpc_id                       = module.network.vpc_id
  subnet_ids                   = module.network.private_subnet_ids
  client_security_group_ids    = [module.api.api_security_group_id, module.api.ops_security_group_id]
  instance_class               = var.db_instance_class
  multi_az                     = var.db_multi_az
  allocated_storage_gb         = var.db_allocated_storage_gb
  max_allocated_storage_gb     = var.db_max_allocated_storage_gb
  backup_retention_days        = var.db_backup_retention_days
  deletion_protection          = var.deletion_protection
  enhanced_monitoring_interval = var.db_enhanced_monitoring_interval
  password_version             = var.db_password_version
}

# ---- API, ClamAV, ops tasks ----

module "api" {
  source                     = "../api"
  name                       = local.name
  environment                = var.environment
  vpc_id                     = module.network.vpc_id
  public_subnet_ids          = module.network.public_subnet_ids
  private_subnet_ids         = module.network.private_subnet_ids
  certificate_arn            = var.route53_zone_id == null ? aws_acm_certificate.origin.arn : aws_acm_certificate_validation.origin[0].certificate_arn
  origin_verify_header_value = random_password.origin_verify.result
  api_repository_url         = module.ecr.repository_urls["api"]
  ops_repository_url         = module.ecr.repository_urls["ops"]
  secret_arns = {
    DATABASE_URL = module.database.database_url_secret_arn
    SMTP_URL     = module.email.smtp_url_secret_arn
  }
  documents_bucket_name      = module.documents.bucket_name
  documents_bucket_arn       = module.documents.bucket_arn
  app_url                    = local.app_url
  email_from                 = "${var.email_from_name} <${var.email_from_local_part}@${var.email_domain}>"
  signup_plan                = var.signup_plan
  subscriptions              = var.subscriptions
  payment_link_provider      = var.payment_link_provider
  sentry_dsn                 = var.sentry_dsn
  auth_secret_version        = var.auth_secret_version
  platform_bootstrap_enabled = var.platform_bootstrap_enabled
  api_cpu                    = var.api_cpu
  api_memory                 = var.api_memory
  api_min_count              = var.api_min_count
  api_max_count              = var.api_max_count
  clamav_count               = var.clamav_count
  log_retention_days         = var.log_retention_days
  deletion_protection        = var.deletion_protection
}

resource "aws_route53_record" "origin" {
  count   = var.route53_zone_id == null ? 0 : 1
  zone_id = var.route53_zone_id
  name    = var.origin_domain
  type    = "A"
  alias {
    name                   = module.api.load_balancer_dns_name
    zone_id                = module.api.load_balancer_zone_id
    evaluate_target_health = true
  }
}

# ---- Web app ----

module "web" {
  source                     = "../web"
  name                       = local.name
  bucket_name                = "${local.name}-web-${local.account_id}"
  domain_names               = [var.app_domain]
  certificate_arn            = var.route53_zone_id == null ? aws_acm_certificate.app.arn : aws_acm_certificate_validation.app[0].certificate_arn
  api_origin_domain          = var.origin_domain
  origin_verify_header_value = random_password.origin_verify.result
  price_class                = var.cloudfront_price_class
  route53_zone_id            = var.route53_zone_id
}

# ---- Alarms ----

module "monitoring" {
  source                   = "../monitoring"
  name                     = local.name
  alert_emails             = var.alert_emails
  cluster_name             = module.api.cluster_name
  api_service_name         = module.api.api_service_name
  api_log_group_name       = module.api.log_group_names["api"]
  load_balancer_arn_suffix = module.api.load_balancer_arn_suffix
  target_group_arn_suffix  = module.api.target_group_arn_suffix
  db_instance_id           = module.database.instance_id
  db_max_connections_alarm = var.db_max_connections_alarm
}

# ---- GitHub Actions deploy role ----

module "deploy_role" {
  source = "../deploy-role"
  name   = local.name
  # Default: deploy runs on main (GitHub Free has no environments for private repos).
  github_subjects     = coalescelist(var.github_oidc_subjects, ["repo:${var.github_repository}:ref:refs/heads/main"])
  ecr_repository_arns = module.ecr.repository_arns
  cluster_name        = module.api.cluster_name
  cluster_arn         = module.api.cluster_arn
  ops_task_family     = module.api.ops_task_family
  ops_log_group_name  = module.api.log_group_names["ops"]
  task_role_arns      = module.api.task_role_arns
  web_bucket_arn      = module.web.bucket_arn
  distribution_arn    = module.web.distribution_arn
}
