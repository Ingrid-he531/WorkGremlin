'use strict';

const { createDemoTicker } = require('../mock/generator');

/**
 * The demo ticker starts and stops with "is the current project the demo project".
 *   - Entering the demo: first reconcile leftovers by roster criteria (purgeStragglers),
 *     then seed if needed, and finally start the progress ticker for seeded running tasks.
 *   - Leaving the demo: stop the ticker instead of idling against the demo project
 *     (members of real projects are driven by hooks / the roster).
 */
function createDemoTickerManager({ bus, repo, projectId, seeder, cleaner, getRoster }) {
  let demoTicker = null;

  function sync(on) {
    if (!on) {
      if (demoTicker) {
        demoTicker.stop();
        demoTicker = null;
      }
      return;
    }
    // Reconcile once on every demo entry: roster removal is tracked in-process only, so a
    // server restart wipes that tally — only reconciling by "the roster's own criteria" can
    // clear members left over from the previous round (see cleanup.purgeStragglers).
    cleaner.purgeStragglers(getRoster());
    if (demoTicker) return;
    seeder.ensure(projectId);
    demoTicker = createDemoTicker({ bus, repo, project: projectId, seed: 1 });
    demoTicker.start();
  }

  function stop() {
    if (demoTicker) {
      demoTicker.stop();
      demoTicker = null;
    }
  }

  return { sync, stop };
}

module.exports = { createDemoTickerManager };
