'use strict';

(function (root) {
  function shouldShow(state, hasProjects, hasSession) {
    if (!state || state.status === 'complete') return false;
    // Existing installations with a saved account or local projects remain
    // usable even if an older build did not write onboarding state.
    if (state.status === 'new' && (hasProjects || hasSession)) return false;
    return true;
  }

  function title(step) {
    if (step === 'signin') return 'SIGN IN TO WORK RADAR';
    if (step === 'briefing') return 'OPTIONAL MORNING BRIEFING';
    return 'WELCOME TO WORK RADAR';
  }

  const api = { shouldShow, title };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WorkRadarOnboardingView = api;
})(typeof window !== 'undefined' ? window : globalThis);
