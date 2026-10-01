import { GenericContainer, Wait } from 'testcontainers';

/**
 * SeaweedFS speaks the S3 API, like Amazon S3 in production. (MinIO no longer
 * publishes container images.) It accepts any credentials.
 */
export const OBJECT_STORAGE_IMAGE = 'chrislusf/seaweedfs:4.48';

export interface TestObjectStorage {
  /** http:// URL of the S3 API. */
  readonly endpoint: string;
  stop(): Promise<void>;
}

/** Starts a throwaway S3-compatible object store in Docker. */
export async function startTestObjectStorage(
  image: string = OBJECT_STORAGE_IMAGE,
): Promise<TestObjectStorage> {
  const container = await new GenericContainer(image)
    // Each bucket needs its own volume; the default limit follows free disk
    // space and can run out on CI runners, so allow plenty of small volumes.
    .withCommand(['server', '-s3', '-dir=/data', '-volume.max=100', '-master.volumeSizeLimitMB=64'])
    .withExposedPorts(8333)
    .withWaitStrategy(Wait.forHttp('/', 8333).forStatusCode(200))
    .start();
  return {
    endpoint: `http://${container.getHost()}:${String(container.getMappedPort(8333))}`,
    stop: async () => {
      await container.stop();
    },
  };
}
