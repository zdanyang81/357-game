'use strict';
// Build/local configuration only. Never accept an endpoint from an invitation.
// Deployment injects its own rotating preview capability; it is not a WeChat account secret.
module.exports = { apiBase: '', accessKey: '' };
