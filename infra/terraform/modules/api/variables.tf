variable "name" {
  description = "Name prefix, e.g. paint-prod."
  type        = string
}

variable "environment" {
  description = "staging or production (SENTRY_ENVIRONMENT)."
  type        = string
}

variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "certificate_arn" {
  description = "ACM certificate (in this region) for the load balancer's origin domain."
  type        = string
}

variable "origin_verify_header_name" {
  type    = string
  default = "X-Origin-Verify"
}

variable "origin_verify_header_value" {
  type      = string
  sensitive = true
}

variable "api_repository_url" {
  type = string
}

variable "ops_repository_url" {
  type = string
}

variable "image_tag" {
  description = "Image for the first task definition revisions; deploys replace it."
  type        = string
  default     = "initial"
}

variable "secret_arns" {
  description = "Secrets Manager ARNs injected as environment variables: DATABASE_URL and SMTP_URL."
  type        = map(string)

  validation {
    condition     = contains(keys(var.secret_arns), "DATABASE_URL") && contains(keys(var.secret_arns), "SMTP_URL")
    error_message = "secret_arns needs DATABASE_URL and SMTP_URL."
  }
}

variable "documents_bucket_name" {
  type = string
}

variable "documents_bucket_arn" {
  type = string
}

variable "app_url" {
  description = "The web app's address, for links in emails (APP_URL)."
  type        = string
}

variable "email_from" {
  description = "EMAIL_FROM, e.g. \"Paint Retail <alerts@notify.example.in>\"."
  type        = string
}

variable "sms_provider" {
  description = "SMS_PROVIDER: \"disabled\" until an SMS gateway is connected (\"log\" is refused in production)."
  type        = string
  default     = "disabled"
}

variable "signup_plan" {
  type    = string
  default = "trial"
}

variable "log_level" {
  type    = string
  default = "log"
}

variable "worker_interval_seconds" {
  type    = number
  default = 60
}

variable "sentry_dsn" {
  description = "SENTRY_DSN for the API; empty = error tracking off."
  type        = string
  default     = ""
}

variable "extra_environment" {
  description = "More plain environment variables for the API."
  type        = map(string)
  default     = {}
}

variable "auth_secret_version" {
  description = "Increase to generate a new AUTH_SECRET. Invalidates pending sign-in codes and the 2FA encryption key derived from it: read docs/runbooks/rotate-secrets.md first."
  type        = number
  default     = 1
}

variable "platform_bootstrap_enabled" {
  description = "Create a one-time PLATFORM_BOOTSTRAP_TOKEN secret and pass it to the API. Turn off after the first operator exists."
  type        = bool
  default     = false
}

variable "api_cpu" {
  type    = number
  default = 512
}

variable "api_memory" {
  type    = number
  default = 1024
}

variable "api_min_count" {
  type    = number
  default = 1
}

variable "api_max_count" {
  type    = number
  default = 2
}

variable "clamav_image" {
  description = "ClamAV image. Consider an ECR pull-through cache to avoid Docker Hub rate limits."
  type        = string
  default     = "clamav/clamav-debian:1.5.4"
}

variable "clamav_cpu" {
  type    = number
  default = 512
}

variable "clamav_memory" {
  description = "ClamAV holds its signatures in memory (about 1.5 GB, twice that while reloading)."
  type        = number
  default     = 3072
}

variable "clamav_count" {
  type    = number
  default = 1
}

variable "ops_ephemeral_storage_gib" {
  description = "Disk for one-off tasks; the restore drill needs room for one database dump."
  type        = number
  default     = 30
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "deletion_protection" {
  type    = bool
  default = true
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
