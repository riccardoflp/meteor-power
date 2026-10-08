Package.describe({
  name: 'acme:logger',
  version: '1.0.0',
});

Package.onUse((api) => {
  api.use('ecmascript');
  api.mainModule('logger.js', 'server');
});
