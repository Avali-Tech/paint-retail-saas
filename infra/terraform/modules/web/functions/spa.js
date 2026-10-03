// CloudFront Function (viewer request, cloudfront-js-2.0) for the web app's default
// behaviour: app routes such as /settings/appearance have no file behind them, so
// they serve index.html and the React router takes over. Files (/assets/x.js,
// /sw.js, /manifest.webmanifest) pass through unchanged.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- CloudFront calls it
function handler(event) {
  var request = event.request;
  var last = request.uri.split('/').pop();
  if (last.indexOf('.') === -1) {
    request.uri = '/index.html';
  }
  return request;
}
