import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The CloudFront Functions in infra/terraform/modules/web/functions run at the edge
// (cloudfront-js-2.0). They are plain functions named `handler`; load and call them.

interface CloudFrontRequest {
  uri: string;
  method?: string;
}
type Handler = (event: { request: CloudFrontRequest }) => CloudFrontRequest;

function load(file: string): Handler {
  const source = readFileSync(
    new URL(`../../../infra/terraform/modules/web/functions/${file}`, import.meta.url),
    'utf8',
  );
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(`${source}\nreturn handler;`) as () => Handler;
  return factory();
}

const uriAfter = (handler: Handler, uri: string) => handler({ request: { uri } }).uri;

describe('spa.js (web app routes)', () => {
  const spa = load('spa.js');

  it.each(['/', '/settings/appearance', '/stores/abc-123', '/parties/'])(
    'serves index.html for the app route %s',
    (uri) => {
      expect(uriAfter(spa, uri)).toBe('/index.html');
    },
  );

  it.each(['/assets/index-3f9a.js', '/sw.js', '/manifest.webmanifest', '/icons/icon-192.png'])(
    'passes the file %s through',
    (uri) => {
      expect(uriAfter(spa, uri)).toBe(uri);
    },
  );
});

describe('api-prefix.js (/api/* to the load balancer)', () => {
  const apiPrefix = load('api-prefix.js');

  it.each([
    ['/api/stores', '/stores'],
    ['/api/health/ready', '/health/ready'],
    ['/api/', '/'],
    ['/api', '/'],
    ['/api/apis/x', '/apis/x'],
  ])('rewrites %s to %s', (uri, expected) => {
    expect(uriAfter(apiPrefix, uri)).toBe(expected);
  });

  it('leaves the rest of the request alone', () => {
    expect(apiPrefix({ request: { uri: '/api/x', method: 'POST' } })).toEqual({
      uri: '/x',
      method: 'POST',
    });
  });
});
