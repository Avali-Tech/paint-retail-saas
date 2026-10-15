# The API on ECS Fargate behind an Application Load Balancer, ClamAV as an internal
# service it scans uploads with, and task definitions for one-off ops tasks
# (migrations on deploy, the restore drill). Tasks run in private subnets.
#
# Images: Terraform registers the first task definition revisions with
# var.image_tag; after that the deploy workflow registers new revisions with each
# commit's image, and the services ignore Terraform's task_definition (see lifecycle).

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

locals {
  region      = data.aws_region.current.region
  clamav_host = "clamav.${aws_service_discovery_private_dns_namespace.this.name}"
  api_secrets = merge(
    var.secret_arns,
    {
      AUTH_SECRET             = aws_secretsmanager_secret.auth_secret.arn
      RAZORPAY_KEY_SECRET     = aws_secretsmanager_secret.razorpay["key-secret"].arn
      RAZORPAY_WEBHOOK_SECRET = aws_secretsmanager_secret.razorpay["webhook-secret"].arn
    },
    var.platform_bootstrap_enabled ? { PLATFORM_BOOTSTRAP_TOKEN = aws_secretsmanager_secret.platform_bootstrap[0].arn } : {},
  )
  secret_arns = values(local.api_secrets)
  api_environment = merge(
    {
      NODE_ENV                = "production"
      HOST                    = "0.0.0.0"
      PORT                    = "3000"
      LOG_LEVEL               = var.log_level
      RUN_MIGRATIONS          = "false" # the deploy runs migrations as a one-off task first
      STORAGE_BUCKET          = var.documents_bucket_name
      STORAGE_REGION          = local.region
      CLAMAV_HOST             = local.clamav_host
      CLAMAV_PORT             = "3310"
      APP_URL                 = var.app_url
      EMAIL_PROVIDER          = "smtp"
      EMAIL_FROM              = var.email_from
      SMS_PROVIDER            = var.sms_provider
      WORKER_INTERVAL_SECONDS = tostring(var.worker_interval_seconds)
      SIGNUP_PLAN             = var.signup_plan
      SENTRY_ENVIRONMENT      = var.environment
      SENTRY_RELEASE          = var.image_tag
      PAYMENT_GATEWAY         = "razorpay"
      RAZORPAY_KEY_ID         = var.subscriptions.razorpay_key_id
      RAZORPAY_PLAN_IDS       = jsonencode(var.subscriptions.razorpay_plan_ids)
      SUBSCRIPTION_TRIAL_DAYS = tostring(var.subscriptions.trial_days)
      SUBSCRIPTION_GRACE_DAYS = tostring(var.subscriptions.grace_days)
      PLATFORM_LEGAL_NAME     = var.subscriptions.platform.legal_name
      PLATFORM_GSTIN          = var.subscriptions.platform.gstin
      PLATFORM_ADDRESS        = var.subscriptions.platform.address
      PLATFORM_CITY           = var.subscriptions.platform.city
      PLATFORM_PINCODE        = var.subscriptions.platform.pincode
    },
    var.subscriptions.platform.email == null ? {} : { PLATFORM_EMAIL = var.subscriptions.platform.email },
    var.sentry_dsn == "" ? {} : { SENTRY_DSN = var.sentry_dsn },
    var.extra_environment,
  )
  health_check = ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
}

# ---- Secrets generated here (never in state: ephemeral values, write-only) ----

