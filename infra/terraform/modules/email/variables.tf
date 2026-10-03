variable "name" {
  description = "Name prefix, e.g. paint-prod."
  type        = string
}

variable "domain" {
  description = "Domain emails are sent from, e.g. notify.example.in."
  type        = string
}

variable "route53_zone_id" {
  description = "Route 53 zone for var.domain; null to add the DNS records by hand."
  type        = string
  default     = null
}
