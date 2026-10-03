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
