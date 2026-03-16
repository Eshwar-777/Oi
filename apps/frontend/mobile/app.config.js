const appJson = require("./app.json");
const { resolveMobileFirebaseConfig } = require("./firebase.config");

module.exports = () => {
  const expo = appJson.expo || {};
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
