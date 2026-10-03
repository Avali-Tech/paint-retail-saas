output "smtp_url_secret_arn" {
  value = aws_secretsmanager_secret.smtp_url.arn
}

output "dns_records" {
  description = "Records to create when the domain is not in Route 53."
  value = concat(
    [for token in aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens : {
      name  = "${token}._domainkey.${var.domain}"
      type  = "CNAME"
      value = "${token}.dkim.amazonses.com"
    }],
    [
      { name = "mail.${var.domain}", type = "MX", value = "10 feedback-smtp.${data.aws_region.current.region}.amazonses.com" },
      { name = "mail.${var.domain}", type = "TXT", value = "v=spf1 include:amazonses.com ~all" },
      { name = "_dmarc.${var.domain}", type = "TXT", value = local.dmarc },
    ],
  )
}
