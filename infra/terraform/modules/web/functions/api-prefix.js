// CloudFront Function (viewer request, cloudfront-js-2.0) for /api/*: the browser
// calls /api/stores, the API serves /stores (the same rewrite as Vite's dev proxy).
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- CloudFront calls it
function handler(event) {
  var request = event.request;
  request.uri = request.uri.replace(/^\/api(?=\/|$)/, '') || '/';
  return request;
}
