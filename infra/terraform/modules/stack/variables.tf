variable "environment" {
  description = "staging or prod; names everything paint-<environment>."
  type        = string

  validation {
    condition     = contains(["staging", "prod"], var.environment)
    error_message = "environment must be staging or prod."
  }
}

# ---- Domains ----

variable "app_domain" {
  description = "Where people open the app, e.g. app.example.in (CloudFront)."
  type        = string
}

variable "origin_domain" {
  description = "The load balancer's own name, used only by CloudFront, e.g. origin.app.example.in."
  type        = string
}

variable "email_domain" {
  description = "Domain notification emails come from, e.g. notify.example.in."
  type        = string
}

variable "email_from_name" {
  type    = string
  default = "Paint Retail"
}

variable "email_from_local_part" {
  type    = string
  default = "alerts"
}

variable "route53_zone_id" {
  description = "Route 53 hosted zone for the domains. null = create DNS records by hand (see outputs)."
  type        = string
  default     = null
}

# ---- GitHub ----

variable "github_repository" {
  type    = string
  default = "Avali-Tech/paint-retail-saas"
}

variable "github_oidc_subjects" {
  description = "Override who may deploy, e.g. [\"repo:<owner>/<repo>:environment:prod\"] once GitHub environments are available. Empty = runs on main."
  type        = list(string)
  default     = []
}

# ---- Sizes ----

variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}

variable "az_count" {
  type    = number
  default = 2
}

variable "single_nat_gateway" {
  type    = bool
  default = false
}

variable "db_instance_class" {
  type = string
}

variable "db_multi_az" {
  type = bool
}

variable "db_allocated_storage_gb" {
  type    = number
  default = 20
}

variable "db_max_allocated_storage_gb" {
  type    = number
  default = 100
}

variable "db_backup_retention_days" {
  type = number
}

variable "db_enhanced_monitoring_interval" {
  type    = number
  default = 0
}

variable "db_max_connections_alarm" {
  type    = number
  default = 60
}

variable "api_cpu" {
  type = number
}

variable "api_memory" {
  type = number
}

variable "api_min_count" {
  type = number
}

variable "api_max_count" {
  type = number
}

variable "clamav_count" {
  type    = number
  default = 1
}

variable "cloudfront_price_class" {
  type    = string
  default = "PriceClass_200"
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "document_version_retention_days" {
  type    = number
  default = 90
}

variable "deletion_protection" {
  type    = bool
  default = true
}

# ---- Application settings ----

variable "signup_plan" {
  type    = string
  default = "trial"
}

variable "sentry_dsn" {
  description = "API error tracking; empty = off. (The web app's DSN is the repository variable WEB_SENTRY_DSN_STAGING / WEB_SENTRY_DSN_PROD, read at build time.)"
  type        = string
  default     = ""
}

variable "alert_emails" {
  type    = list(string)
  default = []
}

# ---- Secret rotation (increase to rotate; docs/runbooks/rotate-secrets.md) ----

variable "db_password_version" {
  type    = number
  default = 1
}

variable "auth_secret_version" {
  type    = number
  default = 1
}

variable "platform_bootstrap_enabled" {
  type    = bool
  default = false
}

variable "subscriptions" {
  description = "SaaS subscriptions (P2-M08): the Razorpay key id and one Razorpay plan id per paid plan and interval (e.g. standard_monthly), trial and grace days, and the platform's own GST details printed on its invoices. The Razorpay key secret and webhook secret are Secrets Manager secrets the api module creates; put their values in by hand (docs/mvp-2/subscriptions.md)."
  type = object({
    razorpay_key_id   = string
    razorpay_plan_ids = map(string)
    trial_days        = optional(number, 14)
    grace_days        = optional(number, 7)
    platform = object({
      legal_name = string
      gstin      = string
      address    = string
      city       = string
      pincode    = string
      email      = optional(string)
    })
  })
}
