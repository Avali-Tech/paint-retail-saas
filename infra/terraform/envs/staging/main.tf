# Staging: production's shape at the smallest sizes. Single-AZ database, one NAT
# gateway, one API task. Apply with:
#   terraform init -backend-config=backend.hcl
#   terraform apply
# (see docs/runbooks/deploy.md; nothing here has been applied yet).

terraform {
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
  }

  # Bucket and key come from backend.hcl (created by infra/terraform/bootstrap).
  backend "s3" {
    region       = "ap-south-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = "ap-south-1"
  default_tags {
    tags = { Project = "paint-retail", Environment = "staging", ManagedBy = "terraform" }
  }
}

# CloudFront certificates must live in us-east-1.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
  default_tags {
    tags = { Project = "paint-retail", Environment = "staging", ManagedBy = "terraform" }
  }
}

module "stack" {
  source    = "../../modules/stack"
  providers = { aws = aws, aws.us_east_1 = aws.us_east_1 }

  environment = "staging"

  app_domain      = var.app_domain
  origin_domain   = var.origin_domain
  email_domain    = var.email_domain
  route53_zone_id = var.route53_zone_id
  alert_emails    = var.alert_emails
  sentry_dsn      = var.sentry_dsn

  vpc_cidr           = "10.20.0.0/16"
  az_count           = 2
  single_nat_gateway = true

  db_instance_class        = "db.t4g.micro"
  db_multi_az              = false
  db_allocated_storage_gb  = 20
  db_backup_retention_days = 7
  db_max_connections_alarm = 60

  api_cpu       = 512
  api_memory    = 1024
  api_min_count = 1
  api_max_count = 2
  clamav_count  = 1

  log_retention_days              = 14
  document_version_retention_days = 30
  # Staging can be torn down; production cannot.
  deletion_protection = false
  signup_plan         = "trial"

  db_password_version        = var.db_password_version
  auth_secret_version        = var.auth_secret_version
  platform_bootstrap_enabled = var.platform_bootstrap_enabled
  subscriptions              = var.subscriptions
  payment_link_provider      = var.payment_link_provider
}
