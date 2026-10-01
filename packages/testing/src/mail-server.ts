import { GenericContainer, Wait } from 'testcontainers';

/** Catches every email sent over SMTP and shows it through an HTTP API. */
export const MAIL_SERVER_IMAGE = 'axllent/mailpit:v1.31.3';

export interface TestMailServer {
  /** smtp:// URL to send through. */
  readonly smtpUrl: string;
  /** http:// URL of Mailpit's API, e.g. GET /api/v1/messages. */
  readonly apiUrl: string;
  stop(): Promise<void>;
}

/** Starts a throwaway mail catcher in Docker. */
export async function startTestMailServer(
  image: string = MAIL_SERVER_IMAGE,
): Promise<TestMailServer> {
  const container = await new GenericContainer(image)
    .withExposedPorts(1025, 8025)
    .withWaitStrategy(Wait.forHttp('/livez', 8025).forStatusCode(200))
    .start();
  const host = container.getHost();
  return {
    smtpUrl: `smtp://${host}:${String(container.getMappedPort(1025))}`,
    apiUrl: `http://${host}:${String(container.getMappedPort(8025))}`,
    stop: async () => {
      await container.stop();
    },
  };
}