ephemeral "random_password" "auth_secret" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "auth_secret" {
  name                    = "${var.name}/auth-secret"
  description             = "AUTH_SECRET: hashes sign-in codes and derives the 2FA encryption key (rotating it disables enrolled authenticators)"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "auth_secret" {
  secret_id                = aws_secretsmanager_secret.auth_secret.id
  secret_string_wo         = ephemeral.random_password.auth_secret.result
  secret_string_wo_version = var.auth_secret_version
}

ephemeral "random_password" "platform_bootstrap" {
  count   = var.platform_bootstrap_enabled ? 1 : 0
  length  = 48
  special = false
}

resource "aws_secretsmanager_secret" "platform_bootstrap" {
  count                   = var.platform_bootstrap_enabled ? 1 : 0
  name                    = "${var.name}/platform-bootstrap-token"
  description             = "One-time PLATFORM_BOOTSTRAP_TOKEN; turn off after creating the first operator"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "platform_bootstrap" {
  count                    = var.platform_bootstrap_enabled ? 1 : 0
  secret_id                = aws_secretsmanager_secret.platform_bootstrap[0].id
  secret_string_wo         = ephemeral.random_password.platform_bootstrap[0].result
  secret_string_wo_version = 1
}

# Razorpay's API key secret and webhook secret (P2-M08). Terraform creates the
# secrets but never sees their values: put them in once with
#   aws secretsmanager put-secret-value --secret-id <name>/razorpay-key-secret --secret-string ...
# The API refuses to start without them.
resource "aws_secretsmanager_secret" "razorpay" {
  for_each                = toset(["key-secret", "webhook-secret"])
  name                    = "${var.name}/razorpay-${each.value}"
  description             = "Razorpay ${each.value} for SaaS subscriptions; set by hand, never in Terraform state"
  recovery_window_in_days = 7
}

# ---- Logs ----

resource "aws_cloudwatch_log_group" "this" {
  for_each          = toset(["api", "clamav", "ops"])
  name              = "/paint/${var.name}/${each.value}"
  retention_in_days = var.log_retention_days
}

# ---- Security groups ----

resource "aws_security_group" "alb" {
  name        = "${var.name}-alb"
  description = "Load balancer: HTTPS from CloudFront only"
  vpc_id      = var.vpc_id
}

data "aws_ec2_managed_prefix_list" "cloudfront" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS from CloudFront"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_api" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.api.id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
}

resource "aws_security_group" "api" {
  name        = "${var.name}-api"
  description = "API tasks"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "api_from_alb" {
  security_group_id            = aws_security_group.api.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
}

# Outbound: PostgreSQL, ClamAV, and HTTPS/SMTP to AWS services, SES and Sentry.
resource "aws_vpc_security_group_egress_rule" "api_all" {
  security_group_id = aws_security_group.api.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_security_group" "clamav" {
  name        = "${var.name}-clamav"
  description = "ClamAV daemon: reachable only from API tasks"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "clamav_from_api" {
  security_group_id            = aws_security_group.clamav.id
  referenced_security_group_id = aws_security_group.api.id
  ip_protocol                  = "tcp"
  from_port                    = 3310
  to_port                      = 3310
}

# freshclam downloads virus signatures over HTTPS.
resource "aws_vpc_security_group_egress_rule" "clamav_all" {
  security_group_id = aws_security_group.clamav.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_security_group" "ops" {
  name        = "${var.name}-ops"
  description = "One-off ops tasks (migrations, restore drill)"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_egress_rule" "ops_all" {
  security_group_id = aws_security_group.ops.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

# ---- Load balancer ----

resource "aws_lb" "this" {
  name                       = var.name
  load_balancer_type         = "application"
  internal                   = false
  subnets                    = var.public_subnet_ids
  security_groups            = [aws_security_group.alb.id]
  drop_invalid_header_fields = true
  enable_deletion_protection = var.deletion_protection
  idle_timeout               = 60
}

resource "aws_lb_target_group" "api" {
  name                 = "${var.name}-api"
  port                 = 3000
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30

  health_check {
    path                = "/health/ready"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn

  # Anything that did not come through CloudFront is refused.
  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Forbidden"
      status_code  = "403"
    }
  }
}

resource "aws_lb_listener_rule" "from_cloudfront" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10

  condition {
    http_header {
      http_header_name = var.origin_verify_header_name
      values           = [var.origin_verify_header_value]
    }
  }

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

# ---- IAM ----

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:ecs:${local.region}:${data.aws_caller_identity.current.account_id}:*"]
    }
  }
}

# Used by ECS itself: pull images, write logs, read the secrets it injects.
resource "aws_iam_role" "execution" {
  name               = "${var.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  name = "read-secrets"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = local.secret_arns
    }]
  })
}

# Used by the API's code: documents bucket, and ECS Exec for debugging.
resource "aws_iam_role" "api_task" {
  name               = "${var.name}-api-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy" "api_task" {
  name = "documents-and-exec"
  role = aws_iam_role.api_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = "${var.documents_bucket_arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = var.documents_bucket_arn
      },
      {
        Effect = "Allow"
        Action = [
          "ssmmessages:CreateControlChannel",
          "ssmmessages:CreateDataChannel",
          "ssmmessages:OpenControlChannel",
          "ssmmessages:OpenDataChannel",
        ]
        Resource = "*"
      },
    ]
  })
}

