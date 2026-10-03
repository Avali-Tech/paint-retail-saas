# Amazon SES for notification emails. The API sends over SMTP (EMAIL_PROVIDER=smtp),
# so this creates a verified domain identity with DKIM, a custom MAIL FROM domain,
# and an IAM user whose SMTP password goes into the SMTP_URL secret.
#
# New SES accounts are in the sandbox (only verified recipients); request production
# access once per account and region (docs/runbooks/deploy.md).

data "aws_region" "current" {}

locals {
  dmarc = "v=DMARC1; p=none; adkim=r; aspf=r"
}

resource "aws_sesv2_configuration_set" "this" {
  configuration_set_name = var.name

  reputation_options {
    reputation_metrics_enabled = true
  }
  suppression_options {
    suppressed_reasons = ["BOUNCE", "COMPLAINT"]
  }
}

resource "aws_sesv2_email_identity" "domain" {
  email_identity         = var.domain
  configuration_set_name = aws_sesv2_configuration_set.this.configuration_set_name

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

resource "aws_sesv2_email_identity_mail_from_attributes" "domain" {
  email_identity         = aws_sesv2_email_identity.domain.email_identity
  mail_from_domain       = "mail.${var.domain}"
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}

# DNS records, when the domain is hosted in Route 53 (otherwise add them by hand: see outputs).
resource "aws_route53_record" "dkim" {
  count   = var.route53_zone_id == null ? 0 : 3
  zone_id = var.route53_zone_id
  name    = "${aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens[count.index]}._domainkey.${var.domain}"
  type    = "CNAME"
  ttl     = 1800
  records = ["${aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}

resource "aws_route53_record" "mail_from_mx" {
  count   = var.route53_zone_id == null ? 0 : 1
  zone_id = var.route53_zone_id
  name    = "mail.${var.domain}"
  type    = "MX"
  ttl     = 1800
  records = ["10 feedback-smtp.${data.aws_region.current.region}.amazonses.com"]
}

resource "aws_route53_record" "mail_from_spf" {
  count   = var.route53_zone_id == null ? 0 : 1
  zone_id = var.route53_zone_id
  name    = "mail.${var.domain}"
  type    = "TXT"
  ttl     = 1800
  records = ["v=spf1 include:amazonses.com ~all"]
}

# DMARC: mailbox providers (Gmail, Yahoo) expect it from bulk senders. Starts in
# monitoring mode (p=none); tighten to quarantine once reports look clean.
resource "aws_route53_record" "dmarc" {
  count   = var.route53_zone_id == null ? 0 : 1
  zone_id = var.route53_zone_id
  name    = "_dmarc.${var.domain}"
  type    = "TXT"
  ttl     = 1800
  records = [local.dmarc]
}

# SMTP credentials: an IAM user that may only send as the domain.
resource "aws_iam_user" "smtp" {
  name = "${var.name}-ses-smtp"
}

resource "aws_iam_user_policy" "smtp" {
  name = "send-email"
  user = aws_iam_user.smtp.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ses:SendRawEmail", "ses:SendEmail"]
      Resource = "*"
      Condition = {
        StringLike = { "ses:FromAddress" = "*@${var.domain}" }
      }
    }]
  })
}

# Rotate by tainting this key (docs/runbooks/rotate-secrets.md). The derived SMTP
# password is in Terraform state, which is why state lives in an encrypted bucket.
resource "aws_iam_access_key" "smtp" {
  user = aws_iam_user.smtp.name
}

resource "aws_secretsmanager_secret" "smtp_url" {
  name                    = "${var.name}/smtp-url"
  description             = "SMTP_URL for notification emails (Amazon SES)"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "smtp_url" {
  secret_id = aws_secretsmanager_secret.smtp_url.id
  secret_string = format(
    "smtp://%s:%s@email-smtp.%s.amazonaws.com:587",
    urlencode(aws_iam_access_key.smtp.id),
    urlencode(aws_iam_access_key.smtp.ses_smtp_password_v4),
    data.aws_region.current.region,
  )
}
