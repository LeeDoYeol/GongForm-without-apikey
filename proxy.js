const https = require('https');
const http = require('http');

const PORT = 3001;

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const { origin, referer, ...forwardHeaders } = req.headers;
  const options = {
    hostname: 'openrouter.ai',
    path: req.url,
    method: req.method,
    headers: { ...forwardHeaders, host: 'openrouter.ai' },
  };

  const proxyReq = https.request(options, (proxyRes) => {
    console.log('[Proxy]', req.method, req.url, '->', proxyRes.statusCode);
    if (proxyRes.statusCode >= 400) {
      let body = '';
      proxyRes.on('data', (chunk) => body += chunk);
      proxyRes.on('end', () => {
        console.log('[Proxy] 오류 응답:', body.slice(0, 500));
        res.writeHead(proxyRes.statusCode, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
        res.end(body);
      });
      return;
    }
    res.writeHead(proxyRes.statusCode, {
      ...proxyRes.headers,
      'Access-Control-Allow-Origin': '*',
    });
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (e) => {
    res.writeHead(502);
    res.end(`Proxy error: ${e.message}`);
  });

  req.pipe(proxyReq);
});

server.listen(PORT, () => {
  console.log(`Proxy running at http://localhost:${PORT}`);
});
