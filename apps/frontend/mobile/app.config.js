const { expo: baseExpoConfig } = require("./app.base.js");
const { resolveMobileFirebaseConfig } = require("./firebase.config");

module.exports = () => {
  const expo = JSON.parse(JSON.stringify(baseExpoConfig || {}));
  const { config: firebaseConfig } = resolveMobileFirebaseConfig({
    mobileRoot: __dirname,
    env: process.env,
    expo,
  });

  return {
    ...expo,
    android: {
      ...(expo.android || {}),
      googleServicesFile: process.env.GOOGLE_SERVICES_JSON || expo.android?.googleServicesFile,
    },
    extra: {
      ...(expo.extra || {}),
      firebase: firebaseConfig,
    },
  };
};
