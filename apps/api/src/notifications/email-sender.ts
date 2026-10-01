import { createTransport, type Transporter } from 'nodemailer';

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
  close(): void;
}

/** Sends over SMTP: Amazon SES's SMTP endpoint in production, Mailpit in tests. */
export class SmtpEmailSender implements EmailSender {
  private readonly transport: Transporter;

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    this.transport = createTransport(smtpUrl);
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...message });
  }

  close(): void {
    this.transport.close();
  }
}
