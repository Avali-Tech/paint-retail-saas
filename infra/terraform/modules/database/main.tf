# Amazon RDS for PostgreSQL 17: encrypted, private, automated backups with
# point-in-time recovery, deletion protection, TLS required. The master password
# never enters Terraform state: it is generated as an ephemeral value and written
# with write-only arguments to RDS and to the DATABASE_URL secret together.

ephemeral "random_password" "master" {
  length  = 40
  special = false
}

locals {
  # The API connects with TLS and verifies the server against Amazon's RDS CAs
  # (bundled in the image, NODE_EXTRA_CA_CERTS).
  database_url = format(
    "postgres://%s:%s@%s:%d/%s?sslmode=verify-full",
    var.master_username,
    ephemeral.random_password.master.result,
    aws_db_instance.this.address,
    aws_db_instance.this.port,
    var.database_name,
  )
}

resource "aws_db_subnet_group" "this" {
  name       = var.name
  subnet_ids = var.subnet_ids
}

resource "aws_security_group" "this" {
  name        = "${var.name}-db"
  description = "PostgreSQL: reachable only from the application's tasks"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "postgres" {
  for_each                     = toset(var.client_security_group_ids)
  security_group_id            = aws_security_group.this.id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "PostgreSQL from application tasks"
}

resource "aws_db_parameter_group" "this" {
  name   = "${var.name}-pg17"
  family = "postgres17"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  # Slow queries (over 1 s) appear in the PostgreSQL log in CloudWatch.
  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }
  parameter {
    name  = "log_lock_waits"
    value = "1"
  }
  # Never log statement parameters (they can carry personal data).
  parameter {
    name  = "log_parameter_max_length"
    value = "0"
  }
  parameter {
    name  = "log_parameter_max_length_on_error"
    value = "0"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_iam_role" "monitoring" {
  count = var.enhanced_monitoring_interval > 0 ? 1 : 0
  name  = "${var.name}-rds-monitoring"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "monitoring.rds.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "monitoring" {
  count      = var.enhanced_monitoring_interval > 0 ? 1 : 0
  role       = aws_iam_role.monitoring[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

resource "aws_db_instance" "this" {
  identifier     = var.name
  engine         = "postgres"
  engine_version = var.engine_version
  instance_class = var.instance_class

  db_name             = var.database_name
  username            = var.master_username
  password_wo         = ephemeral.random_password.master.result
  password_wo_version = var.password_version

  allocated_storage     = var.allocated_storage_gb
  max_allocated_storage = var.max_allocated_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true

  multi_az               = var.multi_az
  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.this.id]
  publicly_accessible    = false
  parameter_group_name   = aws_db_parameter_group.this.name
  ca_cert_identifier     = "rds-ca-rsa2048-g1"

  # Automated backups: daily snapshots plus transaction logs, so the database can
  # be restored to any second in the retention window (point-in-time recovery).
  backup_retention_period  = var.backup_retention_days
  backup_window            = "20:30-21:30" # 02:00-03:00 IST
  maintenance_window       = "sun:21:30-sun:22:30"
  copy_tags_to_snapshot    = true
  delete_automated_backups = false

  deletion_protection       = var.deletion_protection
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.name}-final"

  auto_minor_version_upgrade      = true
  allow_major_version_upgrade     = false
  apply_immediately               = false
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  # Database Insights (standard, free): top queries and waits for 7 days.
  database_insights_mode                = "standard"
  performance_insights_enabled          = true
  performance_insights_retention_period = 7
  monitoring_interval                   = var.enhanced_monitoring_interval
  monitoring_role_arn                   = var.enhanced_monitoring_interval > 0 ? aws_iam_role.monitoring[0].arn : null
}

# DATABASE_URL for the API and the ops tasks, injected by ECS from Secrets Manager.
resource "aws_secretsmanager_secret" "database_url" {
  name                    = "${var.name}/database-url"
  description             = "DATABASE_URL for the API (RDS master user, TLS verified)"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id                = aws_secretsmanager_secret.database_url.id
  secret_string_wo         = local.database_url
  secret_string_wo_version = var.password_version
}
