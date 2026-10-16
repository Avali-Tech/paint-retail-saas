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
  description = "SaaS subscriptions (P2-M08): how they are collected (gateway: \"manual\", the default, or \"razorpay\"), trial and grace days, the platform's own GST details printed on its invoices, its bank account for manual invoices (required with \"manual\"), and, with \"razorpay\", the key id and one Razorpay plan id per paid plan and interval (e.g. standard_monthly), whose key secret and webhook secret are Secrets Manager secrets the api module creates; put their values in by hand (docs/mvp-3/subscriptions.md)."
  type = object({
    gateway           = optional(string, "manual")
    razorpay_key_id   = optional(string)
    razorpay_plan_ids = optional(map(string), {})
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
    bank = optional(object({
      name           = string
      account_name   = string
      account_number = string
      ifsc           = string
      upi_id         = optional(string)
    }))
  })
}

variable "payment_link_provider" {
  description = "PAYMENT_LINK_PROVIDER for UPI payment links (P2-M32): \"disabled\" (the default) or \"razorpay\", each business connecting its own Razorpay account in Settings. With \"razorpay\" the api module creates the GATEWAY_CREDENTIALS_KEY secret that seals businesses' keys; put its value in by hand (docs/mvp-3/payment-links.md). \"log\" is refused in production."
  type        = string
  default     = "disabled"
  validation {
    condition     = contains(["disabled", "razorpay"], var.payment_link_provider)
    error_message = "payment_link_provider must be \"disabled\" or \"razorpay\"."
  }
}
