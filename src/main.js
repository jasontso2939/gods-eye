import { createStandaloneApplication } from './standalone/application.js';
import { describeError } from './standalone/errors.js';
import { createVoiceProviderChoice } from './voice/providerChoice.js';

// Claude or OpenAI Realtime behind the mic button, as the server reports.
const voiceChoice = createVoiceProviderChoice();

const application = createStandaloneApplication({
  googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
  cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
  allowQaRegistration: import.meta.env.DEV,
  voice: { createSession: voiceChoice.createSession },
});

application.start().then(
  (components) => {
    // Ops console (history, alerts, replay, coverage). Loaded after the globe
    // is up so it never delays first paint; a failure leaves the app intact.
    const viewer = components?.scene?.viewer;
    if (!viewer) return;
    import('./gev/console/index.js')
      .then(({ mountOpsConsole }) => {
        const ops = mountOpsConsole({ viewer });
        if (import.meta.env.DEV) window.__gevOps = ops;
      })
      .catch((error) => console.warn('Ops console unavailable:', error));
    import('./gev/viewAngles/index.js')
      .then(({ mountViewAngleControls }) => {
        const angles = mountViewAngleControls({ viewer });
        if (import.meta.env.DEV) window.__gevAngles = angles;
      })
      .catch((error) =>
        console.warn('View angle controls unavailable:', error),
      );
  },
  (error) => {
    console.error("God's Eye View initialization failed:", error);
    const loaderStatus = document.querySelector(
      '#loading-screen .loader-status',
    );
    loaderStatus.textContent = `Error: ${describeError(error)}`;
    loaderStatus.style.color = '#ff4444';
  },
);

export { application };
