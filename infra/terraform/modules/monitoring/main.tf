# CloudWatch alarms for the API, its load balancer and the database, sent to an SNS
# topic (email subscriptions). Each alarm's description says what to check first;
# docs/runbooks/incident.md has the full checklist.

resource "aws_sns_topic" "alerts" {
  name = "${var.name}-alerts"
}

resource "aws_sns_topic_subscription" "email" {
  for_each  = toset(var.alert_emails)
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = each.value
}

locals {
  actions = [aws_sns_topic.alerts.arn]
  lb      = { LoadBalancer = var.load_balancer_arn_suffix }
  tg      = { LoadBalancer = var.load_balancer_arn_suffix, TargetGroup = var.target_group_arn_suffix }
  api     = { ClusterName = var.cluster_name, ServiceName = var.api_service_name }
  db      = { DBInstanceIdentifier = var.db_instance_id }
}

resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "${var.name}-api-5xx"
  alarm_description   = "The API answered with server errors. Check Sentry (tagged with the route and request id) and the api log group."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  dimensions          = local.tg
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.api_5xx_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

resource "aws_cloudwatch_metric_alarm" "lb_5xx" {
  alarm_name          = "${var.name}-lb-5xx"
  alarm_description   = "The load balancer itself returned 5xx (no healthy tasks, or tasks timing out)."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_ELB_5XX_Count"
  dimensions          = local.lb
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 10
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

resource "aws_cloudwatch_metric_alarm" "unhealthy_targets" {
  alarm_name          = "${var.name}-api-unhealthy"
  alarm_description   = "API tasks fail /health/ready (usually the database). Check the api log group and RDS."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  dimensions          = local.tg
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

resource "aws_cloudwatch_metric_alarm" "no_healthy_targets" {
  alarm_name          = "${var.name}-api-down"
  alarm_description   = "No healthy API task: the app is down. Follow docs/runbooks/incident.md."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HealthyHostCount"
  dimensions          = local.tg
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

resource "aws_cloudwatch_metric_alarm" "latency" {
  alarm_name          = "${var.name}-api-latency"
  alarm_description   = "Slow API (p95). Check RDS Performance Insights and the slow query log."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  dimensions          = local.tg
  extended_statistic  = "p95"
  period              = 300
  evaluation_periods  = 2
  threshold           = var.latency_p95_seconds
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

resource "aws_cloudwatch_metric_alarm" "api_cpu" {
  alarm_name          = "${var.name}-api-cpu"
  alarm_description   = "API CPU stays high even after scaling out. Raise api_max_count or the task size."
  namespace           = "AWS/ECS"
  metric_name         = "CPUUtilization"
  dimensions          = local.api
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 85
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

resource "aws_cloudwatch_metric_alarm" "api_memory" {
  alarm_name          = "${var.name}-api-memory"
  alarm_description   = "API memory is near its limit; tasks will be killed (OOM). Check for leaks or raise api_memory."
  namespace           = "AWS/ECS"
  metric_name         = "MemoryUtilization"
  dimensions          = local.api
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 85
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

resource "aws_cloudwatch_metric_alarm" "db_cpu" {
  alarm_name          = "${var.name}-db-cpu"
  alarm_description   = "Database CPU high. Check Performance Insights for the top queries."
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  dimensions          = local.db
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

resource "aws_cloudwatch_metric_alarm" "db_storage" {
  alarm_name          = "${var.name}-db-storage"
  alarm_description   = "Less than ${var.db_free_storage_gb} GB free. Storage autoscaling may be at its maximum: raise max_allocated_storage_gb."
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  dimensions          = local.db
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.db_free_storage_gb * 1024 * 1024 * 1024
  comparison_operator = "LessThanThreshold"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

resource "aws_cloudwatch_metric_alarm" "db_memory" {
  alarm_name          = "${var.name}-db-memory"
  alarm_description   = "Database is low on memory. Consider a larger instance class."
  namespace           = "AWS/RDS"
  metric_name         = "FreeableMemory"
  dimensions          = local.db
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 3
  threshold           = var.db_free_memory_mb * 1024 * 1024
  comparison_operator = "LessThanThreshold"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

resource "aws_cloudwatch_metric_alarm" "db_connections" {
  alarm_name          = "${var.name}-db-connections"
  alarm_description   = "Many database connections: each API task opens a pool of up to 10."
  namespace           = "AWS/RDS"
  metric_name         = "DatabaseConnections"
  dimensions          = local.db
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = var.db_max_connections_alarm
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

# Unexpected errors written by the API (Nest logs them as JSON with level "error").
resource "aws_cloudwatch_log_metric_filter" "api_errors" {
  name           = "${var.name}-api-errors"
  log_group_name = var.api_log_group_name
  pattern        = "{ $.level = \"error\" || $.level = \"fatal\" }"

  metric_transformation {
    name          = "ApiErrorLogs"
    namespace     = "Paint/${var.name}"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "api_error_logs" {
  alarm_name          = "${var.name}-api-error-logs"
  alarm_description   = "The API logged errors (including background worker failures). Search the api log group for level=error."
  namespace           = "Paint/${var.name}"
  metric_name         = aws_cloudwatch_log_metric_filter.api_errors.metric_transformation[0].name
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.error_logs_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
}
