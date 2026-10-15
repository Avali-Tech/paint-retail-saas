variable "app_domain" {
  type = string
}

variable "origin_domain" {
  type = string
}

variable "email_domain" {
  type = string
}

variable "route53_zone_id" {
  type    = string
  default = null
}

variable "alert_emails" {
  type    = list(string)
  default = []
}

variable "sentry_dsn" {
  type    = string
  default = ""
}

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
