variable "name" {
  description = "Name prefix, e.g. paint-prod."
  type        = string
}

variable "bucket_name" {
  description = "Globally unique bucket for the built web app."
  type        = string
}

variable "domain_names" {
  description = "Domains the app is served on, e.g. [\"app.example.in\"]."
  type        = list(string)
}

variable "certificate_arn" {
  description = "ACM certificate for var.domain_names, in us-east-1 (CloudFront requires it there)."
  type        = string
}

variable "api_origin_domain" {
  description = "The load balancer's DNS name with a valid certificate, e.g. origin.app.example.in."
  type        = string
}

variable "origin_verify_header_name" {
  type    = string
  default = "X-Origin-Verify"
}

variable "origin_verify_header_value" {
  description = "Shared secret CloudFront sends to the load balancer."
  type        = string
  sensitive   = true
}

variable "price_class" {
  description = "PriceClass_200 includes India; PriceClass_All adds South America and Oceania."
  type        = string
  default     = "PriceClass_200"
}

variable "route53_zone_id" {
  description = "Zone for var.domain_names; null to create the DNS records by hand."
  type        = string
  default     = null
}

variable "access_log_bucket_domain" {
  description = "S3 bucket domain for CloudFront access logs; null = off."
  type        = string
  default     = null
}
