output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "cluster_arn" {
  value = aws_ecs_cluster.this.arn
}

output "api_service_name" {
  value = aws_ecs_service.api.name
}

output "clamav_service_name" {
  value = aws_ecs_service.clamav.name
}

output "api_task_family" {
  value = aws_ecs_task_definition.api.family
}

output "ops_task_family" {
  value = aws_ecs_task_definition.ops.family
}

output "api_security_group_id" {
  value = aws_security_group.api.id
}

output "ops_security_group_id" {
  value = aws_security_group.ops.id
}

output "private_subnet_ids" {
  value = var.private_subnet_ids
}

output "load_balancer_dns_name" {
  description = "Point the origin domain (e.g. origin.app.example.in) here."
  value       = aws_lb.this.dns_name
}

output "load_balancer_zone_id" {
  value = aws_lb.this.zone_id
}

output "load_balancer_arn_suffix" {
  value = aws_lb.this.arn_suffix
}

output "target_group_arn_suffix" {
  value = aws_lb_target_group.api.arn_suffix
}

output "task_role_arns" {
  description = "Roles the deploy workflow passes to ECS when it registers task definitions."
  value       = [aws_iam_role.execution.arn, aws_iam_role.api_task.arn, aws_iam_role.no_permissions.arn]
}

output "log_group_names" {
  value = { for key, group in aws_cloudwatch_log_group.this : key => group.name }
}
