'use strict';

(function (root) {
  function formatPreview(briefing) {
    if (!briefing || !Array.isArray(briefing.projects) || briefing.projects.length === 0) {
      return { heading: 'Nothing needs your attention today.', rows: [] };
    }
    return {
      heading: `${briefing.projects.length} project${briefing.projects.length === 1 ? '' : 's'} need attention`,
      rows: briefing.projects.map((project) => ({
        name: project.name,
        reason: project.reasons.join(' · '),
        waitingOn: project.waitingOn || '',
      })),
    };
  }

  const api = { formatPreview };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WorkRadarBriefingView = api;
})(typeof window !== 'undefined' ? window : globalThis);
