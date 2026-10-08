Package.describe({
  name: 'acme:audit',
  version: '1.0.0',
  summary: 'Audit log',
});

Package.onUse(function (api) {
  api.versionsFrom('3.0');
  api.use(['ecmascript', 'acme:logger@1.0.0']);
  api.mainModule('audit.js', 'server');
});
