output "deploy_role_arn" {
  description = "The role GitHub Actions assumes (also in github_environment_variables)."
  value       = module.deploy_role.role_arn
}

output "github_environment_variables" {
  description = "Deploy settings: store `terraform output -json github_environment_variables` as the repository variable DEPLOY_CONFIG_STAGING or DEPLOY_CONFIG_PROD."
  value = {
    AWS_DEPLOY_ROLE_ARN        = module.deploy_role.role_arn
    AWS_REGION                 = data.aws_region.current.region
    ECR_API_REPOSITORY         = module.ecr.repository_urls["api"]
    ECR_OPS_REPOSITORY         = module.ecr.repository_urls["ops"]
    ECS_CLUSTER                = module.api.cluster_name
    ECS_API_SERVICE            = module.api.api_service_name
    ECS_API_TASK_FAMILY        = module.api.api_task_family
    ECS_OPS_TASK_FAMILY        = module.api.ops_task_family
    ECS_SUBNETS                = join(",", module.api.private_subnet_ids)
    ECS_OPS_SECURITY_GROUP     = module.api.ops_security_group_id
    OPS_LOG_GROUP              = module.api.log_group_names["ops"]
    WEB_BUCKET                 = module.web.bucket_name
    CLOUDFRONT_DISTRIBUTION_ID = module.web.distribution_id
    APP_URL                    = local.app_url
  }
}

output "dns_records_to_create" {
  description = "When route53_zone_id is null: records to add at your DNS provider."
  value = var.route53_zone_id != null ? null : {
    certificate_validation = [
      for option in concat(
        tolist(aws_acm_certificate.origin.domain_validation_options),
        tolist(aws_acm_certificate.app.domain_validation_options),
      ) : { name = option.resource_record_name, type = option.resource_record_type, value = option.resource_record_value }
    ]
    app    = { name = var.app_domain, type = "CNAME", value = module.web.distribution_domain_name }
    origin = { name = var.origin_domain, type = "CNAME", value = module.api.load_balancer_dns_name }
    email  = module.email.dns_records
  }
}

output "database_address" {
  value = module.database.address
}

output "alerts_topic_arn" {
  value = module.monitoring.alerts_topic_arn
}
