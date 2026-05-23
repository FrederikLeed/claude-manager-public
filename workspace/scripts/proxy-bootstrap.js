// Node.js proxy bootstrap — patches https.globalAgent to tunnel through HTTP proxy
// Loaded via NODE_OPTIONS="-r ~/.proxy-bootstrap.js" in .bashrc
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
if (proxyUrl) {
  try {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    require('https').globalAgent = new HttpsProxyAgent(proxyUrl);
  } catch (_) {}
}