# Ops tasks and ClamAV call no AWS APIs.
resource "aws_iam_role" "no_permissions" {
  name               = "${var.name}-task-no-permissions"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

# ---- Cluster ----

resource "aws_ecs_cluster" "this" {
  name = var.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

resource "aws_service_discovery_private_dns_namespace" "this" {
  name = "${var.name}.internal"
  vpc  = var.vpc_id
}

# ---- API ----

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.api_cpu
  memory                   = var.api_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.api_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([{
    name                   = "api"
    image                  = "${var.api_repository_url}:${var.image_tag}"
    essential              = true
    readonlyRootFilesystem = true
    stopTimeout            = 30
    portMappings           = [{ containerPort = 3000, protocol = "tcp" }]
    mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp" }]
    environment            = [for key, value in local.api_environment : { name = key, value = value }]
    secrets                = [for key, arn in local.api_secrets : { name = key, valueFrom = arn }]
    healthCheck = {
      command     = local.health_check
      interval    = 15
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.this["api"].name
        awslogs-region        = local.region
        awslogs-stream-prefix = "api"
      }
    }
  }])
}

resource "aws_ecs_service" "api" {
  name                               = "api"
  cluster                            = aws_ecs_cluster.this.id
  task_definition                    = aws_ecs_task_definition.api.arn
  desired_count                      = var.api_min_count
  launch_type                        = "FARGATE"
  enable_execute_command             = true
  health_check_grace_period_seconds  = 60
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  propagate_tags                     = "SERVICE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.api.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 3000
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  lifecycle {
    # The deploy workflow rolls out new revisions; autoscaling owns the count.
    ignore_changes = [task_definition, desired_count]
  }

  depends_on = [aws_lb_listener_rule.from_cloudfront]
}

resource "aws_appautoscaling_target" "api" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.api_min_count
  max_capacity       = var.api_max_count
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "${var.name}-api-cpu"
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  policy_type        = "TargetTrackingScaling"

  target_tracking_scaling_policy_configuration {
    target_value       = 60
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

# ---- ClamAV ----

resource "aws_service_discovery_service" "clamav" {
  name = "clamav"

  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.this.id
    routing_policy = "MULTIVALUE"
    dns_records {
      type = "A"
      ttl  = 10
    }
  }

  # ECS reports task health to Cloud Map.
  health_check_custom_config {}
}

resource "aws_ecs_task_definition" "clamav" {
  family                   = "${var.name}-clamav"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.clamav_cpu
  memory                   = var.clamav_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.no_permissions.arn

  container_definitions = jsonencode([{
    name         = "clamav"
    image        = var.clamav_image
    essential    = true
    portMappings = [{ containerPort = 3310, protocol = "tcp" }]
    healthCheck = {
      command     = ["CMD-SHELL", "clamdcheck.sh"]
      interval    = 30
      timeout     = 10
      retries     = 3
      startPeriod = 300
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.this["clamav"].name
        awslogs-region        = local.region
        awslogs-stream-prefix = "clamav"
      }
    }
  }])
}

resource "aws_ecs_service" "clamav" {
  name                               = "clamav"
  cluster                            = aws_ecs_cluster.this.id
  task_definition                    = aws_ecs_task_definition.clamav.arn
  desired_count                      = var.clamav_count
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.clamav.id]
    assign_public_ip = false
  }

  service_registries {
    registry_arn = aws_service_discovery_service.clamav.arn
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
}

# ---- Ops tasks (run by the deploy workflow and the restore drill runbook) ----

resource "aws_ecs_task_definition" "ops" {
  family                   = "${var.name}-ops"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.no_permissions.arn

  # The restore drill writes its dump here.
  ephemeral_storage {
    size_in_gib = var.ops_ephemeral_storage_gib
  }

  container_definitions = jsonencode([{
    name      = "ops"
    image     = "${var.ops_repository_url}:${var.image_tag}"
    essential = true
    # Default: migrations. The drill runbook overrides the command.
    command     = ["node", "src/migrate-cli.ts"]
    environment = [{ name = "MIGRATIONS_FOLDER", value = "migrations" }]
    secrets     = [{ name = "DATABASE_URL", valueFrom = var.secret_arns["DATABASE_URL"] }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.this["ops"].name
        awslogs-region        = local.region
        awslogs-stream-prefix = "ops"
      }
    }
  }])
}
