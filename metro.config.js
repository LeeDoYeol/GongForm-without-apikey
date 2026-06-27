const { getDefaultConfig } = require('expo/metro-config');
const http = require('http');
const https = require('https');

const config = getDefaultConfig(__dirname);

config.server = {
  ...config.server,
  enhanceMiddleware: (middleware) => {
    return (req, res, next) => {
      if (req.method === 'OPTIONS' && req.url.startsWith('/openrouter-proxy/')) {
        res.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Methods': '*',
        });
        res.end();
        return;
      }

      if (req.url.startsWith('/openrouter-proxy/')) {
        const path = req.url.replace('/openrouter-proxy', '');
        const options = {
          hostname: 'openrouter.ai',
          path,
          method: req.method,
          headers: {
            ...req.headers,
            host: 'openrouter.ai',
          },
        };

        const proxyReq = https.request(options, (proxyRes) => {
          res.writeHead(proxyRes.statusCode, {
            ...proxyRes.headers,
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': '*',
            'Access-Control-Allow-Methods': '*',
          });
          proxyRes.pipe(res);
        });

        proxyReq.on('error', (e) => {
          res.writeHead(500);
          res.end(`Proxy error: ${e.message}`);
        });

        req.pipe(proxyReq);
        return;
      }

      return middleware(req, res, next);
    };
  },
};

module.exports = config;
