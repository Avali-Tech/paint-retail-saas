variable "name" {
  type = string
}

variable "alert_emails" {
  description = "Each address gets a confirmation email from SNS and must accept it."
  type        = list(string)
  default     = []
}

variable "cluster_name" {
  type = string
}

variable "api_service_name" {
  type = string
}

variable "api_log_group_name" {
  type = string
}

variable "load_balancer_arn_suffix" {
  type = string
}

variable "target_group_arn_suffix" {
  type = string
}

variable "db_instance_id" {
  type = string
}

variable "api_5xx_threshold" {
  description = "Server errors per 5 minutes before alerting."
  type        = number
  default     = 5
}

variable "latency_p95_seconds" {
  type    = number
  default = 2
}

variable "error_logs_threshold" {
  type    = number
  default = 10
}

variable "db_free_storage_gb" {
  type    = number
  default = 5
}

variable "db_free_memory_mb" {
  type    = number
  default = 128
}

variable "db_max_connections_alarm" {
  type    = number
  default = 60
}
