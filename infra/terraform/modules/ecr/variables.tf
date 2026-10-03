variable "name" {
  description = "Name prefix, e.g. paint-prod."
  type        = string
}

variable "repositories" {
  description = "Repository suffixes: api (the API image) and ops (migrations and the restore drill)."
  type        = list(string)
  default     = ["api", "ops"]
}

variable "keep_images" {
  type    = number
  default = 30
}
