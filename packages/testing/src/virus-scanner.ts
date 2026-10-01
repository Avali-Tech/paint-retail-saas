import { GenericContainer, Wait } from 'testcontainers';

/** The ClamAV build with arm64 images too; ships with a signature database. */
export const VIRUS_SCANNER_IMAGE = 'clamav/clamav-debian:1.5.4';

export interface TestVirusScanner {
  readonly host: string;
  /** clamd's TCP port. */
  readonly port: number;
  stop(): Promise<void>;
}

/** Starts ClamAV's clamd in Docker, without signature updates, for repeatable tests. */
export async function startTestVirusScanner(
  image: string = VIRUS_SCANNER_IMAGE,
): Promise<TestVirusScanner> {
  const container = await new GenericContainer(image)
    .withEnvironment({ CLAMAV_NO_FRESHCLAMD: 'true' })
    .withExposedPorts(3310)
    .withWaitStrategy(Wait.forLogMessage('socket found, clamd started'))
    .withStartupTimeout(180_000)
    .start();
  return {
    host: container.getHost(),
    port: container.getMappedPort(3310),
    stop: async () => {
      await container.stop();
    },
  };
}
