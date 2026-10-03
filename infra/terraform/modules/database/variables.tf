variable "name" {
  description = "Instance identifier and name prefix, e.g. paint-prod."
  type        = string
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  description = "Private subnets, in at least two AZs."
  type        = list(string)
}

variable "client_security_group_ids" {
  description = "Security groups allowed to connect on 5432 (API and ops tasks)."
  type        = list(string)
}

variable "engine_version" {
  description = "PostgreSQL version. A major version only (\"17\") takes the latest minor version."
  type        = string
  default     = "17"
}

variable "instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "multi_az" {
  description = "A synchronous standby in a second AZ with automatic failover. Required in production."
  type        = bool
  default     = false
}

variable "allocated_storage_gb" {
  type    = number
  default = 20
}

variable "max_allocated_storage_gb" {
  description = "Storage grows automatically up to this size."
  type        = number
  default     = 100
}

variable "backup_retention_days" {
  description = "Automated backups and point-in-time recovery window (1-35 days)."
  type        = number
  default     = 7

  validation {
    condition     = var.backup_retention_days >= 1 && var.backup_retention_days <= 35
    error_message = "backup_retention_days must be 1-35 (0 would turn backups off)."
  }
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "enhanced_monitoring_interval" {
  description = "Seconds between OS metrics (0 = off; 60 costs a little extra)."
  type        = number
  default     = 0
}

variable "database_name" {
  type    = string
  default = "paint"
}

variable "master_username" {
  type    = string
  default = "paint_admin"
}

variable "password_version" {
  description = "Increase to generate a new master password and update the DATABASE_URL secret (docs/runbooks/rotate-secrets.md)."
  type        = number
  default     = 1
}
