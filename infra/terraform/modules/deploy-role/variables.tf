variable "name" {
  type = string
}

variable "github_subjects" {
  description = <<-EOT
    OIDC token subjects allowed to assume the role. On GitHub Free (no environments in
    private repositories): ["repo:<owner>/<repo>:ref:refs/heads/main"]. With GitHub Team
    or Enterprise and protected environments: ["repo:<owner>/<repo>:environment:prod"].
  EOT
  type        = list(string)
}

variable "ecr_repository_arns" {
  type = list(string)
}

variable "cluster_name" {
  type = string
}

variable "cluster_arn" {
  type = string
}

variable "ops_task_family" {
  type = string
}

variable "ops_log_group_name" {
  type = string
}

variable "task_role_arns" {
  type = list(string)
}

variable "web_bucket_arn" {
  type = string
}

variable "distribution_arn" {
  type = string
}
