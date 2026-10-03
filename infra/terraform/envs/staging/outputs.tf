output "github_environment_variables" {
  value = module.stack.github_environment_variables
}

output "dns_records_to_create" {
  value = module.stack.dns_records_to_create
}

output "database_address" {
  value = module.stack.database_address
}
