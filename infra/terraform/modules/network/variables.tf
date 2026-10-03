variable "name" {
  description = "Name prefix, e.g. paint-prod."
  type        = string
}

variable "cidr_block" {
  description = "VPC address range. Split into 16 subnets: public from the first, private from the ninth."
  type        = string
  default     = "10.20.0.0/16"
}

variable "az_count" {
  description = "Availability zones to use (2 or 3). RDS Multi-AZ needs at least 2."
  type        = number
  default     = 2

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "az_count must be 2 or 3."
  }
}

variable "single_nat_gateway" {
  description = "One NAT gateway for all AZs (cheaper, not AZ-redundant). Use false in production."
  type        = bool
  default     = false
}

variable "flow_logs_retention_days" {
  description = "Days to keep VPC flow logs of rejected traffic; 0 turns them off."
  type        = number
  default     = 30
}
