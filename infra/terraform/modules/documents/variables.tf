variable "bucket_name" {
  description = "Globally unique bucket name, e.g. paint-prod-documents-<account id>."
  type        = string
}

variable "noncurrent_version_days" {
  description = "Days an overwritten or deleted version is kept before it expires."
  type        = number
  default     = 90
}
